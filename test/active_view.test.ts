import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { YouTubeViewProvider } from '../src/provider';
import { MockMemento, createMockWebview, createMockWebviewPanel, createMockWebviewView } from './mocks';

describe('YouTubeViewProvider Active View Tracking', () => {
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

    it('should target playback commands only to the last active view', async () => {
        const sidebarWebview = createMockWebview();
        const sidebar = createMockWebviewView(sidebarWebview);
        
        const panelWebview = createMockWebview();
        const panel = createMockWebviewPanel(panelWebview);
        
        // 1. Resolve both
        provider.resolveWebviewView(sidebar as any, {} as any, {} as any);
        
        const sidebarHandler = sidebarWebview.onDidReceiveMessage.getCall(0).args[0];

        // Note: For panel, _setupWebviewHandlers is usually called in openInPanel. 
        // Let's call it manually for our mock setup if needed, or better, use openInPanel.
        (vscode.window.createWebviewPanel as sinon.SinonStub).returns(panel);
        provider.openInPanel('https://video1', 'Title 1');
        const realPanelHandler = panelWebview.onDidReceiveMessage.lastCall.args[0];

        // 2. Interaction with SIDEBAR
        await sidebarHandler({ type: 'timeUpdate', time: 10 });
        
        // 3. Send togglePlay from extension
        provider.togglePlay();
        
        // 4. Verify ONLY sidebar received it
        expect(sidebarWebview.postMessage.calledWith(sinon.match({ type: 'togglePlay' }))).to.be.true;
        expect(panelWebview.postMessage.calledWith(sinon.match({ type: 'togglePlay' }))).to.be.false;
        
        sidebarWebview.postMessage.resetHistory();
        panelWebview.postMessage.resetHistory();
        
        // 5. Interaction with PANEL
        await realPanelHandler({ type: 'timeUpdate', time: 20 });
        
        // 6. Send togglePlay from extension
        provider.togglePlay();
        
        // 7. Verify ONLY panel received it
        expect(panelWebview.postMessage.calledWith(sinon.match({ type: 'togglePlay' }))).to.be.true;
        expect(sidebarWebview.postMessage.calledWith(sinon.match({ type: 'togglePlay' }))).to.be.false;
    });

    it('should broadcast settings and state to ALL views', async () => {
        const sidebarWebview = createMockWebview();
        const sidebar = createMockWebviewView(sidebarWebview);
        const panelWebview = createMockWebview();
        const panel = createMockWebviewPanel(panelWebview);
        
        provider.resolveWebviewView(sidebar as any, {} as any, {} as any);
        (vscode.window.createWebviewPanel as sinon.SinonStub).returns(panel);
        provider.openInPanel('https://video1', 'Title 1');
        const panelHandler = panelWebview.onDidReceiveMessage.lastCall.args[0];

        // Simulate adding favorite from panel
        await panelHandler({ type: 'addFavorite', url: 'https://video2', title: 'Video 2' });
        
        // Verify BOTH received the favorites update
        expect(sidebarWebview.postMessage.calledWith(sinon.match({ type: 'favorites' }))).to.be.true;
        expect(panelWebview.postMessage.calledWith(sinon.match({ type: 'favorites' }))).to.be.true;

        sidebarWebview.postMessage.resetHistory();
        panelWebview.postMessage.resetHistory();

        // Simulate toggle autoplay from panel
        await panelHandler({ type: 'setAutoplay', value: false });
        
        // Verify BOTH received the autoplayUpdated broadcast
        expect(sidebarWebview.postMessage.calledWith(sinon.match({ type: 'autoplayUpdated', value: false }))).to.be.true;
        expect(panelWebview.postMessage.calledWith(sinon.match({ type: 'autoplayUpdated', value: false }))).to.be.true;
    });
});
