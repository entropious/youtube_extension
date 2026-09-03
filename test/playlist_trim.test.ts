import { expect } from 'chai';
import { parsePlaylist, renderPlaylist, segmentAt } from '../src/ytproxy';

const playlistText = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:8',
    '#EXTINF:3.000000,',
    'https://example/seg0.ts',
    '#EXTINF:4.000000,',
    'https://example/seg1.ts',
    '#EXTINF:5.000000,',
    'https://example/seg2.ts',
    '#EXT-X-ENDLIST',
    ''
].join('\n');

describe('Trimming an HLS playlist', () => {
    describe('parsePlaylist', () => {
        it('keeps the header apart from the segments', () => {
            const playlist = parsePlaylist(playlistText);

            expect(playlist.header).to.deep.equal([
                '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-TARGETDURATION:8'
            ]);
            expect(playlist.segments.map(s => s.url)).to.deep.equal([
                'https://example/seg0.ts', 'https://example/seg1.ts', 'https://example/seg2.ts'
            ]);
        });

        it('reads the duration of each segment', () => {
            expect(parsePlaylist(playlistText).segments.map(s => s.duration)).to.deep.equal([3, 4, 5]);
        });

        it('leaves the end marker out, since a trimmed playlist writes its own', () => {
            expect(parsePlaylist(playlistText).header).to.not.include('#EXT-X-ENDLIST');
        });

        it('survives an empty or header-only playlist', () => {
            expect(parsePlaylist('').segments).to.be.empty;
            expect(parsePlaylist('#EXTM3U\n').segments).to.be.empty;
        });
    });

    describe('segmentAt', () => {
        const playlist = parsePlaylist(playlistText);

        it('finds the segment covering a moment, and where it begins', () => {
            expect(segmentAt(playlist, 0)).to.deep.equal({ index: 0, startsAt: 0 });
            expect(segmentAt(playlist, 2.9)).to.deep.equal({ index: 0, startsAt: 0 });
            expect(segmentAt(playlist, 3)).to.deep.equal({ index: 1, startsAt: 3 });
            expect(segmentAt(playlist, 6.5)).to.deep.equal({ index: 1, startsAt: 3 });
            expect(segmentAt(playlist, 7)).to.deep.equal({ index: 2, startsAt: 7 });
        });

        it('stops at the last segment when asked past the end', () => {
            expect(segmentAt(playlist, 9999).index).to.equal(2);
        });
    });

    describe('renderPlaylist', () => {
        it('starts the playlist at the requested segment', () => {
            const rendered = renderPlaylist(parsePlaylist(playlistText), 1);

            expect(rendered).to.not.contain('seg0.ts');
            expect(rendered).to.contain('seg1.ts');
            expect(rendered).to.contain('seg2.ts');
        });

        it('keeps the header and closes the playlist', () => {
            const rendered = renderPlaylist(parsePlaylist(playlistText), 2);

            expect(rendered.startsWith('#EXTM3U')).to.equal(true);
            expect(rendered).to.contain('#EXT-X-TARGETDURATION:8');
            expect(rendered.trim().endsWith('#EXT-X-ENDLIST')).to.equal(true);
        });

        it('keeps each segment paired with its own duration', () => {
            const rendered = renderPlaylist(parsePlaylist(playlistText), 1);
            const lines = rendered.trim().split('\n');

            expect(lines[lines.indexOf('https://example/seg1.ts') - 1]).to.equal('#EXTINF:4.000000,');
            expect(lines[lines.indexOf('https://example/seg2.ts') - 1]).to.equal('#EXTINF:5.000000,');
        });

        it('returns the whole playlist when nothing is trimmed', () => {
            const rendered = renderPlaylist(parsePlaylist(playlistText), 0);

            expect(rendered).to.contain('seg0.ts');
            expect(rendered.match(/#EXTINF/g)).to.have.length(3);
        });

        it('treats a negative index as the beginning', () => {
            expect(renderPlaylist(parsePlaylist(playlistText), -5)).to.contain('seg0.ts');
        });
    });
});
