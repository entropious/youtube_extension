/**
 * Local media server for the player webview.
 *
 * Stream URLs come from yt-dlp; the video is then served by ffmpeg to a plain
 * <video> element instead of YouTube's own player.
 *
 * VS Code ships a stripped ffmpeg: this build decodes H.264 and MP3, but not
 * VP9, Opus or AAC. Every audio format YouTube offers is AAC or Opus, so the
 * audio track is always re-encoded to MP3, while the H.264 video is copied
 * through untouched.
 *
 * The output is fragmented MP4, which carries no duration and cannot be seeked
 * by byte range. Duration comes from yt-dlp metadata (/info), and a seek
 * restarts the encode at the requested offset (/media?t=), which the player
 * page hides behind its own control bar.
 */

import * as http from 'http';
import { spawn } from 'child_process';

export type ToolConfig = {
	ytDlpPath: string;
	ffmpegPath: string;
	/** Upper bound for the picked format's height, in pixels. */
	maxHeight: number;
};

let tools: ToolConfig = {
	ytDlpPath: 'yt-dlp',
	ffmpegPath: 'ffmpeg',
	maxHeight: 1080
};

export function setToolConfig(config: Partial<ToolConfig>): void {
	tools = { ...tools, ...config };
	streamCache.clear();
	// A lookup already in flight used the previous paths and format, so it must
	// not be handed to anyone who asks after the change.
	pending.clear();
	toolReport = null;
}

export type StreamPart = {
	url: string;
	/** Headers yt-dlp expects the format to be fetched with. */
	headers: Record<string, string>;
};

export type StreamInfo = {
	/** One part when video and audio share a stream, two when they are separate. */
	parts: StreamPart[];
	/** Seconds; 0 for a live stream, whose length is unknown. */
	duration: number;
	title: string;
};

// Signed stream URLs stay valid for about six hours; the cache expires well
// before that so a stale link never reaches the player.
const CACHE_TTL_MS = 60 * 60 * 1000;

const streamCache = new Map<string, { info: StreamInfo; expires: number }>();
const pending = new Map<string, Promise<StreamInfo>>();

export class ToolMissingError extends Error {
	constructor(public readonly tool: string) {
		super(`${tool} was not found. Install it or set its path in the YouTube Panel settings.`);
	}
}

export type ToolStatus = {
	/** The configured command, so a wrong path in the settings is visible. */
	command: string;
	installed: boolean;
	version?: string;
};

export type InstallRecipe = { manager: string; hint: string; command: string };

export type ToolReport = {
	ytDlp: ToolStatus;
	ffmpeg: ToolStatus;
	ready: boolean;
	/** Ready-to-paste install commands for what is missing on this platform. */
	recipes: InstallRecipe[];
};

let toolReport: ToolReport | null = null;

/**
 * How a tool is actually started.
 *
 * On Windows a tool installed by pip or npm is a `.cmd` wrapper, which
 * CreateProcess — and therefore spawn — will not run. Such a wrapper is invoked
 * through `cmd.exe /c` instead of `shell: true`, so arguments keep their own
 * quoting: stream URLs are full of `&`, which a shell would tear apart.
 */
type Launcher = { file: string; prefix: string[] };

const launchers = new Map<string, Launcher>();

function launcherFor(command: string): Launcher {
	return launchers.get(command) ?? { file: command, prefix: [] };
}

export function runTool(command: string, args: string[]) {
	const launcher = launcherFor(command);
	return spawn(launcher.file, [...launcher.prefix, ...args]);
}

/** Asks Windows where a command lives, so a wrapper can be run explicitly. */
function whereIs(command: string): Promise<string | null> {
	return new Promise(resolve => {
		const proc = spawn('where', [command]);
		const out: Buffer[] = [];
		proc.stdout.on('data', c => out.push(c));
		proc.on('error', () => resolve(null));
		proc.on('close', code => {
			if (code !== 0) { resolve(null); return; }
			const first = Buffer.concat(out).toString('utf8').split(/\r?\n/)[0].trim();
			resolve(first || null);
		});
	});
}

