import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { YouTubeViewProvider } from '../src/provider';
import { MockMemento, createMockWebview, createMockWebviewView } from './mocks';

describe('YouTubeViewProvider Centralized Playback Logic', () => {
    let provider: YouTubeViewProvider;
    let memento: MockMemento;
    let extensionUri: any;

    beforeEach(() => {
        memento = new MockMemento();
        extensionUri = { fsPath: '/mock/path', toString: () => 'file:///mock/path' };
        provider = new YouTubeViewProvider(extensionUri as vscode.Uri, memento as any, () => 1234);
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should find next video on videoEnded when autoplay is ENABLED', async () => {
        const webview = createMockWebview();
        const webviewView = createMockWebviewView(webview);
        
        // 1. Enable autoplay in extension memento
        await memento.update(YouTubeViewProvider.autoplayKey, true);
        
        // 2. Mock _fetchRelated
        const fetchStub = sinon.stub(provider as any, '_fetchRelated').resolves(['auto_next_id']);
        
        provider.resolveWebviewView(webviewView as any, {} as any, {} as any);
        const messageHandler = webview.onDidReceiveMessage.getCall(0).args[0];
        
        // 3. Simulate videoEnded
        await messageHandler({ type: 'videoEnded', videoId: 'current_id' });
        
        // 4. Verify extension responded with loadUrl
        expect(fetchStub.calledOnce).to.be.true;
        const lastCall = webview.postMessage.lastCall;
        expect(lastCall.args[0].type).to.equal('loadUrl');
        expect(lastCall.args[0].originalUrl).to.contain('auto_next_id');
    });

    it('should NOT find next video on videoEnded when autoplay is DISABLED', async () => {
        const webview = createMockWebview();
        const webviewView = createMockWebviewView(webview);
        
        // 1. Disable autoplay in extension memento
        await memento.update(YouTubeViewProvider.autoplayKey, false);
        
        // 2. Mock _fetchRelated
        const fetchStub = sinon.stub(provider as any, '_fetchRelated').resolves(['should_not_load_id']);
        
        provider.resolveWebviewView(webviewView as any, {} as any, {} as any);
        const messageHandler = webview.onDidReceiveMessage.getCall(0).args[0];
        
        // 3. Simulate videoEnded
        await messageHandler({ type: 'videoEnded', videoId: 'current_id' });
        
        // 4. Verify extension did NOT respond with loadUrl
        expect(fetchStub.called).to.be.false;
        // The only postMessage would be the initial loadUrl during resolve if there was history
        // But specifically after videoEnded, no new loadUrl should be sent.
        const calls = webview.postMessage.getCalls();
        const hasLoadUrlAfterEnd = calls.some(c => c.args[0].type === 'loadUrl' && c.args[0].originalUrl?.includes('should_not_load_id'));
        expect(hasLoadUrlAfterEnd).to.be.false;
    });

    it('should find next video on requestNextVideo (MANUAL) even if autoplay is DISABLED', async () => {
        const webview = createMockWebview();
        const webviewView = createMockWebviewView(webview);
        
        // 1. Disable autoplay
        await memento.update(YouTubeViewProvider.autoplayKey, false);
        
        // 2. Mock _fetchRelated
        const fetchStub = sinon.stub(provider as any, '_fetchRelated').resolves(['manual_next_id']);
        
        provider.resolveWebviewView(webviewView as any, {} as any, {} as any);
        const messageHandler = webview.onDidReceiveMessage.getCall(0).args[0];
        
        // 3. Simulate manual requestNextVideo
        await messageHandler({ type: 'requestNextVideo', videoId: 'current_id', manual: true });
        
        // 4. Verify extension responded
        expect(fetchStub.calledOnce).to.be.true;
        const lastCall = webview.postMessage.lastCall;
        expect(lastCall.args[0].type).to.equal('loadUrl');
        expect(lastCall.args[0].originalUrl).to.contain('manual_next_id');
    });

    it('should update autoplay setting in extension memento', async () => {
        const webview = createMockWebview();
        const webviewView = createMockWebviewView(webview);
        provider.resolveWebviewView(webviewView as any, {} as any, {} as any);
        const messageHandler = webview.onDidReceiveMessage.getCall(0).args[0];
        
        // Simulate changing checkbox to OFF
        await messageHandler({ type: 'setAutoplay', value: false });
        expect(memento.get(YouTubeViewProvider.autoplayKey)).to.be.false;
        
        // Simulate changing checkbox to ON
        await messageHandler({ type: 'setAutoplay', value: true });
        expect(memento.get(YouTubeViewProvider.autoplayKey)).to.be.true;
    });
});
