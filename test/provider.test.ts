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

        await provider.loadUrl('v2', 0, true);

        // Active tab gets it
        expect(panelWebview.postMessage.calledWith(sinon.match({ type: 'loadUrl', autoplay: true }))).to.be.true;
        // Inactive sidebar does NOT get it
        expect(viewWebview.postMessage.calledWith(sinon.match({ type: 'loadUrl' }))).to.be.false;
    });
});

