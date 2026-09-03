import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';

/**
 * The panel side of Claude sync and of the setup screen: both live in the
 * webview script, driven by messages from the extension.
 */
describe('Panel: Claude sync and setup screen', () => {
    let dom: JSDOM;
    let window: any;
    let document: Document;
    let toExtension: sinon.SinonStub;
    let toFrame: sinon.SinonStub;
    let fetchStub: sinon.SinonStub;

    function load(options: { proxyPort?: number; tools?: any } = {}) {
        const html = fs.readFileSync(path.join(process.cwd(), 'src/webview/index.html'), 'utf8')
            .replace('%%STYLE%%', '')
            .replace('%%SCRIPT%%', '')
            .replace('%%CSP%%', '')
            .replace('%%EMPTY_STATE_STYLE%%', '')
            .replace('%%INITIAL_URL%%', 'about:blank');

        const script = fs.readFileSync(path.join(process.cwd(), 'src/webview/script.js'), 'utf8')
            .replace('%%INITIAL_URL_JSON%%', JSON.stringify('http://127.0.0.1:8799/embed?v=kJQP7kiw5Fk'))
            .replace('%%INITIAL_ORIGINAL_URL_JSON%%', JSON.stringify('https://www.youtube.com/watch?v=kJQP7kiw5Fk'))
            .replace('%%PROXY_PORT_JSON%%', String(options.proxyPort ?? 8799))
            .replace('%%AUTOPLAY_JSON%%', 'true')
            .replace('%%INITIAL_PLAYLIST_ID_JSON%%', 'null')
            .replace('%%INITIAL_PLAYLIST_TITLE_JSON%%', 'null')
            .replace('%%INITIAL_CAN_PREV_JSON%%', 'false')
            .replace('%%INITIAL_CHANNEL_URL_JSON%%', 'null')
            .replace('%%INITIAL_CHANNEL_NAME_JSON%%', 'null');

        dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' });
        window = dom.window;
        document = window.document;

        toExtension = sinon.stub();
        window.acquireVsCodeApi = () => ({ postMessage: toExtension, getState: () => ({}), setState: sinon.stub() });

        // The player lives in an iframe; here only the messages sent to it matter.
        toFrame = sinon.stub();
        Object.defineProperty(document.getElementById('video-frame')!, 'contentWindow', {
            // close() is here because jsdom closes every frame with the window.
            value: { postMessage: toFrame, close: () => undefined },
            configurable: true
        });

        fetchStub = sinon.stub().resolves({
            ok: true,
            json: () => Promise.resolve(options.tools ?? {
                ytDlp: { command: 'yt-dlp', installed: true, version: '2026.08.19' },
                ffmpeg: { command: 'ffmpeg', installed: true, version: '8.1.1' },
                ready: true,
                recipes: []
            })
        });
        window.fetch = fetchStub;

        const element = document.createElement('script');
        element.textContent = script;
        document.body.appendChild(element);
    }

    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    const fromExtension = (data: any) => window.dispatchEvent(new window.MessageEvent('message', { data }));
    const commandsToFrame = () => toFrame.getCalls().map(c => c.args[0]).filter(m => m?.event === 'command').map(m => m.func);
    const sentToExtension = (type: string) => toExtension.getCalls().map(c => c.args[0]).filter(m => m?.type === type);

    afterEach(() => {
        sinon.restore();
        dom?.window?.close();
    });

    describe('following Claude', () => {
        it('pauses the player when Claude starts waiting', () => {
            load();

            fromExtension({ type: 'autoPause', reason: 'claude' });

            expect(commandsToFrame()).to.deep.equal(['pauseVideo']);
        });

        it('resumes once nothing holds it paused any more', () => {
            load();

            fromExtension({ type: 'autoPause', reason: 'claude' });
            fromExtension({ type: 'autoResume', reason: 'claude' });

            expect(commandsToFrame()).to.deep.equal(['pauseVideo', 'playVideo']);
        });

        it('keeps the video paused while another reason still holds it', () => {
            load();

            fromExtension({ type: 'autoPause', reason: 'claude' });
            fromExtension({ type: 'autoPause', reason: 'window' });
            fromExtension({ type: 'autoResume', reason: 'claude' });

            expect(commandsToFrame()).to.deep.equal(['pauseVideo', 'pauseVideo']);
        });

        it('never restarts a video the viewer stopped by hand', () => {
            load();

            // The panel's own pause, e.g. the space bar.
            window.togglePlay();
            fromExtension({ type: 'autoResume', reason: 'claude' });

            expect(commandsToFrame()).to.deep.equal(['pauseVideo']);
        });

        it('treats a pause made inside the player frame the same way', () => {
            load();

            fromExtension({ type: 'userToggle', playing: false });
            fromExtension({ type: 'autoResume', reason: 'claude' });

            expect(commandsToFrame()).to.be.empty;
        });

        it('lets a manual play override a pause Claude asked for', () => {
            load();

            fromExtension({ type: 'autoPause', reason: 'claude' });
            // The player answers every state change, which is how the panel knows
            // what pressing play should do next.
            fromExtension({ event: 'infoDelivery', info: { playerState: 2 }, videoId: 'kJQP7kiw5Fk' });
            window.togglePlay();

            expect(commandsToFrame()).to.deep.equal(['pauseVideo', 'playVideo']);
        });

        it('drops the reasons it was holding once the viewer presses play', () => {
            load();

            fromExtension({ type: 'autoPause', reason: 'claude' });
            fromExtension({ type: 'autoPause', reason: 'window' });
            fromExtension({ event: 'infoDelivery', info: { playerState: 2 }, videoId: 'kJQP7kiw5Fk' });
            window.togglePlay();
            // Only one of the two reasons is dropped here. Playback resumes all
            // the same, which is what shows the other one is no longer held.
            fromExtension({ type: 'autoResume', reason: 'claude' });

            const commands = commandsToFrame();
            expect(commands.filter(c => c === 'pauseVideo')).to.have.length(2);
            expect(commands[commands.length - 1]).to.equal('playVideo');
        });
    });

    describe('the switch', () => {
        it('asks the extension for the stored setting on load', () => {
            load();

            expect(sentToExtension('requestFollowClaude')).to.have.length(1);
        });

        it('shows the stored setting', () => {
            load();

            fromExtension({ type: 'setFollowClaude', value: true });

            expect((document.getElementById('claude-toggle') as HTMLInputElement).checked).to.equal(true);
            expect(document.body.classList.contains('claude-sync-on')).to.equal(true);
        });

        it('reports a flip to the extension', () => {
            load();
            const toggle = document.getElementById('claude-toggle') as HTMLInputElement;

            toggle.checked = true;
            toggle.dispatchEvent(new window.Event('change'));

            expect(sentToExtension('toggleFollowClaude').pop()).to.deep.equal({ type: 'toggleFollowClaude', value: true });
        });

        it('sits in the top right corner', () => {
            load();

            const sync = document.querySelector('.claude-sync')!;
            // After the header, so CSS can tie its visibility to the header's.
            expect(sync.previousElementSibling?.className).to.contain('header');
            expect(sync.querySelector('#claude-toggle')).to.not.equal(null);
        });
    });

    describe('the setup screen', () => {
        it('stays down while both tools are present', async () => {
            load();
            await settle();

            expect((document.getElementById('setup-gate') as HTMLElement).hidden).to.equal(true);
        });

        it('covers the panel when a tool is missing, naming it', async () => {
            load({
                tools: {
                    ytDlp: { command: 'yt-dlp', installed: false },
                    ffmpeg: { command: 'ffmpeg', installed: true, version: '8.1.1' },
                    ready: false,
                    recipes: [{ manager: 'Homebrew', hint: 'The usual choice on macOS.', command: 'brew install yt-dlp' }]
                }
            });
            await settle();

            expect((document.getElementById('setup-gate') as HTMLElement).hidden).to.equal(false);
            expect(document.getElementById('setup-title')!.textContent).to.equal('yt-dlp is missing');
        });

        it('lists the install commands, ready to copy', async () => {
            load({
                tools: {
                    ytDlp: { command: 'yt-dlp', installed: false },
                    ffmpeg: { command: 'ffmpeg', installed: false },
                    ready: false,
                    recipes: [
                        { manager: 'Homebrew', hint: '', command: 'brew install yt-dlp ffmpeg' },
                        { manager: 'MacPorts', hint: '', command: 'sudo port install yt-dlp ffmpeg' }
                    ]
                }
            });
            await settle();

            const commands = Array.from(document.querySelectorAll('#setup-recipes code')).map(c => c.textContent);
            expect(commands).to.deep.equal(['brew install yt-dlp ffmpeg', 'sudo port install yt-dlp ffmpeg']);
            expect(document.querySelectorAll('#setup-recipes button')).to.have.length(2);
        });

        it('shows the path each tool was looked for under', async () => {
            load({
                tools: {
                    ytDlp: { command: '/opt/custom/yt-dlp', installed: false },
                    ffmpeg: { command: 'ffmpeg', installed: true, version: '8.1.1' },
                    ready: false,
                    recipes: []
                }
            });
            await settle();

            const rows = Array.from(document.querySelectorAll('#setup-tools li')).map(li => li.textContent);
            expect(rows[0]).to.contain('/opt/custom/yt-dlp').and.contain('not found');
            expect(rows[1]).to.contain('8.1.1');
        });

        it('rechecks on demand and steps aside once the tools appear', async () => {
            load({
                tools: {
                    ytDlp: { command: 'yt-dlp', installed: false },
                    ffmpeg: { command: 'ffmpeg', installed: false },
                    ready: false,
                    recipes: []
                }
            });
            await settle();

            fetchStub.resolves({
                ok: true,
                json: () => Promise.resolve({
                    ytDlp: { command: 'yt-dlp', installed: true, version: '2026.08.19' },
                    ffmpeg: { command: 'ffmpeg', installed: true, version: '8.1.1' },
                    ready: true,
                    recipes: []
                })
            });
            document.getElementById('setup-recheck')!.dispatchEvent(new window.MouseEvent('click'));
            await settle();

            expect(fetchStub.lastCall.args[0]).to.contain('refresh=1');
            expect((document.getElementById('setup-gate') as HTMLElement).hidden).to.equal(true);
        });

        it('does not block the panel when there is no server to ask', async () => {
            load({ proxyPort: 0 });
            await settle();

            expect(fetchStub.called).to.equal(false);
            expect((document.getElementById('setup-gate') as HTMLElement).hidden).to.equal(true);
        });
    });
});
