import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';

describe('Webview Script', () => {
    let dom: JSDOM;
    let window: any;
    let document: Document;
    let vscodePostMessageStub: sinon.SinonStub;
    let vscodeSetStateStub: sinon.SinonStub;

    beforeEach(() => {
        const htmlPath = path.join(process.cwd(), 'src/webview/index.html');
        const scriptPath = path.join(process.cwd(), 'src/webview/script.js');
        
        let html = fs.readFileSync(htmlPath, 'utf8');
        let script = fs.readFileSync(scriptPath, 'utf8');

        // Clean up HTML (remove placeholders that are not needed for DOM structure or handled by script)
        html = html.replace('%%STYLE%%', '').replace('%%SCRIPT%%', '').replace('%%CSP%%', '');

        // Mock placeholders in script
        script = script
            .replace('%%INITIAL_URL_JSON%%', JSON.stringify('about:blank'))
            .replace('%%INITIAL_ORIGINAL_URL_JSON%%', JSON.stringify(''))
            .replace('%%PROXY_PORT_JSON%%', '0')
            .replace('%%AUTOPLAY_JSON%%', 'true')
            .replace('%%INITIAL_PLAYLIST_ID_JSON%%', 'null')
            .replace('%%INITIAL_PLAYLIST_TITLE_JSON%%', 'null')
            .replace('%%INITIAL_CAN_PREV_JSON%%', 'false')
            .replace('%%INITIAL_CHANNEL_URL_JSON%%', 'null')
            .replace('%%INITIAL_CHANNEL_NAME_JSON%%', 'null');

        vscodePostMessageStub = sinon.stub();
        vscodeSetStateStub = sinon.stub();
        
        dom = new JSDOM(html, {
            runScripts: "dangerously",
            url: "http://localhost/"
        });
        
        window = dom.window;
        document = window.document;

        // Mock VS Code API
        window.acquireVsCodeApi = () => ({
            postMessage: vscodePostMessageStub,
            getState: () => ({}),
            setState: vscodeSetStateStub
        });

        // Execute script
        const scriptElement = document.createElement('script');
        scriptElement.textContent = script;
        document.body.appendChild(scriptElement);
    });

    afterEach(() => {
        sinon.restore();
    });

    it('should initialize correctly with empty state', () => {
        const statusText = document.getElementById('status-text');
        expect(statusText?.textContent).to.equal('Ready');
        
        const emptyState = document.getElementById('empty-state');
        expect(emptyState?.style.display).to.not.equal('none');
    });

    describe('Utility Functions', () => {
        it('extractVideoId should handle various URL formats', () => {
            expect(window.extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).to.equal('dQw4w9WgXcQ');
            expect(window.extractVideoId('https://youtu.be/dQw4w9WgXcQ')).to.equal('dQw4w9WgXcQ');
            expect(window.extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).to.equal('dQw4w9WgXcQ');
            expect(window.extractVideoId('dQw4w9WgXcQ')).to.equal('dQw4w9WgXcQ');
            expect(window.extractVideoId('')).to.equal('');
        });

        it('normalizeInput should handle search and URLs', () => {
            expect(window.normalizeInput('https://youtube.com')).to.equal('https://youtube.com');
            expect(window.normalizeInput('youtube.com')).to.equal('https://youtube.com');
            expect(window.normalizeInput('lofi hip hop')).to.equal('lofi hip hop');
            expect(window.normalizeInput('  ')).to.equal('');
        });
    });

    describe('UI Interactions', () => {
        it('closeList should reset UI state', () => {
            const resultsContainer = document.getElementById('results-container')!;
            const closeListBtn = document.getElementById('close-list-btn')!;
            
            resultsContainer.style.display = 'flex';
            closeListBtn.style.display = 'flex';
            
            window.closeList();
            
            expect(resultsContainer.style.display).to.equal('none');
            expect(closeListBtn.style.display).to.equal('none');
        });

        it('loadVideo should post message to extension', () => {
            window.loadVideo('dQw4w9WgXcQ');
            expect(vscodePostMessageStub.calledWith(sinon.match({
                type: 'requestLoad',
                value: 'dQw4w9WgXcQ'
            }))).to.be.true;
        });

        it('should NOT close list when mouse moves from list to header', () => {
            const resultsContainer = document.getElementById('results-container')!;
            const header = document.querySelector('.header')!;
            const historyBtn = document.getElementById('history-btn')!;
            
            // Set pending state and dispatch message
            historyBtn.click();
            window.dispatchEvent(new window.MessageEvent('message', {
                data: { type: 'history', value: [{ url: 'https://youtube.com/watch?v=123', title: 'Test' }] }
            }));
            expect(resultsContainer.style.display).to.equal('flex');
            
            // Dispatch mouseleave on list, moving to header
            const event = new window.MouseEvent('mouseleave', { relatedTarget: header });
            resultsContainer.dispatchEvent(event);
            
            expect(resultsContainer.style.display).to.equal('flex'); // Should STAY open
        });

        it('should close list when mouse moves from header to elsewhere', () => {
            const resultsContainer = document.getElementById('results-container')!;
            const header = document.querySelector('.header')!;
            const historyBtn = document.getElementById('history-btn')!;
            
            // Show a list first
            historyBtn.click();
            window.dispatchEvent(new window.MessageEvent('message', {
                data: { type: 'history', value: [{ url: 'https://youtube.com/watch?v=123', title: 'Test' }] }
            }));
            expect(resultsContainer.style.display).to.equal('flex');
            
            // Dispatch mouseleave on header, moving to null (away)
            const event = new window.MouseEvent('mouseleave', { relatedTarget: null });
            header.dispatchEvent(event);
            
            expect(resultsContainer.style.display).to.equal('none'); // Should CLOSE
        });

        it('should NOT close list when mouse moves from header BACK to list', () => {
            const resultsContainer = document.getElementById('results-container')!;
            const header = document.querySelector('.header')!;
            const historyBtn = document.getElementById('history-btn')!;
            
            // Show a list first
            historyBtn.click();
            window.dispatchEvent(new window.MessageEvent('message', {
                data: { type: 'history', value: [{ url: 'https://youtube.com/watch?v=123', title: 'Test' }] }
            }));
            
            // Dispatch mouseleave on header, moving to results list
            const event = new window.MouseEvent('mouseleave', { relatedTarget: resultsContainer });
            header.dispatchEvent(event);
            
            expect(resultsContainer.style.display).to.equal('flex'); // Should STAY open
        });
    });

    describe('Message Handling', () => {
        it('should handle searchResults message', () => {
            const results = [{ id: '123', title: 'Test Video', thumbnail: 'thumb.jpg' }];
            const event = new window.MessageEvent('message', {
                data: { type: 'searchResults', results }
            });
            window.dispatchEvent(event);
            
            const resultsContainer = document.getElementById('results-container')!;
            expect(resultsContainer.style.display).to.equal('flex');
            expect(resultsContainer.innerHTML).to.contain('Test Video');
        });

        it('should handle channelUpdated message', () => {
            const event = new window.MessageEvent('message', {
                data: { 
                    type: 'channelUpdated', 
                    authorUrl: 'https://youtube.com/@test', 
                    authorName: 'Test Channel' 
                }
            });
            window.dispatchEvent(event);
            
            const channelBtn = document.getElementById('channel-btn')!;
            expect(channelBtn.style.display).to.equal('flex');
            expect(channelBtn.title).to.equal('Videos from Test Channel');
        });

        it('should handle moreSearchResults message without duplicating headers', () => {
            // First load some results (including a channel)
            const results1 = [
                { type: 'channel', id: 'UC123', title: 'First Channel', url: 'https://youtube.com/channel/UC123' },
                { type: 'video', id: '123', title: 'First Video', thumbnail: 'thumb1.jpg' }
            ];
            window.dispatchEvent(new window.MessageEvent('message', {
                data: { type: 'searchResults', results: results1 }
            }));
            
            const resultsContainer = document.getElementById('results-container')!;
            
            // Should contain channel and video
            expect(resultsContainer.innerHTML).to.contain('First Channel');
            expect(resultsContainer.innerHTML).to.contain('First Video');
            
            // Should contain ONE header
            let headers = resultsContainer.querySelectorAll('.list-header');
            expect(headers.length).to.equal(1);
            
            // Then append more results (should only be videos realistically, but we test the frontend behavior)
            const results2 = [{ type: 'video', id: '456', title: 'Second Video', thumbnail: 'thumb2.jpg' }];
            window.dispatchEvent(new window.MessageEvent('message', {
                data: { type: 'moreSearchResults', results: results2 }
            }));
            
            // Should contain all items
            expect(resultsContainer.innerHTML).to.contain('First Channel');
            expect(resultsContainer.innerHTML).to.contain('First Video');
            expect(resultsContainer.innerHTML).to.contain('Second Video');
            
            // Should STILL only contain ONE header
            headers = resultsContainer.querySelectorAll('.list-header');
            expect(headers.length).to.equal(1);
        });

        it('should handle favorites message and dispatch correct messages on click', () => {
            const favorites = [
                { type: 'video', url: 'https://www.youtube.com/watch?v=123', title: 'Video Fav' },
                { type: 'channel', url: 'https://www.youtube.com/channel/UC123', title: 'Channel Fav', thumbnail: 'channel.jpg' },
                { type: 'playlist', url: 'https://www.youtube.com/playlist?list=PL123', title: 'Playlist Fav' }
            ];
            
            // First, click favorites button to set the pending state and show container
            document.getElementById('favorites-btn')?.click();
            
            window.dispatchEvent(new window.MessageEvent('message', {
                data: { type: 'favorites', value: favorites }
            }));
            
            const resultsContainer = document.getElementById('results-container')!;
            expect(resultsContainer.innerHTML).to.contain('Video Fav');
            expect(resultsContainer.innerHTML).to.contain('Channel Fav');
            expect(resultsContainer.innerHTML).to.contain('Playlist Fav');
            
            const items = resultsContainer.querySelectorAll('.list-item');
            expect(items.length).to.equal(3);
            
            // 1. Test clicking a Video Favorite
            (items[0] as HTMLElement).click();
            expect(vscodePostMessageStub.calledWith(sinon.match({
                type: 'requestLoad',
                value: 'https://www.youtube.com/watch?v=123'
            }))).to.be.true;
            
            // 2. Test clicking a Channel Favorite (Verifies the fix for the typo)
            (items[1] as HTMLElement).click();
            expect(vscodePostMessageStub.calledWith(sinon.match({
                type: 'requestChannelVideos',
                url: 'https://www.youtube.com/channel/UC123',
                name: 'Channel Fav',
                thumbnail: 'channel.jpg'
            }))).to.be.true;
            
            // 3. Test clicking a Playlist Favorite
            (items[2] as HTMLElement).click();
            expect(vscodePostMessageStub.calledWith(sinon.match({
                type: 'requestPlaylist',
                url: 'https://www.youtube.com/playlist?list=PL123'
            }))).to.be.true;
        });
    });
});
