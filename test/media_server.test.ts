import { expect } from 'chai';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';
import * as childProcess from 'child_process';
import * as https from 'https';
import {
    handleInfo, handleMedia, handlePlayerPage, handleTools, handoffStream, setServerPort, setToolConfig, shutdownStreams
} from '../src/ytproxy';

function fakeProcess(options: { stdout?: string; stderr?: string; code?: number; error?: NodeJS.ErrnoException }) {
    const proc: any = new EventEmitter();
    proc.stdout = options.stdout !== undefined ? Readable.from([Buffer.from(options.stdout)]) : new PassThrough();
    proc.stderr = Readable.from(options.stderr ? [Buffer.from(options.stderr)] : []);
    proc.kill = sinon.stub();

    if (options.error || options.code !== undefined || options.stdout !== undefined) {
        setImmediate(() => {
            if (options.error) { proc.emit('error', options.error); return; }
            setImmediate(() => proc.emit('close', options.code ?? 0));
        });
    }

    return proc;
}

/** Collects what a handler writes, the way an http.ServerResponse would. */
function fakeResponse() {
    const res: any = new EventEmitter();
    res.statusCode = 0;
    res.headers = {};
    res.body = '';
    res.finished = false;

    res.writeHead = (code: number, headers?: Record<string, string>) => {
        res.statusCode = code;
        Object.assign(res.headers, headers ?? {});
        return res;
    };
    res.setHeader = (name: string, value: string) => { res.headers[name] = value; };
    res.end = (chunk?: any) => {
        if (chunk) res.body += String(chunk);
        res.finished = true;
        return res;
    };
    res.write = (chunk: any) => { res.body += String(chunk); return true; };
    res.on = EventEmitter.prototype.on.bind(res);

    return res;
}

const videoJson = JSON.stringify({
    duration: 282,
    title: 'Despacito',
    url: 'https://example/stream.m3u8',
    http_headers: { 'User-Agent': 'Chrome/145' }
});

