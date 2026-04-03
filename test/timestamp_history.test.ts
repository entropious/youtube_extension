import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { YouTubeViewProvider } from '../src/provider';
import { MockMemento, createMockWebview, createMockWebviewView } from './mocks';

describe('YouTubeViewProvider Timestamp History', () => {
    let provider: YouTubeViewProvider;
    let memento: MockMemento;
    let extensionUri: any;
    let fsStub: sinon.SinonStub;

    beforeEach(() => {
        memento = new MockMemento();
        extensionUri = { fsPath: '/mock/path', toString: () => 'file:///mock/path' };
        provider = new YouTubeViewProvider(extensionUri as vscode.Uri, memento as any, () => 1234);

        fsStub = sinon.stub(fs, 'readFileSync');
        fsStub.withArgs(sinon.match(/index\.html/)).returns('<html>%%STYLE%% %%SCRIPT%% %%INITIAL_URL%%</html>');
        fsStub.withArgs(sinon.match(/style\.css/)).returns('/* mock style */');
        fsStub.withArgs(sinon.match(/script\.js/)).returns('/* mock script */ %%INITIAL_URL_JSON%% %%PROXY_PORT_JSON%%');
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should save timestamp of the current video when switching to another video', async () => {
        const video1 = 'https://www.youtube.com/watch?v=video1';
        const video2 = 'https://www.youtube.com/watch?v=video2';
        
        const webview = createMockWebview();
        const webviewView = createMockWebviewView(webview);
        provider.resolveWebviewView(webviewView as any, {} as any, {} as any);

        // 1. Load Video 1
        await provider.loadUrl(video1);
        
        // 2. Simulate time update for Video 1
        const messageHandler = webview.onDidReceiveMessage.getCall(0).args[0];
        await messageHandler({ type: 'timeUpdate', time: 100 });
        
        // 3. Load Video 2
        await provider.loadUrl(video2);
        
        // 4. Check if timestamp for Video 1 is saved in memento
        const timestamps = memento.get<Record<string, any>>(YouTubeViewProvider.timestampsKey, {});
        expect(timestamps['video1'].time).to.equal(100, 'Timestamp for video1 should be saved when switching to video2');
    });

    it('should correctly restore timestamp even during rapid video switching', async () => {
        const videoA = 'https://www.youtube.com/watch?v=videoA';
        const videoB = 'https://www.youtube.com/watch?v=videoB';
        
        const webview = createMockWebview();
        const webviewView = createMockWebviewView(webview);
        provider.resolveWebviewView(webviewView as any, {} as any, {} as any);
        const handler = webview.onDidReceiveMessage.getCall(0).args[0];

        // 1. Start with Video A
        await provider.loadUrl(videoA);
        await handler({ type: 'timeUpdate', time: 500 });

        // 2. Mock memento.update to be SLOW
        let resolveUpdate: (value: void | PromiseLike<void>) => void;
        const updatePromise = new Promise<void>(resolve => { resolveUpdate = resolve; });
        // Use any because memento.update might have different overload in types than in our mock but sinon works fine
        const mementoStub = sinon.stub(memento, 'update').returns(updatePromise as any);

        // 3. Switch to Video B - this triggers save of Video A (slow)
        const loadBPromise = provider.loadUrl(videoB);
        
        // 4. Update time for Video B
        await handler({ type: 'timeUpdate', time: 10 });

        // 5. Switch back to Video A IMMEDIATELY - this should read 500
        const loadAPromise = provider.loadUrl(videoA);

        // Resolve the memento updates
        resolveUpdate!();
        await Promise.all([loadBPromise, loadAPromise]);

        // 6. Verify that the loadUrl message sent to webview for Video A had startTime=500
        const loadUrlCalls = webview.postMessage.getCalls().filter(c => c.args[0].type === 'loadUrl');
        const lastLoad = loadUrlCalls[loadUrlCalls.length - 1];
        expect(lastLoad.args[0].originalUrl).to.equal(videoA);
        expect(lastLoad.args[0].startTime).to.equal(500, 'Should restore A from 500 even if memento update was in progress');
    });

    it('should evict oldest timestamps when reaching limit (500)', async () => {
        // 1. Fill with 500 entries
        for (let i = 0; i < 500; i++) {
            await provider._saveTimestamp(`https://youtube.com/watch?v=v${i}`, 100);
            // Small delay to ensure lastUsed differ if needed, though they are added sequentially
        }

        let timestamps = memento.get<Record<string, any>>(YouTubeViewProvider.timestampsKey, {});
        expect(Object.keys(timestamps)).to.have.lengthOf(500);

        // 2. Add 501st entry
        await provider._saveTimestamp('https://youtube.com/watch?v=v_new', 200, true);
        
        timestamps = memento.get<Record<string, any>>(YouTubeViewProvider.timestampsKey, {});
        expect(Object.keys(timestamps)).to.have.lengthOf(500);
        expect(timestamps['v_new']).to.not.be.undefined;
        // One of the old ones should be gone (v0 if timestamps are strictly ordered by insertion/lastUsed)
        expect(timestamps['v0']).to.be.undefined;
    });
});

