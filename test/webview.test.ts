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
        const htmlPath = path.join(__dirname, '../src/webview/index.html');
        const scriptPath = path.join(__dirname, '../src/webview/script.js');
        
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
    });
});
