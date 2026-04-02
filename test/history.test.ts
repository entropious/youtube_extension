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
});
