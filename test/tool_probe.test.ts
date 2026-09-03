import { expect } from 'chai';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import * as childProcess from 'child_process';
import { checkTools, invalidateStream, resolveStream, setToolConfig } from '../src/ytproxy';

/** A spawned process that reports what the test wants, then exits. */
function fakeProcess(options: { stdout?: string; stderr?: string; code?: number; error?: NodeJS.ErrnoException }) {
    const proc: any = new EventEmitter();
    proc.stdout = Readable.from(options.stdout ? [Buffer.from(options.stdout)] : []);
    proc.stderr = Readable.from(options.stderr ? [Buffer.from(options.stderr)] : []);
    proc.kill = sinon.stub();

    setImmediate(() => {
        if (options.error) {
            proc.emit('error', options.error);
            return;
        }
        // Give the reader a tick to drain both pipes before the exit lands.
        setImmediate(() => proc.emit('close', options.code ?? 0));
    });

    return proc;
}

const videoJson = JSON.stringify({
    duration: 100,
    title: 'Test video',
    url: 'https://example/stream.m3u8',
    http_headers: {}
});

describe('Tool probing and stream cache', () => {
    let spawn: sinon.SinonStub;

    beforeEach(() => {
        spawn = sinon.stub(childProcess, 'spawn');
        // Resets the cached tool report and any resolved stream.
        setToolConfig({ ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', maxHeight: 1080 });
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('checkTools', () => {
        it('reports both tools with the versions they print', async () => {
            spawn.withArgs('yt-dlp', ['--version']).callsFake(() => fakeProcess({ stdout: '2026.08.19\n' }));
            spawn.withArgs('ffmpeg', ['-version']).callsFake(() => fakeProcess({ stdout: 'ffmpeg version 8.1.1 Copyright (c)\nbuilt with\n' }));

            const report = await checkTools(true);

            expect(report.ready).to.equal(true);
            expect(report.ytDlp.version).to.equal('2026.08.19');
            expect(report.ffmpeg.version).to.equal('8.1.1');
            expect(report.recipes).to.be.empty;
        });

        it('reports a tool that is not installed, and offers how to get it', async () => {
            const missing: NodeJS.ErrnoException = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
            spawn.withArgs('yt-dlp', ['--version']).callsFake(() => fakeProcess({ error: missing }));
            spawn.withArgs('ffmpeg', ['-version']).callsFake(() => fakeProcess({ stdout: 'ffmpeg version 8.1.1\n' }));

            const report = await checkTools(true);

            expect(report.ready).to.equal(false);
            expect(report.ytDlp.installed).to.equal(false);
            expect(report.ffmpeg.installed).to.equal(true);
            expect(report.recipes.length).to.be.greaterThan(0);
            expect(report.recipes.every(r => r.command.includes('yt-dlp'))).to.equal(true);
        });

        it('treats a non-zero exit as missing, not as a version', async () => {
            spawn.callsFake(() => fakeProcess({ stdout: '', code: 127 }));

            const report = await checkTools(true);

            expect(report.ytDlp.installed).to.equal(false);
            expect(report.ffmpeg.installed).to.equal(false);
        });

        it('names the configured path, so a wrong setting is visible', async () => {
            setToolConfig({ ytDlpPath: '/opt/custom/yt-dlp' });
            spawn.callsFake(() => fakeProcess({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }));

            const report = await checkTools(true);

            expect(report.ytDlp.command).to.equal('/opt/custom/yt-dlp');
        });

        it('answers from cache until asked to refresh', async () => {
            spawn.callsFake(() => fakeProcess({ stdout: '2026.08.19\n' }));
            await checkTools(true);
            const callsAfterFirst = spawn.callCount;

            await checkTools();
            expect(spawn.callCount).to.equal(callsAfterFirst);

            await checkTools(true);
            expect(spawn.callCount).to.be.greaterThan(callsAfterFirst);
        });

        it('probes again once the configured paths change', async () => {
            spawn.callsFake(() => fakeProcess({ stdout: '2026.08.19\n' }));
            await checkTools();
            const before = spawn.callCount;

            setToolConfig({ ffmpegPath: '/usr/local/bin/ffmpeg' });
            await checkTools();

            expect(spawn.callCount).to.be.greaterThan(before);
        });
    });

    describe('resolveStream', () => {
        it('asks yt-dlp once and serves the rest from cache', async () => {
            spawn.callsFake(() => fakeProcess({ stdout: videoJson }));

            const first = await resolveStream('kJQP7kiw5Fk');
            const second = await resolveStream('kJQP7kiw5Fk');

            expect(spawn.callCount).to.equal(1);
            expect(second).to.deep.equal(first);
            expect(first.title).to.equal('Test video');
        });

        it('shares one lookup between requests that arrive together', async () => {
            spawn.callsFake(() => fakeProcess({ stdout: videoJson }));

            // The page fires /info and /media at the same moment.
            const [a, b] = await Promise.all([resolveStream('abcdefghijk'), resolveStream('abcdefghijk')]);

            expect(spawn.callCount).to.equal(1);
            expect(a).to.deep.equal(b);
        });

        it('resolves again after the entry is invalidated', async () => {
            spawn.callsFake(() => fakeProcess({ stdout: videoJson }));
            await resolveStream('M7lc1UVf-VE');

            invalidateStream('M7lc1UVf-VE');
            await resolveStream('M7lc1UVf-VE');

            expect(spawn.callCount).to.equal(2);
        });

        it('keeps separate entries per video', async () => {
            spawn.callsFake(() => fakeProcess({ stdout: videoJson }));

            await resolveStream('aaaaaaaaaaa');
            await resolveStream('bbbbbbbbbbb');

            expect(spawn.callCount).to.equal(2);
        });

        it('reports what yt-dlp complained about, without its ERROR prefix', async () => {
            spawn.callsFake(() => fakeProcess({ stderr: 'ERROR: [youtube] Video unavailable\n', code: 1 }));

            try {
                await resolveStream('ccccccccccc');
                expect.fail('a failed lookup must reject');
            } catch (e) {
                expect((e as Error).message).to.equal('[youtube] Video unavailable');
            }
        });

        it('does not cache a failed lookup', async () => {
            spawn.onFirstCall().callsFake(() => fakeProcess({ stderr: 'ERROR: temporary\n', code: 1 }));
            spawn.onSecondCall().callsFake(() => fakeProcess({ stdout: videoJson }));

            await resolveStream('ddddddddddd').catch(() => undefined);
            const info = await resolveStream('ddddddddddd');

            expect(spawn.callCount).to.equal(2);
            expect(info.title).to.equal('Test video');
        });

        it('says which tool is missing when yt-dlp cannot be started', async () => {
            spawn.callsFake(() => fakeProcess({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }));

            try {
                await resolveStream('eeeeeeeeeee');
                expect.fail('a missing tool must reject');
            } catch (e) {
                expect((e as Error).message).to.contain('yt-dlp');
                expect((e as Error).message).to.contain('was not found');
            }
        });

        it('asks yt-dlp for the format expression the settings describe', async () => {
            setToolConfig({ maxHeight: 720 });
            spawn.callsFake(() => fakeProcess({ stdout: videoJson }));

            await resolveStream('fffffffffff');

            const args: string[] = spawn.firstCall.args[1];
            expect(args[args.indexOf('-f') + 1]).to.contain('height<=720');
            expect(args).to.include('--no-playlist');
            expect(args[args.length - 1]).to.equal('https://www.youtube.com/watch?v=fffffffffff');
        });
    });
});
