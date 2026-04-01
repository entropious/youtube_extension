import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { YouTubeViewProvider } from '../src/provider';
import { MockMemento, createMockWebview, createMockWebviewPanel, createMockWebviewView } from './mocks';

describe('YouTubeViewProvider Synchronization', () => {
    let provider: YouTubeViewProvider;
    let memento: MockMemento;
    let extensionUri: any;
    let fsStub: sinon.SinonStub;

    beforeEach(() => {
        memento = new MockMemento();
        extensionUri = { fsPath: '/mock/path', toString: () => 'file:///mock/path' };
        provider = new YouTubeViewProvider(extensionUri as vscode.Uri, memento as any, () => 1234);

        // Mocking fs read to avoid missing file errors
        fsStub = sinon.stub(fs, 'readFileSync');
        fsStub.withArgs(sinon.match(/index\.html/)).returns('<html>%%STYLE%% %%SCRIPT%% %%INITIAL_URL%%</html>');
        fsStub.withArgs(sinon.match(/style\.css/)).returns('/* mock style */');
        fsStub.withArgs(sinon.match(/script\.js/)).returns('/* mock script */ %%INITIAL_URL_JSON%% %%PROXY_PORT_JSON%%');
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should save timestamp when a tab (panel) is disposed', async () => {
        const webview = createMockWebview();
        const panel = createMockWebviewPanel(webview);
        
        // Ensure createWebviewPanel returns OUR mock
        (vscode.window.createWebviewPanel as sinon.SinonStub).returns(panel);

        const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        
        // Simulating opening a panel
        provider.openInPanel(videoUrl, 'Test Video', 10);
        
        // Verify state is kept
        expect(provider.activePanel).to.equal(panel);
        expect(provider._lastUrl).to.equal(videoUrl);
        expect(provider._lastTime).to.equal(10);

        // Update time via message to webview
        const messageHandler = webview.onDidReceiveMessage.getCall(0).args[0];
        await messageHandler({ type: 'timeUpdate', time: 150 });
        expect(provider._lastTime).to.equal(150);

        // Dispose the panel (simulate user closing tab)
        const disposeHandler = panel.onDidDispose.getCall(0).args[0];
        disposeHandler();

        // Verify it was saved to memento (timestampKey for 'dQw4w9WgXcQ')
        const timestamps = memento.get<Record<string, any>>(YouTubeViewProvider.timestampsKey, {});
        expect(timestamps['dQw4w9WgXcQ'].time).to.equal(150);
        
        // Verify activePanel was cleared
        expect(provider.activePanel).to.be.undefined;
    });

    it('should restore time correctly when a new view is resolved', async () => {
        const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        
        // Pre-fill history and timestamps
        await memento.update(YouTubeViewProvider.historyKey, [{ url: videoUrl }]);
        await memento.update(YouTubeViewProvider.timestampsKey, { 'dQw4w9WgXcQ': 123 });

        const webview = createMockWebview();
        const webviewView = createMockWebviewView(webview);

        // Simulate resolving the webview view
        provider.resolveWebviewView(webviewView as any, {} as any, {} as any);

        // Verify that the HTML contains the correct start time (from initialUrl)
        expect(webview.html).to.contain('start=123');
        expect(provider._lastTime).to.equal(123);
    });

    it('should synchronize time between tab and sidebar on hide', async () => {
        const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const panelWebview = createMockWebview();
        const panel = createMockWebviewPanel(panelWebview);
        (vscode.window.createWebviewPanel as sinon.SinonStub).returns(panel);

        // 1. Open in panel
        provider.openInPanel(videoUrl, 'Test Video', 50);
        
        // 2. Set up sidebar (not visible yet)
        const sidebarWebview = createMockWebview();
        const sidebar = createMockWebviewView(sidebarWebview);
        provider.resolveWebviewView(sidebar as any, {} as any, {} as any);
        
        // 3. Update time in panel
        const messageHandler = panelWebview.onDidReceiveMessage.getCall(0).args[0];
        await messageHandler({ type: 'timeUpdate', time: 200 });

        // 4. Hide the panel (simulate switching to another file)
        const viewStateHandler = panel.onDidChangeViewState.getCall(0).args[0];
        // Simulate panel becoming invisible
        (panel as any).visible = false;
        viewStateHandler();

        // 5. Verify sidebar state was updated in memory
        expect(provider._lastTime).to.equal(200);
        
        // 6. Verify sidebar was told to seek if it was visible
        (sidebar as any).visible = true; 
        viewStateHandler(); // Trigger hide again (sync logic is same)
        
        // Check if sidebar webview received the loadUrl message
        const lastCall = sidebarWebview.postMessage.lastCall;
        expect(lastCall.args[0].type).to.equal('loadUrl');
        expect(lastCall.args[0].startTime).to.equal(200);
    });
});