describe('Media server endpoints', () => {
    let spawn: sinon.SinonStub;

    beforeEach(() => {
        spawn = sinon.stub(childProcess, 'spawn');
        setToolConfig({ ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', maxHeight: 1080 });
    });

    afterEach(() => sinon.restore());

    describe('/info', () => {
        it('answers with what the player page needs to lay itself out', async () => {
            spawn.callsFake(() => fakeProcess({ stdout: videoJson }));
            const res = fakeResponse();

            await handleInfo(res, 'kJQP7kiw5Fk');

            expect(res.statusCode).to.equal(200);
            expect(JSON.parse(res.body)).to.deep.equal({ duration: 282, title: 'Despacito' });
            expect(res.headers['Content-Type']).to.contain('application/json');
        });

        it('never leaks the stream url to the page', async () => {
            spawn.callsFake(() => fakeProcess({ stdout: videoJson }));
            const res = fakeResponse();

            await handleInfo(res, 'kJQP7kiw5Fk');

            expect(res.body).to.not.contain('stream.m3u8');
        });

        it('rejects a request without a video', async () => {
            const res = fakeResponse();

            await handleInfo(res, '');

            expect(res.statusCode).to.equal(400);
            expect(spawn.called).to.equal(false);
        });

        it('explains a bot check instead of repeating yt-dlp at the viewer', async () => {
            spawn.callsFake(() => fakeProcess({ stderr: 'ERROR: Sign in to confirm you’re not a bot\n', code: 1 }));
            const res = fakeResponse();

            await handleInfo(res, 'kJQP7kiw5Fk');

            expect(res.statusCode).to.equal(502);
            expect(JSON.parse(res.body).error).to.contain('anonymous session');
        });

        it('answers 501 when the tool itself is missing, not 502', async () => {
            spawn.callsFake(() => fakeProcess({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }));
            const res = fakeResponse();

            await handleInfo(res, 'kJQP7kiw5Fk');

            expect(res.statusCode).to.equal(501);
        });
    });

    describe('a stream cut from its HLS playlists', () => {
        const pairJson = JSON.stringify({
            duration: 17,
            title: 'Pair',
            requested_formats: [
                { url: 'https://example/video.m3u8', protocol: 'm3u8_native', http_headers: {} },
                { url: 'https://example/audio.m3u8', protocol: 'm3u8_native', http_headers: {} }
            ]
        });
        const playlist = [
            '#EXTM3U', '#EXTINF:5.88,', 'https://example/0.ts', '#EXTINF:5.92,', 'https://example/1.ts',
            '#EXTINF:5.2,', 'https://example/2.ts', '#EXT-X-ENDLIST'
        ].join('\n');

        beforeEach(() => {
            setServerPort(8799);
            sinon.stub(https, 'get').callsFake(((_url: string, _options: unknown, callback: (r: any) => void) => {
                const response: any = Readable.from([Buffer.from(playlist)]);
                response.statusCode = 200;
                setImmediate(() => callback(response));
                return new EventEmitter();
            }) as any);
        });

        afterEach(() => {
            shutdownStreams();
            setServerPort(0);
        });

        it('/info lists where the segments begin, for the player to count its clock from', async () => {
            spawn.callsFake(() => fakeProcess({ stdout: pairJson }));
            const res = fakeResponse();

            await handleInfo(res, 'cutInfo0001');

            expect(JSON.parse(res.body).cuts).to.deep.equal([0, 5.88, 5.88 + 5.92]);
        });

        it('starts at the head of the segment, never inside it, and hands over from there', async () => {
            spawn.withArgs('yt-dlp').callsFake(() => fakeProcess({ stdout: pairJson }));
            spawn.withArgs('ffmpeg').callsFake(() => fakeProcess({}));
            const res = fakeResponse();

            await handleMedia(res, 'cutMedia001', 8);

            const args: string[] = spawn.getCalls().find(c => c.args[0] === 'ffmpeg')!.args[1];
            expect(args).to.not.include('-ss');
            expect(args).to.include('http://127.0.0.1:8799/playlist?v=cutMedia001&i=1&from=1');
            // A view taking this stream over counts from where it really begins.
            expect(handoffStream('cutMedia001')!.startAt).to.equal(5.88);
        });
    });

    describe('/tools', () => {
        it('reports both tools and the recipes for what is missing', async () => {
            spawn.withArgs('yt-dlp', ['--version']).callsFake(() => fakeProcess({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }));
            spawn.withArgs('ffmpeg', ['-version']).callsFake(() => fakeProcess({ stdout: 'ffmpeg version 8.1.1\n' }));
            const res = fakeResponse();

            await handleTools(res, true);

            const report = JSON.parse(res.body);
            expect(res.statusCode).to.equal(200);
            expect(report.ready).to.equal(false);
            expect(report.recipes.length).to.be.greaterThan(0);
        });
    });

    describe('/media', () => {
        it('starts ffmpeg on the resolved stream and streams MP4 back', async () => {
            spawn.withArgs('yt-dlp').callsFake(() => fakeProcess({ stdout: videoJson }));
            spawn.withArgs('ffmpeg').callsFake(() => fakeProcess({}));
            const res = fakeResponse();

            await handleMedia(res, 'kJQP7kiw5Fk', 0);

            expect(res.statusCode).to.equal(200);
            expect(res.headers['Content-Type']).to.equal('video/mp4');
            const ffmpegCall = spawn.getCalls().find(c => c.args[0] === 'ffmpeg');
            expect(ffmpegCall?.args[1]).to.include('https://example/stream.m3u8');
        });

        it('passes the requested offset to ffmpeg', async () => {
            spawn.withArgs('yt-dlp').callsFake(() => fakeProcess({ stdout: videoJson }));
            spawn.withArgs('ffmpeg').callsFake(() => fakeProcess({}));
            const res = fakeResponse();

            await handleMedia(res, 'kJQP7kiw5Fk', 150);

            const args: string[] = spawn.getCalls().find(c => c.args[0] === 'ffmpeg')!.args[1];
            expect(args[args.indexOf('-ss') + 1]).to.equal('150');
        });

        it('holds the stream when the viewer goes away, and ends it if nobody returns', async () => {
            spawn.withArgs('yt-dlp').callsFake(() => fakeProcess({ stdout: videoJson }));
            const ffmpeg = fakeProcess({});
            spawn.withArgs('ffmpeg').callsFake(() => ffmpeg);
            const res = fakeResponse();

            await handleMedia(res, 'kJQP7kiw5Fk', 0);
            const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date', 'setTimeout'] });
            try {
                res.emit('close');

                // Pausing a video is enough for a browser to drop the connection,
                // and the same page usually comes straight back for the stream.
                expect(ffmpeg.kill.called).to.equal(false);

                clock.tick(16 * 1000);
                expect(ffmpeg.kill.calledWith('SIGKILL')).to.equal(true);
            } finally {
                clock.restore();
            }
        });

        it('answers 502 with the reason when the video cannot be resolved', async () => {
            spawn.callsFake(() => fakeProcess({ stderr: 'ERROR: Video unavailable\n', code: 1 }));
            const res = fakeResponse();

            await handleMedia(res, 'kJQP7kiw5Fk', 0);

            expect(res.statusCode).to.equal(502);
            expect(res.body).to.contain('Video unavailable');
        });

        it('rejects a request without a video', async () => {
            const res = fakeResponse();

            await handleMedia(res, '', 0);

            expect(res.statusCode).to.equal(400);
        });
    });

    describe('/embed', () => {
        it('serves a player page carrying the video and start time', () => {
            const res = fakeResponse();

            handlePlayerPage(res, 'kJQP7kiw5Fk', 90, true);

            expect(res.statusCode).to.equal(200);
            expect(res.headers['Content-Type']).to.contain('text/html');
            expect(res.body).to.contain('"kJQP7kiw5Fk"');
            expect(res.body).to.contain('load(videoId, 90, true, "", 0)');
        });

        it('cues without autoplay when asked', () => {
            const res = fakeResponse();

            handlePlayerPage(res, 'kJQP7kiw5Fk', 0, false);

            expect(res.body).to.contain('load(videoId, 0, false, "", 0)');
        });

        it('is never cached, since the port changes between sessions', () => {
            const res = fakeResponse();

            handlePlayerPage(res, 'kJQP7kiw5Fk', 0, true);

            expect(res.headers['Cache-Control']).to.equal('no-cache');
        });
    });
});
