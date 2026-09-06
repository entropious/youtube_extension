import { expect } from 'chai';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';
import * as childProcess from 'child_process';
import { handleMedia, handoffStream, setToolConfig, shutdownStreams, takeOverStream } from '../src/ytproxy';

const videoJson = JSON.stringify({
    duration: 100,
    title: 'Moved',
    url: 'https://example/stream.m3u8',
    http_headers: {}
});

function fakeYtDlp() {
    const proc: any = new EventEmitter();
    proc.stdout = Readable.from([Buffer.from(videoJson)]);
    proc.stderr = Readable.from([]);
    proc.kill = sinon.stub();
    setImmediate(() => setImmediate(() => proc.emit('close', 0)));
    return proc;
}

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
    res.ended = false;
    res.writeHead = (code: number, headers?: Record<string, string>) => {
        res.statusCode = code;
        Object.assign(res.headers, headers ?? {});
        return res;
    };
    res.setHeader = () => undefined;
    res.write = (chunk: any) => { res.chunks.push(Buffer.from(chunk)); return true; };
    res.end = (chunk?: any) => { if (chunk) res.chunks.push(Buffer.from(chunk)); res.ended = true; return res; };
    res.body = () => Buffer.concat(res.chunks);
    return res;
}

/** A top-level MP4 box of `type`, padded to `size` bytes. */
function box(type: string, size: number) {
    const buffer = Buffer.alloc(size);
    buffer.writeUInt32BE(size, 0);
    buffer.write(type, 4, 'latin1');
    return buffer;
}

const settle = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

describe('Moving a stream between views', () => {
    let spawn: sinon.SinonStub;
    let ffmpegs: any[];
    let videoId: string;
    let nextId = 0;

    beforeEach(() => {
        ffmpegs = [];
        videoId = `moved${nextId++}`.padEnd(11, 'x');
        spawn = sinon.stub(childProcess, 'spawn');
        spawn.withArgs('yt-dlp').callsFake(() => fakeYtDlp());
        spawn.withArgs('ffmpeg').callsFake(() => { const p = fakeFfmpeg(); ffmpegs.push(p); return p; });
        setToolConfig({ ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', maxHeight: 1080 });
    });

    afterEach(() => {
        shutdownStreams();
        sinon.restore();
    });

    /** Serves a video from `at`, and plays enough of it to pass the header. */
    async function playing(at = 0) {
        const res = fakeResponse();
        await handleMedia(res, videoId, at);
        const ff = ffmpegs[ffmpegs.length - 1];
        ff.stdout.write(Buffer.concat([box('ftyp', 24), box('moov', 40)]));
        ff.stdout.write(box('moof', 16));
        await settle();
        return { res, ff };
    }

    it('offers the running stream, and only for the video it carries', async () => {
        await playing(30);

        const offer = handoffStream(videoId);
        expect(offer?.startAt).to.equal(30);
        expect(handoffStream('otherVideoX')).to.equal(null);
    });

    it('hands the same ffmpeg to the other view, asking YouTube for nothing', async () => {
        const first = await playing(0);
        const lookups = spawn.withArgs('yt-dlp').callCount;

        const second = fakeResponse();
        expect(takeOverStream(second, handoffStream(videoId)!.id)).to.equal(true);

        expect(ffmpegs).to.have.length(1);
        expect(first.ff.killed).to.equal(false);
        expect(spawn.withArgs('yt-dlp').callCount).to.equal(lookups);
        expect(second.statusCode).to.equal(200);
        expect(second.headers['Content-Type']).to.equal('video/mp4');
    });

    it('gives the header first, so a player joining midway can decode', async () => {
        await playing(0);

        const second = fakeResponse();
        takeOverStream(second, handoffStream(videoId)!.id);

        // ftyp and moov, and nothing of the fragment that had already gone out.
        const head = second.body();
        expect(head.toString('latin1', 4, 8)).to.equal('ftyp');
        expect(head.length).to.equal(64);
    });

    it('carries on into the new view, and leaves the old one ended', async () => {
        const first = await playing(0);
        const second = fakeResponse();
        takeOverStream(second, handoffStream(videoId)!.id);
        const before = first.res.chunks.length;

        first.ff.stdout.write(box('moof', 32));
        await settle();

        expect(first.res.ended).to.equal(true);
        expect(first.res.chunks).to.have.length(before);
        expect(second.body().length).to.equal(64 + 32);
    });

    it('keeps the stream alive when the view that had it closes', async () => {
        const first = await playing(0);
        const second = fakeResponse();
        takeOverStream(second, handoffStream(videoId)!.id);

        // The old page tears its request down once the response ends.
        first.res.emit('close');
        await settle();

        expect(first.ff.killed).to.equal(false);
    });

    it('waits for the view it was promised to, which arrives after the old one goes', async () => {
        const first = await playing(0);
        const offer = handoffStream(videoId)!;

        // Pausing a video is enough for a browser to drop the connection, and it
        // happens the moment the move begins — well before the other view has a
        // page of its own to ask with.
        first.res.emit('close');
        await settle();
        expect(first.ff.killed).to.equal(false);

        const second = fakeResponse();
        expect(takeOverStream(second, offer.id)).to.equal(true);
        first.ff.stdout.write(box('moof', 40));
        await settle();

        expect(second.body().length).to.equal(64 + 40);
    });

    it('ends a stream nobody comes for', async () => {
        const first = await playing(0);
        // Started only now: the stream above is set up with real timers.
        const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date', 'setTimeout'] });
        try {
            handoffStream(videoId);
            first.res.emit('close');

            clock.tick(16 * 1000);

            expect(first.ff.killed).to.equal(true);
        } finally {
            clock.restore();
        }
    });

    it('resumes a pipe the leaving view had held back', async () => {
        const first = await playing(0);
        // The old response stops taking bytes, which pauses the pipe.
        first.res.write = () => false;
        first.ff.stdout.write(box('moof', 32));
        await settle();
        expect(first.ff.stdout.isPaused()).to.equal(true);

        const second = fakeResponse();
        takeOverStream(second, handoffStream(videoId)!.id);
        first.ff.stdout.write(box('moof', 48));
        await settle();

        // The drain of the old response is never coming, so nothing else can
        // restart the pipe.
        expect(second.body().length).to.equal(64 + 48);
    });

    it('refuses a stream that is gone, so the view starts one of its own', async () => {
        const first = await playing(0);
        const id = handoffStream(videoId)!.id;
        first.ff.emit('close', 0);
        await settle();

        expect(takeOverStream(fakeResponse(), id)).to.equal(false);
        expect(handoffStream(videoId)).to.equal(null);
    });

    it('refuses a stream whose header has not gone past yet', async () => {
        const res = fakeResponse();
        await handleMedia(res, videoId, 0);
        await settle();

        // Nothing has been produced, so there is no header to hand over.
        expect(takeOverStream(fakeResponse(), handoffStream(videoId)!.id)).to.equal(false);
    });
});
