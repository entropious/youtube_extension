import { expect } from 'chai';
import { explain, ffmpegArgs, formatSelector, parseStreamInfo, StreamInfo } from '../src/ytproxy';

const hlsPair = {
    duration: 282,
    title: 'Despacito',
    requested_formats: [
        { url: 'https://example/video.m3u8', http_headers: { 'User-Agent': 'Chrome/145' } },
        { url: 'https://example/audio.m3u8', http_headers: { 'User-Agent': 'Chrome/145' } }
    ]
};

const combined = {
    duration: 213,
    title: 'Never Gonna Give You Up',
    url: 'https://example/progressive.mp4',
    http_headers: { 'User-Agent': 'Chrome/145', Referer: 'https://www.youtube.com/' }
};

describe('Stream resolution', () => {
    describe('formatSelector', () => {
        it('prefers a combined HLS rendition over every other format', () => {
            const alternatives = formatSelector(1080).split('/');

            expect(alternatives[0]).to.equal('b[protocol^=m3u8][vcodec^=avc1][acodec!=none][height<=1080]');
            expect(alternatives[1]).to.contain('protocol^=m3u8').and.contain('+ba');
        });

        it('keeps the direct googlevideo formats as a last resort', () => {
            const alternatives = formatSelector(720);

            // ffmpeg cannot read those links reliably, so nothing may rank them
            // above HLS.
            const hlsAt = alternatives.indexOf('m3u8');
            const progressiveAt = alternatives.indexOf('protocol=https');
            expect(hlsAt).to.be.lessThan(progressiveAt);
            expect(alternatives.endsWith('/b')).to.equal(true);
        });

        it('caps every height-bound alternative at the configured maximum', () => {
            expect(formatSelector(480)).to.contain('height<=480').and.not.contain('height<=1080');
        });
    });

    describe('parseStreamInfo', () => {
        it('reads a video+audio pair as two parts, video first', () => {
            const info = parseStreamInfo(hlsPair);

            expect(info.parts.map(p => p.url)).to.deep.equal([
                'https://example/video.m3u8',
                'https://example/audio.m3u8'
            ]);
            expect(info.duration).to.equal(282);
            expect(info.title).to.equal('Despacito');
        });

        it('reads a combined format from the top level', () => {
            const info = parseStreamInfo(combined);

            expect(info.parts).to.have.length(1);
            expect(info.parts[0].url).to.equal('https://example/progressive.mp4');
            expect(info.parts[0].headers.Referer).to.equal('https://www.youtube.com/');
        });

        it('treats a live stream as playable with unknown duration', () => {
            const info = parseStreamInfo({ url: 'https://example/live.m3u8', duration: null, title: 'Live' });

            expect(info.duration).to.equal(0);
        });

        it('refuses a response without a usable url', () => {
            expect(() => parseStreamInfo({ duration: 10, title: 'No formats' })).to.throw(/no playable format/);
            expect(() => parseStreamInfo({ requested_formats: [{ format_id: '137' }] })).to.throw(/no playable format/);
        });

        it('defaults missing headers to an empty set', () => {
            const info = parseStreamInfo({ url: 'https://example/a.mp4' });

            expect(info.parts[0].headers).to.deep.equal({});
        });
    });

    describe('ffmpegArgs', () => {
        const pair: StreamInfo = parseStreamInfo(hlsPair);
        const single: StreamInfo = parseStreamInfo(combined);

        it('copies the video and re-encodes audio to MP3', () => {
            const args = ffmpegArgs(single).join(' ');

            // The VS Code build decodes H.264 and MP3 only.
            expect(args).to.contain('-c:v copy');
            expect(args).to.contain('-c:a libmp3lame');
            expect(args).to.contain('-f mp4 pipe:1');
        });

        it('produces fragmented MP4, which can be streamed as it is written', () => {
            expect(ffmpegArgs(single).join(' ')).to.contain('-movflags frag_keyframe+empty_moov+default_base_moof');
        });

        it('takes audio from the second input of a pair', () => {
            const args = ffmpegArgs(pair);

            expect(args.filter(a => a === '-i')).to.have.length(2);
            expect(args[args.indexOf('-map') + 1]).to.equal('0:v:0');
            expect(args[args.lastIndexOf('-map') + 1]).to.equal('1:a:0');
        });

        it('takes audio from the same input of a combined format, tolerating its absence', () => {
            const args = ffmpegArgs(single);

            expect(args.filter(a => a === '-i')).to.have.length(1);
            expect(args[args.lastIndexOf('-map') + 1]).to.equal('0:a:0?');
        });

        it('seeks by opening every input at the offset, so a pair stays in sync', () => {
            const args = ffmpegArgs(pair, 150);

            expect(args.filter(a => a === '-ss')).to.have.length(2);
            // Each -ss must come before its own -i, or ffmpeg decodes from zero.
            args.forEach((arg, i) => {
                if (arg === '-ss') expect(args[i + 2]).to.equal('-i');
            });
        });

        it('leaves out seeking when playback starts at the beginning', () => {
            expect(ffmpegArgs(pair, 0)).to.not.include('-ss');
        });

        it('passes the headers yt-dlp expects, since the CDN checks them', () => {
            const args = ffmpegArgs(single);

            expect(args[args.indexOf('-user_agent') + 1]).to.equal('Chrome/145');
            expect(args[args.indexOf('-headers') + 1]).to.contain('Referer: https://www.youtube.com/');
        });
    });

    describe('explain', () => {
        it('turns YouTube bot checks into advice that leads somewhere', () => {
            const message = explain('ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser');

            expect(message).to.contain('anonymous session');
            expect(message).to.contain('yt-dlp');
            expect(message).to.not.contain('--cookies-from-browser');
        });

        it('strips the documentation trail from availability errors', () => {
            const message = explain('Video unavailable. This video is not available.\n  See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ for more');

            expect(message).to.equal('Video unavailable. This video is not available.');
        });

        it('passes anything else through untouched', () => {
            expect(explain('ffmpeg exited with code 1')).to.equal('ffmpeg exited with code 1');
        });
    });
});
