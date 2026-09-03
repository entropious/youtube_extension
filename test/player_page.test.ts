import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as sinon from 'sinon';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { handlePlayerPage } from '../src/ytproxy';

/** Renders the page the media server serves, without going through HTTP. */
function playerHtml(videoId: string, startTime: number, autoplay: boolean): string {
    let html = '';
    const res: any = {
        writeHead: () => res,
        setHeader: () => undefined,
        end: (chunk: string) => { html = chunk; }
    };
    handlePlayerPage(res, videoId, startTime, autoplay);
    return html;
}

describe('Player page', () => {
    let dom: JSDOM;
    let window: any;
    let document: Document;
    let sent: any[];
    let fetchStub: sinon.SinonStub;

    /** Loads the page with a stubbed /info and a <video> jsdom can pretend to play. */
    function loadPage(options: { duration?: number; startTime?: number; autoplay?: boolean; infoFails?: string } = {}) {
        const html = playerHtml('kJQP7kiw5Fk', options.startTime ?? 0, options.autoplay ?? true);

        dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://127.0.0.1:8799/embed?v=kJQP7kiw5Fk' });
        window = dom.window;
        document = window.document;

        sent = [];
        // The page talks to the panel around it; here that is just a recorder.
        window.parent = { postMessage: (data: any) => sent.push(data) };

        fetchStub = sinon.stub().callsFake(() => Promise.resolve({
            ok: !options.infoFails,
            json: () => Promise.resolve(options.infoFails
                ? { error: options.infoFails }
                : { duration: options.duration ?? 282, title: 'Despacito' })
        }));
        window.fetch = fetchStub;

        // jsdom has no media stack: playback is emulated well enough to observe
        // what the page does with it.
        const video: any = document.getElementById('v');
        video.play = function () { this.paused = false; this.dispatchEvent(new window.Event('playing')); return Promise.resolve(); };
        video.pause = function () { this.paused = true; this.dispatchEvent(new window.Event('pause')); };
        video.load = function () { /* the source is re-read; nothing to emulate */ };
        Object.defineProperty(video, 'paused', { value: true, writable: true, configurable: true });
        Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });

        const script = document.querySelector('script:not([src])')!.textContent!;
        window.eval(script);
        return video;
    }

    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    const typesSent = (type: string) => sent.filter(m => m?.type === type);
    const eventsSent = (event: string) => sent.filter(m => m?.event === event);

    afterEach(() => {
        sinon.restore();
        // The page keeps a heartbeat running; without closing the window it
        // would hold the test process open.
        dom?.window?.close();
    });

    describe('loading a video', () => {
        it('asks the server for the video it was opened with', async () => {
            loadPage();
            await settle();

            expect(fetchStub.firstCall.args[0]).to.equal('/info?v=kJQP7kiw5Fk');
        });

        it('points the element at the media endpoint and announces itself', async () => {
            const video = loadPage();
            await settle();

            expect(video.getAttribute('src')).to.equal('/media?v=kJQP7kiw5Fk');
            expect(typesSent('playerReady').pop()).to.deep.equal({ type: 'playerReady', videoId: 'kJQP7kiw5Fk' });
        });

        it('starts at the requested offset', async () => {
            const video = loadPage({ startTime: 90 });
            await settle();

            expect(video.getAttribute('src')).to.equal('/media?v=kJQP7kiw5Fk&t=90');
        });

        it('shows the duration the server reported, which the stream itself lacks', async () => {
            loadPage({ duration: 282 });
            await settle();

            expect(document.getElementById('time')!.textContent).to.equal('0:00 / 4:42');
        });

        it('marks a stream of unknown length as live', async () => {
            loadPage({ duration: 0 });
            await settle();

            expect(document.getElementById('time')!.textContent).to.contain('LIVE');
            expect((document.getElementById('seek') as HTMLInputElement).disabled).to.equal(true);
        });

        it('shows why a video could not be loaded, and stays silent about progress', async () => {
            loadPage({ infoFails: 'YouTube refused this video to an anonymous session.' });
            await settle();

            expect(document.getElementById('msg')!.textContent).to.contain('anonymous session');
            expect(document.getElementById('spin')!.style.display).to.equal('none');
            expect(eventsSent('timeUpdate')).to.be.empty;
        });
    });

    describe('the panel protocol', () => {
        it('reports progress as the position inside the video', async () => {
            const video = loadPage();
            await settle();
            video.currentTime = 5;

            await new Promise(resolve => setTimeout(resolve, 1100));

            const update = eventsSent('timeUpdate').pop();
            expect(update.time).to.equal(5);
            expect(update.videoId).to.equal('kJQP7kiw5Fk');
        });

        it('counts the seek offset into the reported position', async () => {
            const video = loadPage({ startTime: 100 });
            await settle();
            video.currentTime = 7;

            await new Promise(resolve => setTimeout(resolve, 1100));

            expect(eventsSent('timeUpdate').pop().time).to.equal(107);
        });

        it('reports playing and paused the way the panel expects', async () => {
            const video = loadPage();
            await settle();

            video.play();
            video.pause();

            const states = eventsSent('infoDelivery').map(m => m.info.playerState);
            expect(states).to.include(1);
            expect(states).to.include(2);
        });

        it('obeys play and pause commands from the panel', async () => {
            const video = loadPage();
            await settle();

            window.dispatchEvent(new window.MessageEvent('message', { data: { event: 'command', func: 'pauseVideo' } }));
            expect(video.paused).to.equal(true);

            window.dispatchEvent(new window.MessageEvent('message', { data: { event: 'command', func: 'playVideo' } }));
            expect(video.paused).to.equal(false);
        });

        it('loads another video on request, dropping the previous stream first', async () => {
            const video = loadPage();
            await settle();

            window.dispatchEvent(new window.MessageEvent('message', {
                data: { type: 'load', id: 'M7lc1UVf-VE', startTime: 0, autoplay: true }
            }));
            await settle();

            expect(fetchStub.lastCall.args[0]).to.equal('/info?v=M7lc1UVf-VE');
            expect(video.getAttribute('src')).to.equal('/media?v=M7lc1UVf-VE');
        });

        it('tells the panel when playback was toggled inside the frame', async () => {
            const video = loadPage();
            await settle();

            video.dispatchEvent(new window.MouseEvent('click'));

            const toggle = typesSent('userToggle').pop();
            expect(toggle).to.deep.equal({ type: 'userToggle', playing: false });
        });

        it('reports the height of its control bar, which the panel stacks on', async () => {
            loadPage();
            await settle();

            expect(typesSent('barHeight').length).to.be.greaterThan(0);
            expect(typesSent('barHeight')[0]).to.have.property('height');
        });
    });

    describe('seeking', () => {
        it('restarts the stream at the new position, since the stream cannot seek', async () => {
            const video = loadPage({ duration: 200 });
            await settle();

            const seek = document.getElementById('seek') as HTMLInputElement;
            seek.value = '500';
            seek.dispatchEvent(new window.Event('change'));

            expect(video.getAttribute('src')).to.equal('/media?v=kJQP7kiw5Fk&t=100');
        });

        it('does not run past the end of the video', async () => {
            const video = loadPage({ duration: 200 });
            await settle();

            const seek = document.getElementById('seek') as HTMLInputElement;
            seek.value = '1000';
            seek.dispatchEvent(new window.Event('change'));

            expect(video.getAttribute('src')).to.equal('/media?v=kJQP7kiw5Fk&t=199');
        });

        it('keeps playing after a seek if it was playing before', async () => {
            const video = loadPage({ duration: 200 });
            await settle();
            video.play();

            const seek = document.getElementById('seek') as HTMLInputElement;
            seek.value = '250';
            seek.dispatchEvent(new window.Event('change'));

            expect(video.paused).to.equal(false);
        });
    });

    describe('the control bar', () => {
        it('hides the spinner once the first frames arrive, even on a paused video', async () => {
            const video = loadPage({ autoplay: false });
            await settle();

            video.dispatchEvent(new window.Event('loadeddata'));

            expect(document.getElementById('spin')!.style.display).to.equal('none');
        });

        it('stays up while playback is paused', async () => {
            const video = loadPage();
            await settle();

            video.pause();

            expect(document.getElementById('bar')!.classList.contains('shown')).to.equal(true);
        });

        it('tells the panel when the pointer reaches the bottom, and only on a change', async () => {
            loadPage();
            await settle();
            const stage = document.getElementById('stage')!;

            const move = (y: number) => stage.dispatchEvent(new window.MouseEvent('pointermove', { clientY: y, bubbles: true }));
            Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });

            move(50);
            move(60);
            move(390);
            move(395);

            expect(typesSent('pointerZone').map(m => m.bottom)).to.deep.equal([true]);
        });
    });

    describe('the media server behind it', () => {
        it('serves the page whether or not the tools are present', () => {
            const spawn = sinon.stub(childProcess, 'spawn').callsFake(() => {
                const proc: any = new EventEmitter();
                proc.stdout = Readable.from([]);
                proc.stderr = Readable.from([]);
                setImmediate(() => proc.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' })));
                return proc;
            });

            const html = playerHtml('kJQP7kiw5Fk', 0, true);

            // The setup screen lives in the panel; the frame stays a player.
            expect(html).to.contain('<video');
            expect(spawn.called).to.equal(false);
        });
    });
});
