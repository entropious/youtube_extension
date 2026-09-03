import { expect } from 'chai';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';
import * as childProcess from 'child_process';
import { handleMedia, prefetchStream, prewarmStream, setToolConfig } from '../src/ytproxy';

/** yt-dlp answers after `delayMs`, so a request can arrive mid-lookup. */
function fakeYtDlp(json: string, delayMs = 0) {
    const proc: any = new EventEmitter();
    proc.stdout = Readable.from([Buffer.from(json)]);
    proc.stderr = Readable.from([]);
    proc.kill = sinon.stub();
    setTimeout(() => setImmediate(() => proc.emit('close', 0)), delayMs);
    return proc;
}

function failingYtDlp(message: string) {
    const proc: any = new EventEmitter();
    proc.stdout = Readable.from([]);
    proc.stderr = Readable.from([Buffer.from(message)]);
    proc.kill = sinon.stub();
    setImmediate(() => setImmediate(() => proc.emit('close', 1)));
    return proc;
}

/** ffmpeg that keeps producing until it is killed. */
function fakeFfmpeg() {
    const proc: any = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = sinon.stub().callsFake(() => { proc.killed = true; });
    return proc;
}

function fakeResponse() {
    const res: any = new EventEmitter();
    res.statusCode = 0;
    res.headers = {};
    res.chunks = [];
    res.writeHead = (code: number, headers?: Record<string, string>) => {
        res.statusCode = code;
        Object.assign(res.headers, headers ?? {});
        return res;
    };
    res.setHeader = () => undefined;
    res.write = (chunk: any) => { res.chunks.push(Buffer.from(chunk)); return true; };
    res.end = (chunk?: any) => { if (chunk) res.chunks.push(Buffer.from(chunk)); return res; };
    res.on = EventEmitter.prototype.on.bind(res);
    return res;
}

const videoJson = JSON.stringify({
    duration: 100,
    title: 'Warm',
    url: 'https://example/stream.m3u8',
    http_headers: {}
});

const settle = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

