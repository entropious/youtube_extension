import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MockMemento, createMockWebview, createMockWebviewView } from './mocks';

/**
 * Claude sync writes into the home directory, so the provider is loaded against
 * a throwaway one: the hook module resolves its paths when it is required.
 */
function loadProvider(home: string) {
    sinon.stub(os, 'homedir').returns(home);
    delete require.cache[require.resolve('../src/claudeHooks')];
    delete require.cache[require.resolve('../src/provider')];
    return {
        Provider: require('../src/provider').YouTubeViewProvider,
        hooks: require('../src/claudeHooks')
    };
}

const settled = () => new Promise(resolve => setTimeout(resolve, 20));

/** Waits for the watcher to notice a state change, which fs.watch reports late. */
async function waitFor(check: () => boolean, timeoutMs = 3000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (check()) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
}

describe('Claude sync in the provider', () => {
    let home: string;
    let Provider: any;
    let hooks: any;
    let memento: MockMemento;
    let provider: any;
    let webview: any;

    const extensionUri: any = { fsPath: '/mock/path', toString: () => 'file:///mock/path' };

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-panel-sync-'));
        ({ Provider, hooks } = loadProvider(home));
        memento = new MockMemento();
        webview = createMockWebview();
    });

    afterEach(() => {
        provider?.dispose?.();
        sinon.restore();
        delete require.cache[require.resolve('../src/claudeHooks')];
        delete require.cache[require.resolve('../src/provider')];
        fs.rmSync(home, { recursive: true, force: true });
    });

    function attachPanel() {
        provider.resolveWebviewView(createMockWebviewView(webview) as any, {} as any, {} as any);
        return webview.onDidReceiveMessage.getCall(0).args[0];
    }

    const messagesOfType = (type: string) =>
        webview.postMessage.getCalls().map((c: any) => c.args[0]).filter((m: any) => m?.type === type);

    it('starts switched off, touching neither the settings nor the state file', () => {
        provider = new Provider(extensionUri, memento as any, () => 8080);

        expect(provider.followClaudeEnabled).to.equal(false);
        expect(hooks.hooksInstalled()).to.equal(false);
        expect(fs.existsSync(hooks.stateFile)).to.equal(false);
    });

    it('installs the hooks when switched on, and remembers the choice', async () => {
        provider = new Provider(extensionUri, memento as any, () => 8080);

        provider.setClaudeSync(true);
        await settled();

        expect(hooks.hooksInstalled()).to.equal(true);
        expect(memento.data['youtube-follow-claude']).to.equal(true);
        expect(provider.followClaudeEnabled).to.equal(true);
    });

    it('removes the hooks when switched off', async () => {
        provider = new Provider(extensionUri, memento as any, () => 8080);
        provider.setClaudeSync(true);
        await settled();

        provider.setClaudeSync(false);
        await settled();

        expect(hooks.hooksInstalled()).to.equal(false);
        expect(memento.data['youtube-follow-claude']).to.equal(false);
    });

    it('resumes playback when switched off, so nothing stays paused on its behalf', async () => {
        provider = new Provider(extensionUri, memento as any, () => 8080);
        attachPanel();
        provider.setClaudeSync(true);
        await settled();

        provider.setClaudeSync(false);
        await settled();

        const resumes = messagesOfType('autoResume');
        expect(resumes.map((m: any) => m.reason)).to.include('claude');
    });

    it('picks the stored choice up on the next session', async () => {
        memento.data['youtube-follow-claude'] = true;

        provider = new Provider(extensionUri, memento as any, () => 8080);
        await settled();

        expect(provider.followClaudeEnabled).to.equal(true);
        expect(hooks.hooksInstalled()).to.equal(true);
    });

    it('restores the hook script when only the settings survived', async () => {
        memento.data['youtube-follow-claude'] = true;
        provider = new Provider(extensionUri, memento as any, () => 8080);
        await settled();
        fs.rmSync(hooks.hookScript);
        provider.dispose();

        provider = new Provider(extensionUri, memento as any, () => 8080);
        await settled();

        expect(fs.existsSync(hooks.hookScript)).to.equal(true);
    });

    it('tells the panel to play while Claude works', async () => {
        provider = new Provider(extensionUri, memento as any, () => 8080);
        attachPanel();
        provider.setClaudeSync(true);
        await settled();
        webview.postMessage.resetHistory();

        fs.writeFileSync(hooks.stateFile, 'busy');

        expect(await waitFor(() => messagesOfType('autoResume').length > 0)).to.equal(true);
        expect(messagesOfType('autoResume')[0].reason).to.equal('claude');
    });

    it('tells the panel to pause the moment Claude waits', async () => {
        provider = new Provider(extensionUri, memento as any, () => 8080);
        attachPanel();
        provider.setClaudeSync(true);
        await settled();
        fs.writeFileSync(hooks.stateFile, 'busy');
        await waitFor(() => messagesOfType('autoResume').length > 0);
        webview.postMessage.resetHistory();

        fs.writeFileSync(hooks.stateFile, 'idle');

        expect(await waitFor(() => messagesOfType('autoPause').length > 0)).to.equal(true);
        expect(messagesOfType('autoPause')[0].reason).to.equal('claude');
    });

    it('stops following once switched off', async () => {
        provider = new Provider(extensionUri, memento as any, () => 8080);
        attachPanel();
        provider.setClaudeSync(true);
        await settled();
        provider.setClaudeSync(false);
        await settled();
        webview.postMessage.resetHistory();

        fs.writeFileSync(hooks.stateFile, 'busy');
        await new Promise(resolve => setTimeout(resolve, 300));

        expect(messagesOfType('autoResume')).to.be.empty;
        expect(messagesOfType('autoPause')).to.be.empty;
    });

    it('stops following when the extension shuts down', async () => {
        provider = new Provider(extensionUri, memento as any, () => 8080);
        attachPanel();
        provider.setClaudeSync(true);
        await settled();

        provider.dispose();
        webview.postMessage.resetHistory();
        fs.writeFileSync(hooks.stateFile, 'busy');
        await new Promise(resolve => setTimeout(resolve, 300));

        expect(messagesOfType('autoResume')).to.be.empty;
    });

    it('answers the panel with the current setting, and follows its switch', async () => {
        provider = new Provider(extensionUri, memento as any, () => 8080);
        const handle = attachPanel();

        await handle({ type: 'requestFollowClaude' });
        expect(messagesOfType('setFollowClaude').pop()).to.deep.equal({ type: 'setFollowClaude', value: false });

        await handle({ type: 'toggleFollowClaude', value: true });
        await settled();

        expect(provider.followClaudeEnabled).to.equal(true);
        expect(hooks.hooksInstalled()).to.equal(true);
        expect(messagesOfType('setFollowClaude').pop()).to.deep.equal({ type: 'setFollowClaude', value: true });
    });

    it('flips the switch from the command as well', async () => {
        provider = new Provider(extensionUri, memento as any, () => 8080);
        attachPanel();

        provider.toggleClaudeSync();
        await settled();
        expect(provider.followClaudeEnabled).to.equal(true);

        provider.toggleClaudeSync();
        await settled();
        expect(provider.followClaudeEnabled).to.equal(false);
    });
});
