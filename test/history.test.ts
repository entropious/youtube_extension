import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { YouTubeViewProvider } from '../src/provider';
import { MockMemento } from './mocks';

describe('YouTubeViewProvider History', () => {
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

    it('should preserve title when saving URL without title if it already exists in history', async () => {
        const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const title = 'Never Gonna Give You Up';

        // 1. Save with title
        await (provider as any)._saveUrl(url, title);
        let history = (provider as any)._getHistory();
        expect(history[0].title).to.equal(title);

        // 2. Save WITHOUT title (e.g., immediate save on load)
        await (provider as any)._saveUrl(url);
        history = (provider as any)._getHistory();
        
        // SHOULD PRESERVE THE TITLE
        expect(history[0].title).to.equal(title);
        expect(history.length).to.equal(1);
    });

    it('should update title when a NEW title is provided', async () => {
        const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const oldTitle = 'Old Title';
        const newTitle = 'New Title';

        // 1. Save with old title
        await (provider as any)._saveUrl(url, oldTitle);
        
        // 2. Save with new title
        await (provider as any)._saveUrl(url, newTitle);
        
        const history = (provider as any)._getHistory();
        expect(history[0].title).to.equal(newTitle);
    });

    it('should remove an item from history', async () => {
        const url1 = 'https://url1.com';
        const url2 = 'https://url2.com';
        
        await (provider as any)._saveUrl(url1, 'T1');
        await (provider as any)._saveUrl(url2, 'T2');
        
        await (provider as any)._removeHistory(url1);
        
        const history = (provider as any)._getHistory();
        expect(history).to.have.lengthOf(1);
        expect(history[0].url).to.equal(url2);
    });

    it('should clear the entire history', async () => {
        await (provider as any)._saveUrl('https://url1.com', 'T1');
        await (provider as any)._saveUrl('https://url2.com', 'T2');
        
        await (provider as any)._clearHistory();
        
        const history = (provider as any)._getHistory();
        expect(history).to.be.empty;
    });

    it('should limit history to 50 items', async () => {
        for (let i = 0; i < 60; i++) {
            await (provider as any)._saveUrl(`https://url${i}.com`);
        }
        
        const history = (provider as any)._getHistory();
        expect(history).to.have.lengthOf(50);
        expect(history[0].url).to.equal('https://url59.com'); // Last added is first
        expect(history[49].url).to.equal('https://url10.com'); // url0-url9 should be evicted
    });
});