function spawnVersion(launcher: Launcher, versionArg: string): Promise<string | null> {
	return new Promise(resolve => {
		const proc = spawn(launcher.file, [...launcher.prefix, versionArg]);
		const out: Buffer[] = [];

		proc.stdout.on('data', c => out.push(c));
		proc.on('error', () => resolve(null));
		proc.on('close', code => {
			if (code !== 0) { resolve(null); return; }
			// ffmpeg prints a banner; yt-dlp prints the bare version.
			const first = Buffer.concat(out).toString('utf8').split('\n')[0].trim();
			resolve(first.replace(/^ffmpeg version /i, '').split(' ')[0] || 'found');
		});
	});
}

async function probeTool(command: string, versionArg: string): Promise<ToolStatus> {
	launchers.delete(command);

	const direct = await spawnVersion({ file: command, prefix: [] }, versionArg);
	if (direct) return { command, installed: true, version: direct };

	if (process.platform === 'win32') {
		const found = await whereIs(command);
		if (found && /\.(cmd|bat)$/i.test(found)) {
			const launcher: Launcher = { file: 'cmd.exe', prefix: ['/c', found] };
			const version = await spawnVersion(launcher, versionArg);
			if (version) {
				launchers.set(command, launcher);
				return { command, installed: true, version };
			}
		}
	}

	return { command, installed: false };
}

/** Reports whether the tools playback depends on are actually present. */
export async function checkTools(refresh = false): Promise<ToolReport> {
	if (toolReport && !refresh) return toolReport;

	const [ytDlp, ffmpeg] = await Promise.all([
		probeTool(tools.ytDlpPath, '--version'),
		probeTool(tools.ffmpegPath, '-version')
	]);

	const ready = ytDlp.installed && ffmpeg.installed;
	toolReport = { ytDlp, ffmpeg, ready, recipes: ready ? [] : installRecipes(ytDlp, ffmpeg) };
	return toolReport;
}

/**
 * The format expression handed to yt-dlp, best choice first.
 *
 * HLS leads by a wide margin: its segments are read by plain GETs, so ffmpeg
 * can both stream and seek them. The direct googlevideo links of the
 * progressive and adaptive formats answer 403 to the open byte range ffmpeg
 * asks for, and accept only small closed ranges — usable by yt-dlp itself, but
 * not by ffmpeg, which is why they sit at the end as a last resort. Within HLS
 * a combined rendition wins over a video+audio pair: one playlist resolves
 * several times faster.
 */
export function formatSelector(maxHeight: number): string {
	return [
		`b[protocol^=m3u8][vcodec^=avc1][acodec!=none][height<=${maxHeight}]`,
		`bv*[protocol^=m3u8][vcodec^=avc1][height<=${maxHeight}]+ba[protocol^=m3u8]`,
		'b[protocol=https][vcodec^=avc1][acodec!=none]',
		`bv*[vcodec^=avc1][height<=${maxHeight}]+ba[ext=m4a]`,
		'b'
	].join('/');
}

/** Reads yt-dlp's JSON dump into the parts the media server needs. */
export function parseStreamInfo(data: any): StreamInfo {
	// A pair selection reports both halves in requested_formats, video first; a
	// combined format describes itself at the top level.
	const picked: { url?: string; http_headers?: Record<string, string> }[] =
		Array.isArray(data?.requested_formats) ? data.requested_formats : [data];
	const parts = picked
		.filter(f => typeof f?.url === 'string')
		.map(f => ({ url: f.url as string, headers: f.http_headers ?? {} }));

	if (!parts.length) {
		throw new Error('yt-dlp returned no playable format');
	}

	return {
		parts,
		duration: typeof data.duration === 'number' ? data.duration : 0,
		title: typeof data.title === 'string' ? data.title : ''
	};
}

