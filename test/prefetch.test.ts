import { expect } from 'chai';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';
import { YouTubeViewProvider } from '../src/provider';
import { setToolConfig, shutdownStreams } from '../src/ytproxy';
import { MockMemento, createMockWebview, createMockWebviewView } from './mocks';

const videoJson = JSON.stringify({
    duration: 100,
    title: 'Next up',
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

const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

describe('Resolving the next video in a playlist', () => {
    let spawn: sinon.SinonStub;
    let provider: YouTubeViewProvider;
    let handle: (message: any) => Promise<void>;
    let nextId = 0;
    let current: string;
    let next: string;

    /** Whether yt-dlp has been asked about a video of its own. */
    const askedAbout = (videoId: string) =>
        spawn.getCalls().some(call => (call.args[1] as string[])?.some(arg => String(arg).includes(videoId)));

    beforeEach(() => {
        spawn = sinon.stub(childProcess, 'spawn').callsFake(() => fakeYtDlp() as any);
        setToolConfig({ ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', maxHeight: 1080 });

        // Videos of their own per test: a resolved stream is cached globally.
        current = `current${nextId}`.padEnd(11, 'x');
        next = `next${nextId++}`.padEnd(11, 'x');

        const memento = new MockMemento();
        provider = new YouTubeViewProvider({ fsPath: '/mock/path' } as vscode.Uri, memento as any, () => 1234);

        const webview = createMockWebview();
        provider.resolveWebviewView(createMockWebviewView(webview) as any, {} as any, {} as any);
        handle = webview.onDidReceiveMessage.getCall(0).args[0];

        const state = provider as any;
        state._lastUrl = `https://www.youtube.com/watch?v=${current}&list=PLtest`;
        state._playlistId = 'PLtest';
        state._currentPlaylist = [current, next];
    });

    afterEach(() => {
        shutdownStreams();
        sinon.restore();
    });

    it('leaves a video passed over after a few seconds unresolved', async () => {
        await handle({ type: 'timeUpdate', time: 4 });
        await settle();

        expect(askedAbout(next)).to.equal(false);
    });

    it('resolves it once this video has really been watched', async () => {
        await handle({ type: 'timeUpdate', time: YouTubeViewProvider.prefetchAfterSeconds });
        await settle();

        expect(askedAbout(next)).to.equal(true);
    });

    it('asks about it once, however long the video plays', async () => {
        for (const time of [25, 26, 27, 28]) {
            await handle({ type: 'timeUpdate', time });
            await settle();
        }

        const lookups = spawn.getCalls().filter(call => (call.args[1] as string[])?.some(arg => String(arg).includes(next)));
        expect(lookups).to.have.length(1);
    });

    it('has nothing to resolve outside a playlist', async () => {
        const state = provider as any;
        state._playlistId = undefined;
        state._currentPlaylist = [];

        await handle({ type: 'timeUpdate', time: 40 });
        await settle();

        expect(askedAbout(next)).to.equal(false);
    });
});