describe('Warming a start up', () => {
    let spawn: sinon.SinonStub;
    let ffmpegs: any[];
    let videoId: string;
    let nextId = 0;

    /** Warming resolves first, so ffmpeg only appears a few ticks later. */
    async function waitForFfmpeg(count: number, timeoutMs = 2000) {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until && ffmpegs.length < count) await settle();
        return ffmpegs.length;
    }

    beforeEach(() => {
        ffmpegs = [];
        // A video of its own per test: the resolved stream is cached globally.
        videoId = `video${nextId++}`.padEnd(11, 'x');

        spawn = sinon.stub(childProcess, 'spawn');
        spawn.withArgs('yt-dlp').callsFake(() => fakeYtDlp(videoJson));
        spawn.withArgs('ffmpeg').callsFake(() => { const p = fakeFfmpeg(); ffmpegs.push(p); return p; });
        setToolConfig({ ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', maxHeight: 1080 });
    });

    afterEach(async () => {
        // Leaves no warm process running into the next test.
        prewarmStream('');
        await settle();
        sinon.restore();
    });

    it('resolves and starts fetching before anything is requested', async () => {
        prewarmStream(videoId, 0);

        expect(await waitForFfmpeg(1)).to.equal(1);
        expect(spawn.calledWith('yt-dlp')).to.equal(true);
    });

    it('hands the warmed process to the request instead of starting another', async () => {
        prewarmStream(videoId, 0);
        await waitForFfmpeg(1);
        const warmed = ffmpegs[0];

        const res = fakeResponse();
        await handleMedia(res, videoId, 0);

        expect(ffmpegs).to.have.length(1);
        expect(res.statusCode).to.equal(200);
        expect(warmed.killed).to.equal(false);
    });

    it('waits for a warm-up that is still resolving, rather than doubling it', async () => {
        spawn.withArgs('yt-dlp').callsFake(() => fakeYtDlp(videoJson, 60));
        prewarmStream(videoId, 0);

        // The page asks while yt-dlp is still working — the usual case.
        const res = fakeResponse();
        await handleMedia(res, videoId, 0);

        expect(spawn.withArgs('yt-dlp').callCount).to.equal(1);
        expect(ffmpegs).to.have.length(1);
    });

    it('replays what was fetched during the wait, so nothing is lost', async () => {
        prewarmStream(videoId, 0);
        await waitForFfmpeg(1);
        ffmpegs[0].stdout.write(Buffer.from('moov-and-first-frames'));
        await settle(30);

        const res = fakeResponse();
        await handleMedia(res, videoId, 0);

        expect(Buffer.concat(res.chunks).toString()).to.contain('moov-and-first-frames');
    });

    it('is ignored when the request is for another video', async () => {
        prewarmStream(videoId, 0);
        await waitForFfmpeg(1);

        const res = fakeResponse();
        await handleMedia(res, 'otherVideoX', 0);

        expect(await waitForFfmpeg(2)).to.equal(2);
    });

    it('is ignored when the request starts at another offset', async () => {
        prewarmStream(videoId, 0);
        await waitForFfmpeg(1);

        const res = fakeResponse();
        await handleMedia(res, videoId, 150);

        expect(await waitForFfmpeg(2)).to.equal(2);
    });

    it('drops the previous warm-up when the choice changes', async () => {
        prewarmStream(videoId, 0);
        await waitForFfmpeg(1);
        const first = ffmpegs[0];

        prewarmStream('anotherVidX', 0);
        await settle(30);

        expect(first.kill.calledWith('SIGKILL')).to.equal(true);
    });

    it('does not restart a warm-up already running for the same video', async () => {
        prewarmStream(videoId, 0);
        await waitForFfmpeg(1);

        prewarmStream(videoId, 0);
        await settle(30);

        expect(ffmpegs).to.have.length(1);
    });

    it('ignores an empty video id', async () => {
        prewarmStream('', 0);
        await settle(30);

        expect(spawn.called).to.equal(false);
    });

    it('survives a lookup that fails, leaving the request to report it', async () => {
        spawn.withArgs('yt-dlp').callsFake(() => failingYtDlp('ERROR: Video unavailable\n'));

        prewarmStream(videoId, 0);
        await settle(50);

        const res = fakeResponse();
        await handleMedia(res, videoId, 0);

        expect(res.statusCode).to.equal(502);
        expect(ffmpegs).to.be.empty;
    });

    it('ends the stream still running for the previous video', async () => {
        const first = fakeResponse();
        await handleMedia(first, videoId, 0);
        const previous = ffmpegs[0];

        // Switching videos: the old stream would otherwise keep fetching ahead
        // and compete for the same connection.
        const second = fakeResponse();
        await handleMedia(second, 'otherVideoX', 0);

        expect(previous.kill.calledWith('SIGKILL')).to.equal(true);
        expect(ffmpegs[1].killed).to.equal(false);
    });

    it('ends the previous stream even when the new one is warm', async () => {
        const playing = fakeResponse();
        await handleMedia(playing, videoId, 0);
        const previous = ffmpegs[0];

        prewarmStream('otherVideoX', 0);
        await waitForFfmpeg(2);
        const res = fakeResponse();
        await handleMedia(res, 'otherVideoX', 0);

        expect(previous.kill.calledWith('SIGKILL')).to.equal(true);
    });

    describe('prefetchStream', () => {
        it('resolves without fetching any video', async () => {
            prefetchStream(videoId);
            await settle(50);

            expect(spawn.calledWith('yt-dlp')).to.equal(true);
            expect(ffmpegs).to.be.empty;
        });

        it('makes the later request skip the lookup', async () => {
            prefetchStream(videoId);
            await settle(50);
            const lookups = spawn.withArgs('yt-dlp').callCount;

            const res = fakeResponse();
            await handleMedia(res, videoId, 0);

            expect(spawn.withArgs('yt-dlp').callCount).to.equal(lookups);
            expect(res.statusCode).to.equal(200);
        });
    });
});