function runYtDlp(videoId: string): Promise<StreamInfo> {
	// HLS first, and by a wide margin: its segments are read by plain GETs, so
	// ffmpeg can both stream and seek them. The direct googlevideo links of the
	// progressive and adaptive formats answer 403 to the open byte range ffmpeg
	// asks for, and accept only small closed ranges — usable by yt-dlp itself,
	// but not by ffmpeg, which is why they sit at the end as a last resort.
	// Within HLS a combined rendition wins over a video+audio pair: one playlist
	// resolves several times faster.
	const args = [
		'--no-playlist',
		'--no-warnings',
		'--no-progress',
		'-f', formatSelector(tools.maxHeight),
		'-J',
		`https://www.youtube.com/watch?v=${videoId}`
	];

	return new Promise((resolve, reject) => {
		const proc = runTool(tools.ytDlpPath, args);
		const out: Buffer[] = [];
		const err: Buffer[] = [];

		proc.stdout.on('data', c => out.push(c));
		proc.stderr.on('data', c => err.push(c));

		proc.on('error', (e: NodeJS.ErrnoException) => {
			reject(e.code === 'ENOENT' ? new ToolMissingError(tools.ytDlpPath) : e);
		});

		proc.on('close', code => {
			if (code !== 0) {
				const details = Buffer.concat(err).toString('utf8').trim().replace(/^ERROR:\s*/i, '');
				reject(new Error(details || `yt-dlp exited with code ${code}`));
				return;
			}

			try {
				resolve(parseStreamInfo(JSON.parse(Buffer.concat(out).toString('utf8'))));
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	});
}

/** Resolves a playable stream for a video, reusing a recent lookup when possible. */
export async function resolveStream(videoId: string): Promise<StreamInfo> {
	const cached = streamCache.get(videoId);
	if (cached && cached.expires > Date.now()) return cached.info;

	// Loading a page fires /info and /media at once; both wait on one lookup.
	const inFlight = pending.get(videoId);
	if (inFlight) return inFlight;

	const lookup = runYtDlp(videoId)
		.then(info => {
			streamCache.set(videoId, { info, expires: Date.now() + CACHE_TTL_MS });
			return info;
		})
		.finally(() => pending.delete(videoId));

	pending.set(videoId, lookup);
	return lookup;
}

type WarmStream = {
	videoId: string;
	startAt: number;
	/** Resolves once ffmpeg is running; the request may arrive before that. */
	ready: Promise<ReturnType<typeof runTool>>;
	proc?: ReturnType<typeof runTool>;
	buffered: Buffer[];
	size: number;
	startedAt: number;
};

/**
 * Enough of a head start to cover the page load, and small enough that a video
 * nobody ends up watching costs little.
 */
const WARM_LIMIT_BYTES = 12 * 1024 * 1024;
const WARM_TTL_MS = 60 * 1000;

let warmStream: WarmStream | null = null;

function dropWarmStream() {
	const warm = warmStream;
	if (!warm) return;
	warmStream = null;
	// The process may still be starting; kill it whenever it appears.
	void warm.ready.then(proc => proc.kill('SIGKILL')).catch(() => undefined);
}

/**
 * Starts a video before the player asks for it.
 *
 * Two things make a start slow, and neither depends on the panel: yt-dlp takes
 * seconds to resolve a video, and ffmpeg then has to fetch HLS playlists and
 * their first segments — together most of the wait. The panel knows which video
 * is coming as soon as it is chosen, so both run while the player page is still
 * loading, and what ffmpeg produces meanwhile is held until the page asks for
 * it.
 */
export function prewarmStream(videoId: string, startAt = 0): void {
	if (!videoId) return;
	if (warmStream && warmStream.videoId === videoId && warmStream.startAt === startAt) return;

	dropWarmStream();

	const warm: WarmStream = {
		videoId,
		startAt,
		buffered: [],
		size: 0,
		startedAt: Date.now(),
		ready: resolveStream(videoId).then(stream => {
			const proc = runTool(tools.ffmpegPath, ffmpegArgs(stream, startAt));
			warm.proc = proc;

			proc.stdout.on('data', (chunk: Buffer) => {
				warm.buffered.push(chunk);
				warm.size += chunk.length;
				// Held, not dropped: the pipe resumes when the page takes over.
				if (warm.size >= WARM_LIMIT_BYTES) proc.stdout.pause();
			});
			proc.on('close', () => { if (warmStream === warm) warmStream = null; });

			return proc;
		})
	};

	warmStream = warm;
	// A video nobody opens must not keep a process and its buffer alive.
	setTimeout(() => { if (warmStream === warm) dropWarmStream(); }, WARM_TTL_MS);
	warm.ready.catch(() => { if (warmStream === warm) warmStream = null; });
}

/**
 * Hands the warmed stream over to a request for the same video.
 *
 * The request usually arrives while the warm-up is still resolving, so this
 * waits for it rather than starting a second ffmpeg beside it.
 */
async function takeWarmStream(videoId: string, startAt: number): Promise<WarmStream | null> {
	const warm = warmStream;
	if (!warm || warm.videoId !== videoId || warm.startAt !== startAt) return null;
	if (Date.now() - warm.startedAt > WARM_TTL_MS) { dropWarmStream(); return null; }

	warmStream = null;
	try {
		const proc = await warm.ready;
		proc.stdout.removeAllListeners('data');
		return warm;
	} catch {
		// The warm-up failed; the request resolves the video on its own and
		// reports what went wrong.
		return null;
	}
}

/**
 * Resolves a video into the cache without fetching any of it.
 *
 * Used for what is likely to be played next: the lookup is the slow half of a
 * start, and doing it early costs one yt-dlp run and no traffic.
 */
export function prefetchStream(videoId: string): void {
	if (!videoId) return;
	void resolveStream(videoId).catch(() => undefined);
}

/** Drops a cached stream so the next request resolves it again. */
export function invalidateStream(videoId: string): void {
	streamCache.delete(videoId);
}

function headerArgs(headers: Record<string, string>): string[] {
	const args: string[] = [];
	const ua = headers['User-Agent'];
	if (ua) args.push('-user_agent', ua);

	const rest = Object.entries(headers)
		.filter(([name]) => name.toLowerCase() !== 'user-agent')
		.map(([name, value]) => `${name}: ${value}\r\n`)
		.join('');
	if (rest) args.push('-headers', rest);

	return args;
}

/**
 * Serves the video as fragmented MP4 the webview can decode.
 *
 * The AAC track is re-encoded to MP3; the H.264 video is copied. Seeking is
 * served by restarting the encode at the requested offset.
 */
export async function handleMedia(res: http.ServerResponse, videoId: string, startAt = 0): Promise<void> {
	if (!videoId) { res.writeHead(400); res.end('Missing video id'); return; }

	const warm = await takeWarmStream(videoId, startAt);
	let ff: ReturnType<typeof runTool>;

	if (warm?.proc) {
		ff = warm.proc;
	} else {
		let stream: StreamInfo;
		try {
			stream = await resolveStream(videoId);
		} catch (e) {
			res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end(e instanceof Error ? e.message : String(e));
			return;
		}

		ff = runTool(tools.ffmpegPath, ffmpegArgs(stream, startAt));
	}

	res.writeHead(200, {
		'Content-Type': 'video/mp4',
		'Access-Control-Allow-Origin': '*',
		'Cache-Control': 'no-cache'
	});

	// Whatever the warm-up already fetched goes out first, then the live pipe.
	if (warm?.buffered.length) {
		res.write(Buffer.concat(warm.buffered));
		ff.stdout.resume();
	}

	ff.stdout.pipe(res);
	ff.on('error', () => res.end());
	// A signed URL that has expired makes ffmpeg fail immediately; the next
	// request then resolves the video again instead of replaying the dead link.
	ff.on('close', code => { if (code !== 0) invalidateStream(videoId); });
	res.on('close', () => ff.kill('SIGKILL'));
}

/**
 * The ffmpeg command that turns a resolved stream into what the webview plays:
 * H.264 copied through, audio re-encoded to MP3, wrapped in fragmented MP4.
 *
 * Both inputs of a video+audio pair are opened at the same offset, which is
 * what keeps them in sync when playback starts anywhere but the beginning.
 */
export function ffmpegArgs(stream: StreamInfo, startAt = 0): string[] {
	const args = ['-loglevel', 'error'];

	for (const part of stream.parts) {
		args.push(...headerArgs(part.headers));
		if (startAt > 0) args.push('-ss', String(startAt));
		args.push('-i', part.url);
	}

	// A combined format carries its audio in the same input; a pair keeps it in
	// the second one.
	const audioInput = stream.parts.length > 1 ? '1:a:0' : '0:a:0?';

	return args.concat([
		'-map', '0:v:0',
		'-map', audioInput,
		'-c:v', 'copy',
		'-c:a', 'libmp3lame', '-b:a', '128k',
		'-movflags', 'frag_keyframe+empty_moov+default_base_moof',
		'-f', 'mp4', 'pipe:1'
	]);
}

/** Turns a yt-dlp failure into something the player page can act on. */
export function explain(message: string): string {
	// YouTube refuses a share of its catalogue to anonymous sessions, and which
	// share that is moves with its bot checks; a current yt-dlp usually gets in.
	if (/not a bot|sign in to confirm/i.test(message)) {
		return 'YouTube refused this video to an anonymous session. Updating yt-dlp usually clears it.';
	}

	if (/is not available|private video|members-only|age/i.test(message)) {
		return message.replace(/\s+See\s+https:\S+.*$/s, '').trim();
	}

	return message;
}

/** Reports what the player page needs before it can show a video. */
export async function handleInfo(res: http.ServerResponse, videoId: string): Promise<void> {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Cache-Control', 'no-cache');

	if (!videoId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing video id' })); return; }

	try {
		const info = await resolveStream(videoId);
		res.writeHead(200);
		res.end(JSON.stringify({ duration: info.duration, title: info.title }));
	} catch (e) {
		const missing = e instanceof ToolMissingError;
		res.writeHead(missing ? 501 : 502);
		res.end(JSON.stringify({ error: explain(e instanceof Error ? e.message : String(e)) }));
	}
}

/**
 * Serves the player page: a plain <video> driven by our own control bar.
 *
 * The page speaks the subset of the YouTube IFrame API the webview relies on —
 * `playerReady`, `timeUpdate` and `infoDelivery` outward, `load` and `command`
 * inward — so the surrounding UI works the same as with an embedded player.
 */
export function handlePlayerPage(
	res: http.ServerResponse,
	videoId: string,
	startTime: number,
	autoplay: boolean
): void {
	res.writeHead(200, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-cache',
		'Access-Control-Allow-Origin': '*'
	});
	res.end(playerPageHtml(videoId, startTime, autoplay));
}

/** Reports tool availability; the panel blocks on this until both are present. */
export async function handleTools(res: http.ServerResponse, refresh = false): Promise<void> {
	const report = await checkTools(refresh);
	res.writeHead(200, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-cache',
		'Access-Control-Allow-Origin': '*'
	});
	res.end(JSON.stringify(report));
}

/** Install commands for the tools that are missing, for this platform. */
export function installRecipes(ytDlpStatus: ToolStatus, ffmpegStatus: ToolStatus): InstallRecipe[] {
	const missing = {
		ytDlp: !ytDlpStatus.installed,
		ffmpeg: !ffmpegStatus.installed
	};
	const pick = (ytDlp: string, ffmpeg: string, both: string) =>
		missing.ytDlp && missing.ffmpeg ? both : missing.ytDlp ? ytDlp : ffmpeg;

	if (process.platform === 'darwin') {
		return [
			{
				manager: 'Homebrew',
				hint: 'The usual choice on macOS.',
				command: pick('brew install yt-dlp', 'brew install ffmpeg', 'brew install yt-dlp ffmpeg')
			},
			{
				manager: 'MacPorts',
				hint: 'If you use MacPorts instead.',
				command: pick('sudo port install yt-dlp', 'sudo port install ffmpeg', 'sudo port install yt-dlp ffmpeg')
			}
		];
	}

	if (process.platform === 'win32') {
		return [
			{
				manager: 'winget',
				hint: 'Ships with Windows 10 and 11.',
				command: pick(
					'winget install yt-dlp.yt-dlp',
					'winget install Gyan.FFmpeg',
					'winget install yt-dlp.yt-dlp Gyan.FFmpeg'
				)
			},
			{
				manager: 'Scoop',
				hint: 'No administrator rights needed.',
				command: pick('scoop install yt-dlp', 'scoop install ffmpeg', 'scoop install yt-dlp ffmpeg')
			},
			{
				manager: 'Chocolatey',
				hint: 'Run from an elevated prompt.',
				command: pick('choco install yt-dlp', 'choco install ffmpeg', 'choco install yt-dlp ffmpeg')
			}
		];
	}

	return [
		{
			manager: 'apt (Debian, Ubuntu)',
			hint: 'Distribution packages of yt-dlp are often months behind; pipx below keeps it current.',
			command: pick('sudo apt install yt-dlp', 'sudo apt install ffmpeg', 'sudo apt install yt-dlp ffmpeg')
		},
		{
			manager: 'dnf (Fedora)',
			hint: 'ffmpeg comes from RPM Fusion.',
			command: pick('sudo dnf install yt-dlp', 'sudo dnf install ffmpeg', 'sudo dnf install yt-dlp ffmpeg')
		},
		{
			manager: 'pacman (Arch)',
			hint: '',
			command: pick('sudo pacman -S yt-dlp', 'sudo pacman -S ffmpeg', 'sudo pacman -S yt-dlp ffmpeg')
		},
		...(missing.ytDlp ? [{
			manager: 'pipx',
			hint: 'Always the newest yt-dlp, which matters when YouTube changes.',
			command: 'pipx install yt-dlp'
		}] : [])
	];
}

function playerPageHtml(videoId: string, startTime: number, autoplay: boolean): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
	html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
	body { font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; }
	#stage { position: relative; width: 100%; height: 100%; }
	video { width: 100%; height: 100%; background: #000; display: block; }
	#bar {
		position: absolute; left: 0; right: 0; bottom: 0;
		display: flex; align-items: center; gap: 8px;
		padding: 10px 12px 12px; box-sizing: border-box;
		background: linear-gradient(transparent, rgba(0,0,0,.85));
		opacity: 0; transition: opacity .15s;
	}
	/* Visibility is driven from JS: a bar that vanishes on a stray :hover loss
	   is impossible to aim the seek slider at. */
	#bar.shown { opacity: 1; }
	#bar.shown, #bar:hover { pointer-events: auto; }
	#bar:not(.shown) { pointer-events: none; }
	#bar button {
		background: none; border: none; color: #fff; cursor: pointer;
		font-size: 14px; line-height: 1; padding: 4px 6px;
	}
	#seek { flex: 1; accent-color: #f00; cursor: pointer; height: 16px; }
	#vol { width: 70px; accent-color: #fff; cursor: pointer; height: 16px; }
	#time { font-variant-numeric: tabular-nums; white-space: nowrap; }
	#msg {
		position: absolute; inset: 0; display: none;
		align-items: center; justify-content: center; text-align: center;
		padding: 24px; box-sizing: border-box; line-height: 1.5; color: #ddd;
	}
	#spin {
		position: absolute; left: 50%; top: 50%; width: 34px; height: 34px; margin: -17px 0 0 -17px;
		border: 3px solid rgba(255,255,255,.25); border-top-color: #fff; border-radius: 50%;
		display: none; animation: spin 1s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="stage">
	<video id="v" playsinline></video>
	<div id="spin"></div>
	<div id="msg"></div>
	<div id="bar">
		<button id="play" title="Play/Pause">▶</button>
		<span id="time">0:00 / 0:00</span>
		<input id="seek" type="range" min="0" max="1000" value="0" step="1">
		<button id="mute" title="Mute">🔊</button>
		<input id="vol" type="range" min="0" max="1" step="0.05" value="1">
		<button id="full" title="Fullscreen">⛶</button>
	</div>
