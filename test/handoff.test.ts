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

/** Wraps `children` in a box of `type`. */
function container(type: string, ...children: Buffer[]) {
    const body = Buffer.concat(children);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, body]);
}

const TIMESCALE = 1000;

/** A moov whose first track counts a thousand ticks a second. */
function moov() {
    const mdhd = Buffer.alloc(32);
    mdhd.writeUInt32BE(32, 0);
    mdhd.write('mdhd', 4, 'latin1');
    mdhd.writeUInt32BE(TIMESCALE, 20);
    return container('moov', container('trak', container('mdia', mdhd)));
}

/** A fragment beginning at `seconds`, with `payload` bytes of media after it. */
function fragment(seconds: number, payload = 32) {
    const tfdt = Buffer.alloc(16);
    tfdt.writeUInt32BE(16, 0);
    tfdt.write('tfdt', 4, 'latin1');
    tfdt.writeUInt32BE(Math.round(seconds * TIMESCALE), 12);
    return Buffer.concat([container('moof', container('traf', tfdt)), box('mdat', payload)]);
}

const HEAD = Buffer.concat([box('ftyp', 24), moov()]).length;
const FRAGMENT = fragment(0).length;

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

    /**
     * Serves a video from `at`, then plays `seconds` of it.
     *
     * The stream runs ahead of any viewer, so it is played out fragment by
     * fragment: what a handover has to find is the second that was on screen,
     * not the one the pipe has reached.
     */
    async function playing(at = 0, seconds = 1) {
        const res = fakeResponse();
        await handleMedia(res, videoId, at);
        const ff = ffmpegs[ffmpegs.length - 1];
        ff.stdout.write(Buffer.concat([box('ftyp', 24), moov()]));
        for (let second = 0; second < seconds; second++) ff.stdout.write(fragment(second));
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

        const body = second.body();
        expect(body.toString('latin1', 4, 8)).to.equal('ftyp');
        expect(body.length).to.equal(HEAD + FRAGMENT);
    });

    it('replays from the second the viewer was on, not the one the pipe reached', async () => {
        // Ten seconds fetched while the picture is still at the third.
        await playing(0, 10);

        const second = fakeResponse();
        expect(takeOverStream(second, handoffStream(videoId)!.id, 3)).to.equal(true);

        // The header, then the third second onwards — seven fragments, not ten.
        expect(second.body().length).to.equal(HEAD + FRAGMENT * 7);
    });

    it('counts the wanted second from the start of the video, not of the stream', async () => {
        // A stream that itself began at 0:30, playing its first ten seconds.
        await playing(30, 10);

        const second = fakeResponse();
        expect(takeOverStream(second, handoffStream(videoId)!.id, 34)).to.equal(true);

        expect(second.body().length).to.equal(HEAD + FRAGMENT * 6);
    });

    it('refuses a second the stream never held, rather than jumping the picture', async () => {
        // A stream of the last ten seconds of a long video.
        await playing(600, 10);

        // Before it begins: this view is watching something the stream never
        // fetched, and would be thrown minutes forward by taking it.
        expect(takeOverStream(fakeResponse(), handoffStream(videoId)!.id, 120)).to.equal(false);
        expect(takeOverStream(fakeResponse(), handoffStream(videoId)!.id, 604)).to.equal(true);
    });

    it('carries on into the new view, and leaves the old one ended', async () => {
        const first = await playing(0);
        const second = fakeResponse();
        takeOverStream(second, handoffStream(videoId)!.id);
        const before = first.res.chunks.length;

        first.ff.stdout.write(fragment(1));
        await settle();

        expect(first.res.ended).to.equal(true);
        expect(first.res.chunks).to.have.length(before);
        expect(second.body().length).to.equal(HEAD + FRAGMENT * 2);
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
        first.ff.stdout.write(fragment(1));
        await settle();

        expect(second.body().length).to.equal(HEAD + FRAGMENT * 2);
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
        first.ff.stdout.write(fragment(1));
        await settle();
        expect(first.ff.stdout.isPaused()).to.equal(true);

        const second = fakeResponse();
        takeOverStream(second, handoffStream(videoId)!.id);
        first.ff.stdout.write(fragment(2));
        await settle();

        // The drain of the old response is never coming, so nothing else can
        // restart the pipe.
        expect(second.body().length).to.equal(HEAD + FRAGMENT * 3);
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
