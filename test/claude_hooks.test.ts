import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The hook module resolves its paths from the home directory when it loads, so
 * each test gets a throwaway home and a freshly required copy of the module —
 * the real ~/.claude is never touched.
 */
function loadHooks(home: string) {
    sinon.restore();
    sinon.stub(os, 'homedir').returns(home);
    delete require.cache[require.resolve('../src/claudeHooks')];
    return require('../src/claudeHooks');
}

describe('Claude Code hooks', () => {
    let home: string;
    let hooks: any;
    let settingsFile: string;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-panel-home-'));
        settingsFile = path.join(home, '.claude', 'settings.json');
        hooks = loadHooks(home);
    });

    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../src/claudeHooks')];
        fs.rmSync(home, { recursive: true, force: true });
    });

    const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

    describe('installHooks', () => {
        it('registers a hook for every event playback depends on', () => {
            hooks.installHooks();

            const events = Object.keys(readSettings().hooks);
            expect(events).to.have.members([
                'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
                'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'
            ]);
        });

        it('writes busy while Claude works and idle when it waits', () => {
            hooks.installHooks();
            const registered = readSettings().hooks;
            const commandFor = (event: string) => registered[event][0].hooks[0].command;

            expect(commandFor('UserPromptSubmit')).to.contain(' busy');
            expect(commandFor('PreToolUse')).to.contain(' busy');
            // Fires when a tool actually runs, which resumes playback after a
            // permission prompt was answered.
            expect(commandFor('PostToolUse')).to.contain(' busy');
            expect(commandFor('Stop')).to.contain(' idle');
            expect(commandFor('PermissionRequest')).to.contain(' idle');
            expect(commandFor('SessionEnd')).to.contain(' idle');
        });

        it('creates an executable script and an initial state', () => {
            hooks.installHooks();

            const script = fs.readFileSync(hooks.hookScript, 'utf8');
            expect(script).to.contain('#!/bin/sh');
            // Written through a temporary file, so a watcher never reads half a word.
            expect(script).to.contain('.tmp');
            expect(script).to.contain('mv');
            expect(fs.statSync(hooks.hookScript).mode & 0o111).to.be.greaterThan(0);
            expect(hooks.readState()).to.equal('idle');
        });

        it('leaves hooks written by the user alone', () => {
            fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
            fs.writeFileSync(settingsFile, JSON.stringify({
                hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node notify.js' }] }] },
                permissions: { allow: ['Bash(ls)'] }
            }));

            hooks.installHooks();

            const settings = readSettings();
            expect(settings.hooks.Stop.some((e: any) => e.hooks[0].command === 'node notify.js')).to.equal(true);
            expect(settings.hooks.Stop).to.have.length(2);
            expect(settings.permissions.allow).to.deep.equal(['Bash(ls)']);
        });

        it('does not pile up duplicates when installed twice', () => {
            hooks.installHooks();
            hooks.installHooks();

            expect(readSettings().hooks.Stop).to.have.length(1);
        });

        it('works when the user has no settings file at all', () => {
            expect(fs.existsSync(settingsFile)).to.equal(false);

            hooks.installHooks();

            expect(hooks.hooksInstalled()).to.equal(true);
        });
    });

    describe('uninstallHooks', () => {
        it('removes what it added and nothing else', () => {
            fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
            fs.writeFileSync(settingsFile, JSON.stringify({
                hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node notify.js' }] }] }
            }));
            hooks.installHooks();

            hooks.uninstallHooks();

            const settings = readSettings();
            expect(settings.hooks.Stop).to.have.length(1);
            expect(settings.hooks.Stop[0].hooks[0].command).to.equal('node notify.js');
            expect(hooks.hooksInstalled()).to.equal(false);
        });

        it('drops an event that held only our hook, instead of leaving it empty', () => {
            hooks.installHooks();

            hooks.uninstallHooks();

            expect(readSettings().hooks.PreToolUse).to.equal(undefined);
        });

        it('is harmless when nothing was installed', () => {
            fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
            fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: [] } }));

            expect(() => hooks.uninstallHooks()).to.not.throw();
            expect(readSettings().permissions).to.deep.equal({ allow: [] });
        });
    });

    describe('hooksInstalled', () => {
        it('is false while a single event is still missing', () => {
            hooks.installHooks();
            const settings = readSettings();
            delete settings.hooks.PostToolUse;
            fs.writeFileSync(settingsFile, JSON.stringify(settings));

            expect(hooks.hooksInstalled()).to.equal(false);
        });

        it('survives a settings file that is not valid JSON', () => {
            fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
            fs.writeFileSync(settingsFile, '{ broken');

            expect(hooks.hooksInstalled()).to.equal(false);
        });
    });

    describe('readState', () => {
        it('reads what the hook script writes', () => {
            hooks.writeHookScript();

            fs.writeFileSync(hooks.stateFile, 'busy');
            expect(hooks.readState()).to.equal('busy');

            fs.writeFileSync(hooks.stateFile, 'idle\n');
            expect(hooks.readState()).to.equal('idle');
        });

        it('falls back to idle on anything unreadable or unexpected', () => {
            expect(hooks.readState()).to.equal('idle');

            hooks.writeHookScript();
            fs.writeFileSync(hooks.stateFile, 'nonsense');
            expect(hooks.readState()).to.equal('idle');
        });

        it('reports busy after the installed script is actually run', () => {
            hooks.installHooks();

            require('child_process').execFileSync('sh', [hooks.hookScript, 'busy']);

            expect(hooks.readState()).to.equal('busy');
        });
    });
});
