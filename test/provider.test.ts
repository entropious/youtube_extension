import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { YouTubeViewProvider } from '../src/provider';
import { MockMemento, createMockWebview, createMockWebviewPanel, createMockWebviewView } from './mocks';

describe('YouTubeViewProvider Playback and Targeting', () => {
    let memento: MockMemento;
    let provider: YouTubeViewProvider;
    let extensionUri: any;
    let fsStub: sinon.SinonStub;

    beforeEach(() => {
        memento = new MockMemento();
        extensionUri = { fsPath: '/mock/path', toString: () => 'file:///mock/path' };
        provider = new YouTubeViewProvider(extensionUri as vscode.Uri, memento as any, () => 8080);

        fsStub = sinon.stub(fs, 'readFileSync');
        fsStub.withArgs(sinon.match(/index\.html/)).returns('<html>%%STYLE%% %%SCRIPT%% %%INITIAL_URL%%</html>');
        fsStub.withArgs(sinon.match(/style\.css/)).returns('/* mock style */');
        fsStub.withArgs(sinon.match(/script\.js/)).returns('/* mock script */ %%INITIAL_URL_JSON%% %%PROXY_PORT_JSON%%');
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should correctly target tab when openInPanel is called, even if sidebar was previously active', async () => {
        const viewWebview = createMockWebview();
        const view = createMockWebviewView(viewWebview);
        
        const panelWebview = createMockWebview();
        const panel = createMockWebviewPanel(panelWebview);
        
        provider.resolveWebviewView(view as any, {} as any, {} as any);
        const viewHandler = viewWebview.onDidReceiveMessage.getCall(0).args[0];
        
        // 1. Sidebar is active
        await viewHandler({ type: 'playbackStatus', status: 'playing' });
        
        // 2. Open tab (first time)
        (vscode.window.createWebviewPanel as sinon.SinonStub).returns(panel);
        provider.openInPanel('new_video', 'New Title');

        // 3. Verify tab got the video via HTML (not postMessage on first launch)
        expect(panelWebview.html).to.contain('new_video');

        // 4. Reset history and call again (re-opening existing)
        panelWebview.postMessage.resetHistory();
        provider.openInPanel('video_update', 'Updated Title');
        
        // 5. Verify tab got the loadUrl message this time
        expect(panelWebview.postMessage.calledWith(sinon.match({ 
            type: 'loadUrl', 
            originalUrl: 'video_update' 
        }))).to.be.true;

        // 6. Verify sidebar did NOT get the same load command
        expect(viewWebview.postMessage.calledWith(sinon.match({ type: 'loadUrl' }))).to.be.false;
    });

    it('should track active view on "active" message', async () => {
        const viewWebview = createMockWebview();
        const view = createMockWebviewView(viewWebview);
        
        const panelWebview = createMockWebview();
        const panel = createMockWebviewPanel(panelWebview);
        
        provider.resolveWebviewView(view as any, {} as any, {} as any);
        const viewHandler = viewWebview.onDidReceiveMessage.getCall(0).args[0];
        
        await viewHandler({ type: 'playbackStatus', status: 'playing' });
        provider.togglePlay();
        expect(viewWebview.postMessage.calledWith(sinon.match({ type: 'togglePlay' }))).to.be.true;

        (vscode.window.createWebviewPanel as sinon.SinonStub).returns(panel);
        provider.openInPanel('v1');
        const panelHandler = panelWebview.onDidReceiveMessage.getCall(0).args[0];

        await panelHandler({ type: 'playbackStatus', status: 'playing' });
        viewWebview.postMessage.resetHistory();
        provider.togglePlay();
        expect(panelWebview.postMessage.calledWith(sinon.match({ type: 'togglePlay' }))).to.be.true;
        expect(viewWebview.postMessage.calledWith(sinon.match({ type: 'togglePlay' }))).to.be.false;
    });

    it('should pause other instances when playback starts', async () => {
        const viewWebview = createMockWebview();
        const view = createMockWebviewView(viewWebview);
        const panelWebview = createMockWebview();
        const panel = createMockWebviewPanel(panelWebview);
        
        provider.resolveWebviewView(view as any, {} as any, {} as any);
        (vscode.window.createWebviewPanel as sinon.SinonStub).returns(panel);
        provider.openInPanel('v1');
        
        const viewHandler = viewWebview.onDidReceiveMessage.getCall(0).args[0];
        const panelHandler = panelWebview.onDidReceiveMessage.getCall(0).args[0];

        await panelHandler({ type: 'playbackStatus', status: 'playing' });
        expect(viewWebview.postMessage.calledWith(sinon.match({ type: 'pause' }))).to.be.true;

        viewWebview.postMessage.resetHistory();
        await viewHandler({ type: 'playbackStatus', status: 'playing' });
        expect(panelWebview.postMessage.calledWith(sinon.match({ type: 'pause' }))).to.be.true;
    });

    it('should only autoplay in active view in loadUrl', async () => {
        const viewWebview = createMockWebview();
        const view = createMockWebviewView(viewWebview);
        const panelWebview = createMockWebview();
        const panel = createMockWebviewPanel(panelWebview);
        
        provider.resolveWebviewView(view as any, {} as any, {} as any);
        (vscode.window.createWebviewPanel as sinon.SinonStub).returns(panel);
        provider.openInPanel('v1');

        const panelHandler = panelWebview.onDidReceiveMessage.getCall(0).args[0];
        await panelHandler({ type: 'playbackStatus', status: 'playing' });

        await provider.loadUrl('v2', 0, 'tab');

        // Active tab gets it
        expect(panelWebview.postMessage.calledWith(sinon.match({ type: 'loadUrl', autoplay: true }))).to.be.true;
        // Inactive sidebar does NOT get it
        expect(viewWebview.postMessage.calledWith(sinon.match({ type: 'loadUrl' }))).to.be.false;
    });

    it('should correctly initialize restored (deserialized) panels', async () => {
        const panelWebview = createMockWebview();
        const panel = createMockWebviewPanel(panelWebview);
        
        const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        
        // Simulate restoration
        provider._setupTabPanel(panel as any, videoUrl, 'Restored Title', 123);

        // 1. Verify HTML is set
        expect(panelWebview.html).to.contain('dQw4w9WgXcQ');
        expect(panelWebview.html).to.contain('start=123');

        // 2. Verify handlers are set (should respond to messages)
        const panelHandler = panelWebview.onDidReceiveMessage.getCall(0).args[0];
        expect(panelHandler).to.be.a('function');

        // 3. Verify disposal logic is set
        const disposeHandler = panel.onDidDispose.getCall(0).args[0];
        expect(disposeHandler).to.be.a('function');

        // Trigger disposal and verify _tabPanel is cleared
        disposeHandler();
        expect(provider._tabPanel).to.be.undefined;
    });

    describe('Loading and State Management', () => {
        beforeEach(() => {
            (global as any).fetch = sinon.stub();
        });

        afterEach(() => {
            delete (global as any).fetch;
        });

        it('should resolve title and update history, favorites and webview title', async () => {
            const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
            const title = 'Never Gonna Give You Up';
            const mockHtml = `<html><body><script>var ytInitialData = {"contents": {"twoColumnWatchNextResults": {"results": {"results": {"contents": [{"videoPrimaryInfoRenderer": {"title": {"runs": [{"text": "${title}"}]}}}]}}}}};</script></body></html>`;
            
            (global.fetch as sinon.SinonStub).resolves({
                ok: true,
                text: async () => mockHtml
            });

            provider._lastUrl = url;
            const panelWebview = createMockWebview();
            const panel = createMockWebviewPanel(panelWebview);
            provider._tabPanel = panel as any;

            await provider._handleLoadRequest(url);

            expect(provider._getHistory()[0].title).to.equal(title);
            expect(panel.title).to.equal(title);
        });

        it('should save current timestamp to memento', async () => {
            provider._lastUrl = 'https://youtube.com/watch?v=vid12345678'; // 11 chars
            provider._lastTime = 150;
            await provider.saveCurrentState();
            const timestamps = memento.get<Record<string, any>>(YouTubeViewProvider.timestampsKey, {});
            expect(timestamps['vid12345678'].time).to.equal(150);
        });

        it('should load last video without autoplay on restore', async () => {
            const vid = 'dQw4w9WgXcQ';
            await memento.update(YouTubeViewProvider.historyKey, [vid]);
            await memento.update(YouTubeViewProvider.timestampsKey, { [vid]: { time: 50 } });
            
            const webview = createMockWebview();
            const webviewView = createMockWebviewView(webview);
            fsStub.withArgs(sinon.match(/index\.html/)).returns('<html>%%INITIAL_URL%%</html>');

            provider.resolveWebviewView(webviewView as any, {} as any, {} as any);
            expect(provider._lastUrl).to.equal(vid);
            expect(provider._lastTime).to.equal(50);
        });
    });

    describe('Webview Handlers', () => {
        it('should drop timeUpdate from non-current video', async () => {
            const webview = createMockWebview();
            const view = createMockWebviewView(webview);
            provider.resolveWebviewView(view as any, {} as any, {} as any);
            const handler = webview.onDidReceiveMessage.getCall(0).args[0];
            
            provider._lastUrl = 'dQw4w9WgXcQ';
            provider._lastTime = 0;
            
            await handler({ type: 'timeUpdate', url: 'anotherId123', time: 100 });
            expect(provider._lastTime).to.equal(0);
            
            await handler({ type: 'timeUpdate', url: 'dQw4w9WgXcQ', time: 100 });
            expect(provider._lastTime).to.equal(100);
        });

        it('should handle setAutoplay message', async () => {
            const webview = createMockWebview();
            const view = createMockWebviewView(webview);
            provider.resolveWebviewView(view as any, {} as any, {} as any);
            const handler = webview.onDidReceiveMessage.getCall(0).args[0];
            
            await handler({ type: 'setAutoplay', value: false });
            expect(memento.get(YouTubeViewProvider.autoplayKey)).to.be.false;
            expect(webview.postMessage.calledWith(sinon.match({ type: 'autoplayUpdated', value: false }))).to.be.true;
        });

        it('should handle openExternal message', async () => {
            const webview = createMockWebview();
            const view = createMockWebviewView(webview);
            provider.resolveWebviewView(view as any, {} as any, {} as any);
            const handler = webview.onDidReceiveMessage.getCall(0).args[0];
            
            const openInPanelSpy = sinon.spy(provider, 'openInPanel');
            await handler({ type: 'openExternal', url: 'v1', title: 'T1', time: 50 });
            expect(openInPanelSpy.calledWith('v1', 'T1', 50)).to.be.true;
        });
    });

    describe('Manual Pause Syncing', () => {
        it('should set _isManualPause to true when active view is paused', async () => {
            const webview = createMockWebview();
            const view = createMockWebviewView(webview);
            provider.resolveWebviewView(view as any, {} as any, {} as any);
            
            const handler = webview.onDidReceiveMessage.getCall(0).args[0];
            
            // 1. Start playing to reset pause state and set active view
            await handler({ type: 'playbackStatus', status: 'playing' });
            expect((provider as any)._isManualPause).to.be.false;
            expect((provider as any)._isTabActive).to.be.false; // sidebar view is reported as isTab=false

            // 2. Pause the active view
            await handler({ type: 'playbackStatus', status: 'paused' });
            expect((provider as any)._isManualPause).to.be.true;
        });

        it('should reset _isManualPause to false when playing starts', async () => {
            (provider as any)._isManualPause = true;
            const webview = createMockWebview();
            const view = createMockWebviewView(webview);
            provider.resolveWebviewView(view as any, {} as any, {} as any);
            const handler = webview.onDidReceiveMessage.getCall(0).args[0];

            await handler({ type: 'playbackStatus', status: 'playing' });
            expect((provider as any)._isManualPause).to.be.false;
        });

        it('should NOT set _isManualPause when inactive view is paused', async () => {
            const webview = createMockWebview();
            const view = createMockWebviewView(webview);
            provider.resolveWebviewView(view as any, {} as any, {} as any);
            const handler = webview.onDidReceiveMessage.getCall(0).args[0];

            // Set Tab as active
            (provider as any)._isTabActive = true;
            
            // Send pause from Sidebar
            await handler({ type: 'playbackStatus', status: 'paused' });
            expect((provider as any)._isManualPause).to.be.false;
        });

        it('should disable autoplay when switching same video while manually paused', async () => {
            const url = 'https://youtube.com/watch?v=123';
            
            const webview = createMockWebview();
            const view = createMockWebviewView(webview);
            provider.resolveWebviewView(view as any, {} as any, {} as any);
            
            (provider as any)._lastUrl = url;
            (provider as any)._isManualPause = true;
            (provider as any)._sidebarHasInteracted = true;
            
            // Call loadUrl for the same video in sidebar
            await provider.loadUrl(url, 0, 'sidebar');
            
            const message = webview.postMessage.lastCall.args[0];
            expect(message.type).to.equal('loadUrl');
            expect(message.autoplay).to.be.false;
        });

        it('should enable autoplay for new video even if previously manually paused', async () => {
            const oldUrl = 'https://youtube.com/watch?v=123';
            const newUrl = 'https://youtube.com/watch?v=456';
            
            const webview = createMockWebview();
            const view = createMockWebviewView(webview);
            provider.resolveWebviewView(view as any, {} as any, {} as any);

            (provider as any)._lastUrl = oldUrl;
            (provider as any)._isManualPause = true;
            (provider as any)._sidebarHasInteracted = true;
            
            await provider.loadUrl(newUrl, 0, 'sidebar');
            
            const message = webview.postMessage.lastCall.args[0];
            expect(message.autoplay).to.be.true;
        });
    });
});


