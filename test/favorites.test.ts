import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { YouTubeViewProvider } from '../src/provider';
import { MockMemento, createMockWebview, createMockWebviewView } from './mocks';

describe('YouTubeViewProvider Favorites', () => {
    let provider: YouTubeViewProvider;
    let memento: MockMemento;
    let extensionUri: any;

    beforeEach(() => {
        memento = new MockMemento();
        extensionUri = { fsPath: '/mock/path', toString: () => 'file:///mock/path' };
        provider = new YouTubeViewProvider(extensionUri as vscode.Uri, memento as any, () => 1234);
        
        // Mock global fetch
        (global as any).fetch = sinon.stub();
    });

    afterEach(() => {
        sinon.restore();
        delete (global as any).fetch;
    });

    it('should add a favorite with provided title', async () => {
        const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const title = 'Never Gonna Give You Up';

        await (provider as any)._saveFavorite(url, title);
        
        const favorites = provider._getFavorites();
        expect(favorites).to.have.lengthOf(1);
        expect(favorites[0].url).to.equal(url);
        expect(favorites[0].title).to.equal(title);
    });

    it('should resolve title from noembed if not provided when adding favorite', async () => {
        const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const resolvedTitle = 'Resolved Title';
        const mockHtml = `<html><body><script>var ytInitialData = {"contents": {"twoColumnWatchNextResults": {"results": {"results": {"contents": [{"videoPrimaryInfoRenderer": {"title": {"runs": [{"text": "${resolvedTitle}"}]}}}]}}}}};</script></body></html>`;

        (global.fetch as sinon.SinonStub).resolves({
            ok: true,
            text: async () => mockHtml
        });

        await (provider as any)._saveFavorite(url);
        
        const favorites = provider._getFavorites();
        expect(favorites).to.have.lengthOf(1);
        expect(favorites[0].title).to.equal(resolvedTitle);
        expect((global.fetch as sinon.SinonStub).calledOnce).to.be.true;
    });

    it('should NOT add duplicate favorites', async () => {
        const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        
        await (provider as any)._saveFavorite(url, 'Title 1');
        await (provider as any)._saveFavorite(url, 'Title 2');
        
        const favorites = provider._getFavorites();
        expect(favorites).to.have.lengthOf(1);
        expect(favorites[0].title).to.equal('Title 1'); // Keeps the first one
    });

    it('should remove a favorite', async () => {
        const url1 = 'https://url1.com';
        const url2 = 'https://url2.com';
        
        await (provider as any)._saveFavorite(url1, 'T1');
        await (provider as any)._saveFavorite(url2, 'T2');
        
        await (provider as any)._removeFavorite(url1);
        
        const favorites = provider._getFavorites();
        expect(favorites).to.have.lengthOf(1);
        expect(favorites[0].url).to.equal(url2);
    });

    it('should handle addFavorite message from webview', async () => {
        const webview = createMockWebview();
        const view = createMockWebviewView(webview);
        provider.resolveWebviewView(view as any, {} as any, {} as any);
        
        const handler = webview.onDidReceiveMessage.getCall(0).args[0];
        
        await handler({ 
            type: 'addFavorite', 
            url: 'https://new-fav.com', 
            title: 'New Fav' 
        });
        
        const favorites = provider._getFavorites();
        expect(favorites).to.have.lengthOf(1);
        expect(favorites[0].url).to.equal('https://new-fav.com');
        
        // Should broadcast updated favorites to all views
        expect(webview.postMessage.calledWith(sinon.match({ 
            type: 'favorites', 
            value: favorites 
        }))).to.be.true;
    });

    it('should handle removeFavorite message from webview', async () => {
        const url = 'https://fav.com';
        await (provider as any)._saveFavorite(url, 'Title');
        
        const webview = createMockWebview();
        const view = createMockWebviewView(webview);
        provider.resolveWebviewView(view as any, {} as any, {} as any);
        
        const handler = webview.onDidReceiveMessage.getCall(0).args[0];
        
        await handler({ type: 'removeFavorite', url });
        
        expect(provider._getFavorites()).to.be.empty;
        expect(webview.postMessage.calledWith(sinon.match({ 
            type: 'favorites', 
            value: [] 
        }))).to.be.true;
    });

    it('should save a channel favorite with correct type and thumbnail', async () => {
        const url = 'https://www.youtube.com/channel/UC123';
        const title = 'Test Channel';
        const thumbnail = 'https://thumb.com/photo.jpg';

        await (provider as any)._saveFavorite(url, title, 'channel', thumbnail);
        
        const favorites = provider._getFavorites();
        expect(favorites).to.have.lengthOf(1);
        expect(favorites[0].type).to.equal('channel');
        expect(favorites[0].thumbnail).to.equal(thumbnail);
    });

    it('should save a playlist favorite with correct type', async () => {
        const url = 'https://www.youtube.com/playlist?list=PL123';
        const title = 'Test Playlist';

        await (provider as any)._saveFavorite(url, title, 'playlist', 'https://mock-thumb.jpg');
        
        const favorites = provider._getFavorites();
        expect(favorites).to.have.lengthOf(1);
        expect(favorites[0].type).to.equal('playlist');
    });
});
