import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { YouTubeViewProvider } from '../src/provider';
import { MockMemento } from './mocks';

describe('YouTubeViewProvider Search and URL Resolution', () => {
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

    describe('resolveUrl', () => {
        it('should return empty string for empty input', async () => {
            expect(await provider.resolveUrl('')).to.equal('');
        });

        it('should return original URL if it starts with http', async () => {
            const url = 'https://google.com';
            expect(await provider.resolveUrl(url)).to.equal(url);
        });

        it('should return youtube URL for 11-char ID', async () => {
            const id = 'dQw4w9WgXcQ';
            expect(await provider.resolveUrl(id)).to.contain('youtube.com/watch?v=' + id);
        });

        it('should prefix https:// if input looks like a domain', async () => {
            expect(await provider.resolveUrl('example.com')).to.equal('https://example.com');
        });

        it('should perform search if input has spaces', async () => {
            const query = 'rick roll';
            const searchStub = sinon.stub(provider as any, '_searchVideos').resolves([{ id: 'dQw4w9WgXcQ' }]);
            
            const resolved = await provider.resolveUrl(query);
            expect(resolved).to.contain('dQw4w9WgXcQ');
        });
    });

    describe('_searchVideos', () => {
        it('should parse ytInitialData from search results page', async () => {
            const mockData = {
                "contents": {
                    "twoColumnSearchResultsRenderer": {
                        "primaryContents": {
                            "sectionListRenderer": {
                                "contents": [
                                    {
                                        "itemSectionRenderer": {
                                            "contents": [
                                                {
                                                    "videoRenderer": {
                                                        "videoId": "dQw4w9WgXcQ",
                                                        "title": { "runs": [{ "text": "Title 1" }] },
                                                        "thumbnail": { "thumbnails": [{ "url": "thumb1" }] }
                                                    }
                                                }
                                            ]
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }
            };
            const mockHtml = `<html><body><script>var ytInitialData = ${JSON.stringify(mockData)};</script></body></html>`;

            (global.fetch as sinon.SinonStub).resolves({
                text: async () => mockHtml
            });

            const results = await (provider as any)._searchVideos('test');
            expect(results).to.have.lengthOf(1);
            expect(results[0].id).to.equal('dQw4w9WgXcQ');
        });


        it('should fallback to regex parsing if JSON fails', async () => {
            // Regex expects 11-char ID and title
            const mockHtml = `<html><body>
                "videoId":"dQw4w9WgXcQ","title":{"runs":[{"text":"Title 2"}]}
            </body></html>`;

            (global.fetch as sinon.SinonStub).resolves({
                text: async () => mockHtml
            });

            const results = await (provider as any)._searchVideos('test');
            expect(results).to.have.lengthOf(1);
            expect(results[0].id).to.equal('dQw4w9WgXcQ');
            expect(results[0].title).to.equal('Title 2');
        });


        it('should return empty array on failure', async () => {
            (global.fetch as sinon.SinonStub).rejects(new Error('Network error'));
            const results = await (provider as any)._searchVideos('test');
            expect(results).to.be.empty;
        });
    });

    describe('_fetchRelated', () => {
        it('should extract video IDs from watch page HTML', async () => {
            const mockHtml = `<html><body>
                "videoId":"v1234567890","videoId":"v0987654321","videoId":"v1234567890"
            </body></html>`;

            (global.fetch as sinon.SinonStub).resolves({
                text: async () => mockHtml
            });

            const results = await (provider as any)._fetchRelated('current_id');
            // Should contain both, deduped, and filtered (if current_id was there)
            expect(results).to.have.members(['v1234567890', 'v0987654321']);
            expect(results).to.have.lengthOf(2);
        });

        it('should return empty array on fetch failure', async () => {
            (global.fetch as sinon.SinonStub).rejects();
            const results = await (provider as any)._fetchRelated('id');
            expect(results).to.be.empty;
        });
    });
});

