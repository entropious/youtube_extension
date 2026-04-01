import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { YouTubeViewProvider } from '../src/provider';
import { MockMemento, createMockWebview, createMockWebviewView } from './mocks';

describe('YouTubeViewProvider Late Update Protection', () => {
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

    it('should ignore timeUpdate from older videos during switching', async () => {
        const videoA = 'https://www.youtube.com/watch?v=videoA';
        const videoB = 'https://www.youtube.com/watch?v=videoB';
        
        const webview = createMockWebview();
        const webviewView = createMockWebviewView(webview);
        provider.resolveWebviewView(webviewView as any, {} as any, {} as any);
        const handler = webview.onDidReceiveMessage.getCall(0).args[0];

        // 1. Initial load Video A
        await provider.loadUrl(videoA);
        
        // 2. Load Video B 
        await provider.loadUrl(videoB);
        
        // 3. Receive a LATE message from Video A that arrives after B has started loading
        // We simulate the bug by sending a message with A's URL
        await handler({ type: 'timeUpdate', time: 999, url: videoA });

        // 4. Verify that the memory state and cache for Video B is NOT corrupted
        // Note: provider._lastTime should represent the progress of the ACTIVE video (B)
        expect(provider._lastTime).to.equal(0, 'Progress should not be corrupted by late update from previous video');
        
        // Check cache for B
        const timestamps = memento.get<Record<string, number>>(YouTubeViewProvider.timestampsKey, {});
        expect(timestamps['videoB'] || 0).to.equal(0, 'Memento for B should not be corrupted');
        
        // 5. Send a CORRECT message for Video B
        await handler({ type: 'timeUpdate', time: 10, url: videoB });
        expect(provider._lastTime).to.equal(10);
    });

    it( 'should correctly build separate state even if they are very fast', async () => {
        const video1 = 'https://www.youtube.com/watch?v=12345678901';
        const video2 = 'https://www.youtube.com/watch?v=ABCDEFGHIJK';
        const webview = createMockWebview();
        const webviewView = createMockWebviewView(webview);
        provider.resolveWebviewView(webviewView as any, {} as any, {} as any);
        const handler = webview.onDidReceiveMessage.lastCall.args[0];

        await provider.loadUrl(video1);
        await handler({ type: 'timeUpdate', time: 100, url: video1 });
        
        await provider.loadUrl(video2);
        // This should trigger the save of video1
        await provider.saveCurrentState(); 
        
        const data = memento.get<Record<string, any>>(YouTubeViewProvider.timestampsKey, {});
        expect(data['12345678901'].time).to.equal(100);
        expect(data['ABCDEFGHIJK'].time).to.equal(0);
    });
});
