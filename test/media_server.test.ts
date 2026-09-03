import { expect } from 'chai';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';
import * as childProcess from 'child_process';
import { handleInfo, handleMedia, handlePlayerPage, handleTools, setToolConfig } from '../src/ytproxy';

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

        it('kills ffmpeg when the viewer navigates away', async () => {
            spawn.withArgs('yt-dlp').callsFake(() => fakeProcess({ stdout: videoJson }));
            const ffmpeg = fakeProcess({});
            spawn.withArgs('ffmpeg').callsFake(() => ffmpeg);
            const res = fakeResponse();

            await handleMedia(res, 'kJQP7kiw5Fk', 0);
            res.emit('close');

            expect(ffmpeg.kill.calledWith('SIGKILL')).to.equal(true);
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
            expect(res.body).to.contain('load(videoId, 90, true)');
        });

        it('cues without autoplay when asked', () => {
            const res = fakeResponse();

            handlePlayerPage(res, 'kJQP7kiw5Fk', 0, false);

            expect(res.body).to.contain('load(videoId, 0, false)');
        });

        it('is never cached, since the port changes between sessions', () => {
            const res = fakeResponse();

            handlePlayerPage(res, 'kJQP7kiw5Fk', 0, true);

            expect(res.headers['Cache-Control']).to.equal('no-cache');
        });
    });
});
