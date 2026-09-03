import { expect } from 'chai';
import { installRecipes, ToolStatus } from '../src/ytproxy';

const missing = (command: string): ToolStatus => ({ command, installed: false });
const present = (command: string): ToolStatus => ({ command, installed: true, version: '1.0' });

function onPlatform<T>(platform: string, run: () => T): T {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
        return run();
    } finally {
        if (original) Object.defineProperty(process, 'platform', original);
    }
}

describe('Setup gate install recipes', () => {
    it('offers Homebrew first on macOS', () => {
        const recipes = onPlatform('darwin', () => installRecipes(missing('yt-dlp'), missing('ffmpeg')));

        expect(recipes[0].manager).to.equal('Homebrew');
        expect(recipes[0].command).to.equal('brew install yt-dlp ffmpeg');
    });

    it('offers winget, Scoop and Chocolatey on Windows', () => {
        const recipes = onPlatform('win32', () => installRecipes(missing('yt-dlp'), missing('ffmpeg')));

        expect(recipes.map(r => r.manager)).to.deep.equal(['winget', 'Scoop', 'Chocolatey']);
        expect(recipes[0].command).to.equal('winget install yt-dlp.yt-dlp Gyan.FFmpeg');
        expect(recipes[1].command).to.equal('scoop install yt-dlp ffmpeg');
        expect(recipes[2].command).to.equal('choco install yt-dlp ffmpeg');
    });

    it('names only the missing tool', () => {
        const onlyFfmpeg = onPlatform('win32', () => installRecipes(present('yt-dlp'), missing('ffmpeg')));
        const onlyYtDlp = onPlatform('darwin', () => installRecipes(missing('yt-dlp'), present('ffmpeg')));

        expect(onlyFfmpeg[0].command).to.equal('winget install Gyan.FFmpeg');
        expect(onlyYtDlp[0].command).to.equal('brew install yt-dlp');
    });

    it('covers the common Linux package managers', () => {
        const recipes = onPlatform('linux', () => installRecipes(missing('yt-dlp'), missing('ffmpeg')));

        expect(recipes.map(r => r.manager)).to.include.members(['pacman (Arch)', 'pipx']);
        expect(recipes.find(r => r.manager === 'pipx')?.command).to.equal('pipx install yt-dlp');
    });

    it('leaves out the pipx entry when only ffmpeg is missing', () => {
        const recipes = onPlatform('linux', () => installRecipes(present('yt-dlp'), missing('ffmpeg')));

        expect(recipes.some(r => r.manager === 'pipx')).to.equal(false);
        expect(recipes[0].command).to.equal('sudo apt install ffmpeg');
    });
});
