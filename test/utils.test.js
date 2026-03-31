"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const utils_1 = require("../src/utils");
describe('YouTube Extension Utils', () => {
    describe('extractVideoId', () => {
        it('should extract ID from standard youtube.com URL', () => {
            (0, chai_1.expect)((0, utils_1.extractVideoId)('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).to.equal('dQw4w9WgXcQ');
        });
        it('should extract ID from youtu.be URL', () => {
            (0, chai_1.expect)((0, utils_1.extractVideoId)('https://youtu.be/dQw4w9WgXcQ')).to.equal('dQw4w9WgXcQ');
        });
        it('should extract ID from shorts URL', () => {
            (0, chai_1.expect)((0, utils_1.extractVideoId)('https://www.youtube.com/shorts/dQw4w9WgXcQ')).to.equal('dQw4w9WgXcQ');
        });
        it('should extract ID from embed URL', () => {
            (0, chai_1.expect)((0, utils_1.extractVideoId)('https://www.youtube.com/embed/dQw4w9WgXcQ')).to.equal('dQw4w9WgXcQ');
        });
        it('should return raw ID if it matches 11-char pattern', () => {
            (0, chai_1.expect)((0, utils_1.extractVideoId)('dQw4w9WgXcQ')).to.equal('dQw4w9WgXcQ');
        });
        it('should return undefined for invalid URLs', () => {
            (0, chai_1.expect)((0, utils_1.extractVideoId)('https://google.com')).to.be.undefined;
        });
    });
    describe('formatYoutubeUrl', () => {
        it('should format to embed URL', () => {
            const formatted = (0, utils_1.formatYoutubeUrl)('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 0, true, 0);
            (0, chai_1.expect)(formatted).to.contain('youtube.com/embed/dQw4w9WgXcQ');
            (0, chai_1.expect)(formatted).to.contain('autoplay=1');
        });
        it('should include start time', () => {
            const formatted = (0, utils_1.formatYoutubeUrl)('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 123, true, 0);
            (0, chai_1.expect)(formatted).to.contain('start=123');
        });
        it('should use proxy if port is provided', () => {
            const formatted = (0, utils_1.formatYoutubeUrl)('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 0, true, 1234);
            (0, chai_1.expect)(formatted).to.equal('http://127.0.0.1:1234/embed?v=dQw4w9WgXcQ&autoplay=1');
        });
    });
    describe('parseEntries', () => {
        it('should parse strings into HistoryEntry objects', () => {
            const raw = ['https://url1.com', 'https://url2.com'];
            const parsed = (0, utils_1.parseEntries)(raw);
            (0, chai_1.expect)(parsed).to.have.lengthOf(2);
            (0, chai_1.expect)(parsed[0].url).to.equal('https://url1.com');
        });
        it('should parse objects with title', () => {
            const raw = [{ url: 'https://url1.com', title: 'Title 1' }];
            const parsed = (0, utils_1.parseEntries)(raw);
            (0, chai_1.expect)(parsed[0].title).to.equal('Title 1');
        });
    });
});
//# sourceMappingURL=utils.test.js.map