</div>
<script>
(function() {
	var video = document.getElementById('v');
	var stage = document.getElementById('stage');
	var bar = document.getElementById('bar');
	var playBtn = document.getElementById('play');
	var muteBtn = document.getElementById('mute');
	var fullBtn = document.getElementById('full');
	var seek = document.getElementById('seek');
	var vol = document.getElementById('vol');
	var timeLabel = document.getElementById('time');
	var msg = document.getElementById('msg');
	var spin = document.getElementById('spin');

	var videoId = ${JSON.stringify(videoId)};
	var duration = 0;
	// The stream always starts at zero, so the position inside the video is the
	// offset the encode was restarted at plus the element's own time.
	var offset = 0;
	var seeking = false;
	var lastState = -1;
	// Nothing is reported outward while no stream is attached: a failed lookup
	// must not have the surrounding UI record progress for a video that never
	// started.
	var playing = false;

	function send(data) { window.parent.postMessage(data, '*'); }

	function logError(message, detail) {
		send({ type: 'proxyLog', level: 'error', message: '[YOUTUBE_EXT][PROXY] ' + message, args: detail ? [String(detail)] : [] });
	}

	function showMessage(text) {
		msg.textContent = text || '';
		msg.style.display = text ? 'flex' : 'none';
	}

	function showSpinner(on) { spin.style.display = on ? 'block' : 'none'; }

	function format(sec) {
		sec = Math.max(0, Math.floor(sec || 0));
		var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
		var mm = h > 0 && m < 10 ? '0' + m : String(m);
		return (h > 0 ? h + ':' : '') + mm + ':' + (s < 10 ? '0' + s : s);
	}

	function position() { return offset + (video.currentTime || 0); }

	function reportState(state) {
		if (state === lastState) return;
		lastState = state;
		send({ event: 'infoDelivery', info: { playerState: state }, videoId: videoId });
	}

	function paint() {
		var pos = position();
		timeLabel.textContent = format(pos) + ' / ' + (duration ? format(duration) : 'LIVE');
		if (!seeking) seek.value = duration ? String(Math.round(pos / duration * 1000)) : '0';
		seek.disabled = !duration;
		playBtn.textContent = video.paused ? '▶' : '❚❚';
	}

	function mediaUrl(id, at) {
		return '/media?v=' + encodeURIComponent(id) + (at > 0 ? '&t=' + Math.floor(at) : '');
	}

	function stopStream() {
		playing = false;
		video.pause();
		video.removeAttribute('src');
		video.load();
	}

	function startStream(at, autoplay) {
		offset = Math.max(0, at || 0);
		playing = true;
		showSpinner(true);
		video.src = mediaUrl(videoId, offset);
		video.load();
		if (autoplay) {
			var p = video.play();
			if (p && p.catch) p.catch(function() { /* autoplay may be refused; the bar still works */ });
		}
		paint();
	}

	function loadInfo(id) {
		return fetch('/info?v=' + encodeURIComponent(id))
			.then(function(r) { return r.json().then(function(body) { return { ok: r.ok, body: body }; }); })
			.then(function(res) {
				if (!res.ok) throw new Error(res.body && res.body.error || 'Failed to resolve the video');
				return res.body;
			});
	}

	function load(id, startAt, autoplay) {
		videoId = id;
		duration = 0;
		lastState = -1;
		// Resolving takes a couple of seconds; the previous video must not keep
		// playing meanwhile.
		stopStream();
		showMessage('');
		showSpinner(true);
		paint();

		// The stream is asked for straight away rather than after the metadata:
		// both wait on the same lookup server-side, so starting them together
		// takes a whole round of it off the start. Only the duration — the seek
		// bar and the time label — has to wait for the answer.
		startStream(startAt, autoplay);

		loadInfo(id).then(function(info) {
			if (videoId !== id) return;
			duration = info.duration || 0;
			paint();
			send({ type: 'playerReady', videoId: id });
		}).catch(function(err) {
			if (videoId !== id) return;
			stopStream();
			showSpinner(false);
			showMessage(String(err && err.message || err));
			logError('Failed to load video', err && err.message || err);
		});
	}

	function seekTo(target) {
		if (!duration) return;
		var at = Math.min(Math.max(0, target), Math.max(0, duration - 1));
		startStream(at, !video.paused);
	}

	function togglePlay() {
		var playing = video.paused;
		if (playing) {
			var p = video.play();
			if (p && p.catch) p.catch(function() {});
		} else {
			video.pause();
		}
		// Told apart from an automatic pause by the panel, which lets a choice
		// made here outrank whatever Claude sync wants.
		send({ type: 'userToggle', playing: playing });
	}

	// The bar stays up for a moment after the pointer stops, and never hides
	// while it is being used or while playback is paused.
	var hideTimer = 0;
	function revealBar() {
		bar.classList.add('shown');
		clearTimeout(hideTimer);
		hideTimer = setTimeout(function() {
			if (!video.paused && !bar.matches(':hover')) bar.classList.remove('shown');
		}, 2500);
	}

	// The control bar owns the bottom edge of the frame; the panel stacks its
	// chapter strip directly above it, so it is told how tall the bar is.
	function reportBarHeight() {
		send({ type: 'barHeight', height: bar.offsetHeight });
	}

	window.addEventListener('resize', reportBarHeight);

	// Pointer events inside this frame are invisible to the panel around it, so
	// the panel is told when the pointer reaches the bottom edge — that is what
	// its chapter strip slides in on.
	var atBottom = false;
	function reportPointerZone(bottom) {
		if (bottom === atBottom) return;
		atBottom = bottom;
		send({ type: 'pointerZone', bottom: bottom });
	}

	// Deep enough that the strip is easy to summon and that the strip's own
	// height stays inside it — a pointer resting on the strip still counts as
	// "at the bottom" instead of flipping the zone back and forth.
	function bottomZone() {
		return Math.max(120, Math.min(220, window.innerHeight * 0.4));
	}

	stage.addEventListener('pointermove', function(e) {
		revealBar();
		reportPointerZone(e.clientY > window.innerHeight - bottomZone());
	});
	stage.addEventListener('pointerdown', revealBar);
	stage.addEventListener('pointerleave', function() {
		if (!video.paused && !seeking) bar.classList.remove('shown');
		// Leaving through the bottom means the pointer moved onto the panel's
		// chapter strip, which covers this frame's lower edge. Reporting that as
		// "left the zone" would hide the strip and hand the pointer straight back
		// — the two would then flip forever. The panel closes it on its own.
		if (!atBottom) reportPointerZone(false);
	});

	playBtn.addEventListener('click', togglePlay);

	// Clicking the picture toggles playback, the way every video player does.
	video.addEventListener('click', function() { revealBar(); togglePlay(); });

	document.addEventListener('keydown', function(e) {
		if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
		var key = e.key;
		if (key === ' ' || key === 'Spacebar' || key === 'k') { e.preventDefault(); revealBar(); togglePlay(); }
		else if (key === 'ArrowRight') { e.preventDefault(); revealBar(); seekTo(position() + 5); }
		else if (key === 'ArrowLeft') { e.preventDefault(); revealBar(); seekTo(position() - 5); }
		else if (key === 'j') { revealBar(); seekTo(position() - 10); }
		else if (key === 'l') { revealBar(); seekTo(position() + 10); }
		else if (key === 'm') { revealBar(); muteBtn.click(); }
		else if (key === 'f') { revealBar(); fullBtn.click(); }
	});

	muteBtn.addEventListener('click', function() {
		video.muted = !video.muted;
		muteBtn.textContent = video.muted ? '🔇' : '🔊';
	});

	vol.addEventListener('input', function() {
		video.volume = Number(vol.value);
		video.muted = video.volume === 0;
		muteBtn.textContent = video.muted ? '🔇' : '🔊';
	});

	fullBtn.addEventListener('click', function() {
		if (document.fullscreenElement) document.exitFullscreen();
		else document.getElementById('stage').requestFullscreen();
	});

	seek.addEventListener('pointerdown', function() { seeking = true; });
	seek.addEventListener('change', function() {
		seeking = false;
		seekTo(Number(seek.value) / 1000 * duration);
	});

	// The spinner belongs to fetching, not to playing: a video cued on pause
	// never fires 'playing', and its first frames arriving are what ends the wait.
	video.addEventListener('loadeddata', function() { showSpinner(false); paint(); });
	video.addEventListener('canplay', function() { showSpinner(false); });
	video.addEventListener('playing', function() { showSpinner(false); reportState(1); revealBar(); paint(); });
	video.addEventListener('pause', function() { reportState(2); bar.classList.add('shown'); paint(); });
	video.addEventListener('waiting', function() { showSpinner(true); });
	video.addEventListener('timeupdate', paint);
	video.addEventListener('ended', function() {
		showSpinner(false);
		// The encode also ends when the stream is cut short, so the video counts
		// as watched only once playback actually reached the end.
		if (!duration || position() >= duration - 2) reportState(0);
		paint();
	});
	video.addEventListener('error', function() {
		// Detaching the source raises an error of its own; only a live stream's
		// failure is worth reporting.
		if (!playing) return;
		showSpinner(false);
		var err = video.error;
		// A stream dropped mid-playback is usually an expired URL: the server
		// resolves the video again, so one restart at the same spot recovers it.
		if (err && err.code === 2 && position() > 0) { startStream(position(), true); return; }
		showMessage('Playback failed' + (err ? ' (code ' + err.code + ')' : ''));
		logError('Media element error', err && err.code);
	});

	// The webview tracks progress and chapters from this heartbeat.
	setInterval(function() {
		if (!playing) return;
		send({ event: 'timeUpdate', time: Math.floor(position()), videoId: videoId, actualVideoId: videoId });
	}, 1000);

	window.addEventListener('message', function(e) {
		var data = e.data;
		if (typeof data === 'string') {
			try { data = JSON.parse(data); } catch (err) { return; }
		}
		if (!data) return;

		if (data.type === 'load') {
			var nextId = data.id;
			var at = data.startTime || 0;
			var autoplay = data.autoplay !== false;
			if (nextId && nextId !== videoId) load(nextId, at, autoplay);
			else if (Math.abs(at - position()) > 1) startStream(at, autoplay);
			else if (autoplay) video.play(); else video.pause();
			return;
		}

		if (data.event === 'command') {
			if (data.func === 'playVideo') video.play();
			else if (data.func === 'pauseVideo') video.pause();
			else if (data.func === 'stopVideo') stopStream();
		}
	});

	reportBarHeight();
	load(videoId, ${Math.max(0, Math.floor(startTime))}, ${autoplay ? 'true' : 'false'});
})();
</script>
</body>
</html>`;
}
