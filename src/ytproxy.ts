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
import * as https from 'https';
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
	/** HLS parts are playlists, and can be handed to ffmpeg trimmed. */
	isHls: boolean;
};

/** An HLS playlist split into what has to be kept and what can be cut. */
export type Playlist = {
	header: string[];
	segments: { url: string; duration: number }[];
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

/**
 * Every ffmpeg this server starts, so none can be lost.
 *
 * A process whose only reference was dropped keeps running to the end of the
 * video, holding memory and fetching data nobody reads; the register is what
 * makes "end everything but the one in use" possible.
 */
const running = new Set<ReturnType<typeof spawn>>();

export function runTool(command: string, args: string[]) {
	const launcher = launcherFor(command);
	const proc = spawn(launcher.file, [...launcher.prefix, ...args]);

	running.add(proc);
	proc.on('close', () => running.delete(proc));
	proc.on('error', () => running.delete(proc));

	return proc;
}

/** Ends every stream except the ones still wanted. */
function killStrays(...keep: (ReturnType<typeof spawn> | null | undefined)[]): void {
	for (const proc of running) {
		if (keep.includes(proc)) continue;
		proc.kill('SIGKILL');
		running.delete(proc);
	}
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
		.map(f => ({
			url: f.url as string,
			headers: f.http_headers ?? {},
			isHls: String((f as { protocol?: string }).protocol ?? '').startsWith('m3u8')
		}));

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

/** The stream currently being served, kept so a new one can end it. */
let activeStream: ReturnType<typeof runTool> | null = null;
let activeVideoId: string | null = null;

function stopActiveStream() {
	activeVideoId = null;
	if (!activeStream) return;
	activeStream.kill('SIGKILL');
	activeStream = null;
}

/**
 * Ends every ffmpeg this server started.
 *
 * Nothing else will: a process outlives the extension that spawned it, and one
 * left behind holds its memory and wakes up whenever its pipe drains — which on
 * a laptop is felt as battery going flat.
 */
export function shutdownStreams(): void {
	stopActiveStream();
	dropWarmStream();
	killStrays();
}

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
	// Already being served: the page got there first, and a warm-up beside it
	// would fetch the same video a second time for nobody.
	if (activeVideoId === videoId) return;
	if (warmStream && warmStream.videoId === videoId && warmStream.startAt === startAt) return;

	dropWarmStream();

	const warm: WarmStream = {
		videoId,
		startAt,
		buffered: [],
		size: 0,
		startedAt: Date.now(),
		ready: resolveStream(videoId).then(async stream => {
			// Resolving took seconds, and in that time the page may have asked for
			// this very video itself — then there is nothing left to warm up.
			if (activeVideoId === videoId || warmStream !== warm) {
				throw new Error('warm-up no longer needed');
			}

			const trimmed = await trimmedInputs(videoId, stream, startAt);
			const proc = runTool(tools.ffmpegPath, ffmpegArgs(stream, startAt, trimmed ?? undefined));
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
	if (!warm) return null;

	// A warm-up for this very video at another offset — the viewer seeked before
	// it was claimed — will never be used, and would go on fetching regardless.
	if (warm.videoId === videoId && warm.startAt !== startAt) { dropWarmStream(); return null; }
	if (warm.videoId !== videoId || warm.startAt !== startAt) return null;
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

const playlistCache = new Map<string, { playlists: Playlist[]; expires: number }>();
const playlistPending = new Map<string, Promise<Playlist[]>>();

/** The port the media server listens on, needed to hand ffmpeg its playlists. */
let serverPort = 0;

export function setServerPort(port: number): void {
	serverPort = port;
}

function download(url: string, headers: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { headers }, response => {
			if ((response.statusCode ?? 0) >= 400) {
				response.resume();
				reject(new Error(`playlist request failed with ${response.statusCode}`));
				return;
			}

			const chunks: Buffer[] = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			response.on('error', reject);
		});

		request.on('error', reject);
	});
}

/** Splits a playlist into its header and the segments a seek can skip. */
export function parsePlaylist(text: string): Playlist {
	const header: string[] = [];
	const segments: { url: string; duration: number }[] = [];
	let duration = 0;
	let seenSegment = false;

	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line) continue;

		if (line.startsWith('#EXTINF')) {
			duration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
			continue;
		}
		if (line.startsWith('#')) {
			// Tags after the first segment describe segments, not the playlist.
			if (!seenSegment && line !== '#EXT-X-ENDLIST') header.push(line);
			continue;
		}

		seenSegment = true;
		segments.push({ url: line, duration });
	}

	return { header, segments };
}

/** Rebuilds a playlist from `fromIndex` onwards, which is all a seek needs. */
export function renderPlaylist(playlist: Playlist, fromIndex: number): string {
	const lines = [...playlist.header];
	for (const segment of playlist.segments.slice(Math.max(0, fromIndex))) {
		lines.push(`#EXTINF:${segment.duration.toFixed(6)},`, segment.url);
	}
	lines.push('#EXT-X-ENDLIST');
	return lines.join('\n') + '\n';
}

/** Index of the segment covering `seconds`, and where that segment begins. */
export function segmentAt(playlist: Playlist, seconds: number): { index: number; startsAt: number } {
	let startsAt = 0;
	for (let i = 0; i < playlist.segments.length; i++) {
		const end = startsAt + playlist.segments[i].duration;
		if (end > seconds) return { index: i, startsAt };
		startsAt = end;
	}
	return { index: Math.max(0, playlist.segments.length - 1), startsAt };
}

/**
 * Fetches and keeps the HLS playlists of a stream.
 *
 * Worth caching twice over: the playlists come from manifest.googlevideo, which
 * takes a second or more to answer, and having them here is what lets a seek
 * start at its own segment instead of making ffmpeg walk from the beginning.
 */
export async function ensurePlaylists(videoId: string, stream: StreamInfo): Promise<Playlist[] | null> {
	if (!stream.parts.every(part => part.isHls)) return null;

	const cached = playlistCache.get(videoId);
	if (cached && cached.expires > Date.now()) return cached.playlists;

	const inFlight = playlistPending.get(videoId);
	if (inFlight) return inFlight;

	const fetching = Promise.all(stream.parts.map(part => download(part.url, part.headers).then(parsePlaylist)))
		.then(playlists => {
			playlistCache.set(videoId, { playlists, expires: Date.now() + CACHE_TTL_MS });
			return playlists;
		})
		.finally(() => playlistPending.delete(videoId));

	playlistPending.set(videoId, fetching);
	return fetching;
}

/** Serves a trimmed playlist to ffmpeg, from this server rather than YouTube. */
export async function handlePlaylist(res: http.ServerResponse, videoId: string, part: number, from: number): Promise<void> {
	try {
		const stream = await resolveStream(videoId);
		const playlists = await ensurePlaylists(videoId, stream);
		const playlist = playlists?.[part];
		if (!playlist) { res.writeHead(404); res.end('No playlist'); return; }

		res.writeHead(200, {
			'Content-Type': 'application/vnd.apple.mpegurl',
			'Cache-Control': 'no-cache'
		});
		res.end(renderPlaylist(playlist, from));
	} catch (e) {
		res.writeHead(502);
		res.end(e instanceof Error ? e.message : String(e));
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

	// Only one video is ever watched at a time, and a stream left running from
	// the previous one keeps fetching ahead — competing for the same connection
	// and making the new start crawl. Closing the response usually stops it, but
	// not always in time, so it is stopped here for certain.
	stopActiveStream();
	// Claimed before the first await: a warm-up waiting on the same lookup would
	// otherwise finish first and start a second ffmpeg for the same video.
	activeVideoId = videoId;

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

		const trimmed = await trimmedInputs(videoId, stream, startAt);
		ff = runTool(tools.ffmpegPath, ffmpegArgs(stream, startAt, trimmed ?? undefined));
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

	activeStream = ff;
	activeVideoId = videoId;
	// Whatever else was fetching — a warm-up nobody claimed, a stream whose
	// reference was lost — has no reader now.
	killStrays(ff);

	ff.stdout.pipe(res);
	ff.on('error', () => res.end());
	// A signed URL that has expired makes ffmpeg fail immediately; the next
	// request then resolves the video again instead of replaying the dead link.
	ff.on('close', code => {
		if (activeStream === ff) activeStream = null;
		if (code !== 0) invalidateStream(videoId);
	});
	res.on('close', () => ff.kill('SIGKILL'));
}

/** Playlists served from here, already cut to where playback begins. */
export type TrimmedInputs = { urls: string[]; offset: number };

/**
 * Points ffmpeg at trimmed playlists instead of YouTube's own.
 *
 * Handed the original playlist with `-ss`, ffmpeg first fetches the opening
 * segments to probe the stream and only then jumps — so every seek pays for
 * megabytes it throws away, plus a slow round trip to manifest.googlevideo.
 * Starting the playlist at the seek point removes both.
 */
async function trimmedInputs(videoId: string, stream: StreamInfo, startAt: number): Promise<TrimmedInputs | null> {
	if (!serverPort) return null;

	let playlists: Playlist[] | null;
	try {
		playlists = await ensurePlaylists(videoId, stream);
	} catch {
		// Falling back to YouTube's playlist is slower, but it still plays.
		return null;
	}
	if (!playlists || playlists.length !== stream.parts.length) return null;

	// Every part is cut at the same moment, so the tracks stay aligned.
	const cut = segmentAt(playlists[0], startAt);
	const urls = playlists.map((_, index) =>
		`http://127.0.0.1:${serverPort}/playlist?v=${encodeURIComponent(videoId)}&i=${index}&from=${cut.index}`);

	return { urls, offset: Math.max(0, startAt - cut.startsAt) };
}

/**
 * The ffmpeg command that turns a resolved stream into what the webview plays:
 * H.264 copied through, audio re-encoded to MP3, wrapped in fragmented MP4.
 *
 * Both inputs of a video+audio pair are opened at the same offset, which is
 * what keeps them in sync when playback starts anywhere but the beginning.
 */
export function ffmpegArgs(stream: StreamInfo, startAt = 0, trimmed?: TrimmedInputs): string[] {
	const args = ['-loglevel', 'error'];

	stream.parts.forEach((part, index) => {
		args.push(...headerArgs(part.headers));
		// With a trimmed playlist the input already begins near the seek point,
		// so only the remainder inside its first segment is left to skip.
		const offset = trimmed ? trimmed.offset : startAt;
		if (offset > 0) args.push('-ss', String(offset));
		args.push('-i', trimmed ? trimmed.urls[index] : part.url);
	});

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
	// share that is moves with its bot checks; a newer yt-dlp often gets in.
	if (/not a bot|sign in to confirm/i.test(message)) {
		return 'YouTube refused this video to an anonymous session. A newer yt-dlp often gets past it.';
	}

	if (/is not available|private video|members-only|age/i.test(message)) {
		return message.replace(/\s+See\s+https:\S+.*$/s, '').trim();
	}

	return message;
}

/**
 * The command that updates yt-dlp on this machine.
 *
 * Which one it is depends on how it was installed — a Homebrew copy cannot
 * update itself, a pipx one is not updated by pip — so the path it was found at
 * decides, and only a plain binary is told to update itself.
 */
export function updateCommand(toolPath: string | null, command: string): string {
	const path = (toolPath || command).toLowerCase();

	if (path.includes('cellar') || path.includes('homebrew') || path.includes('linuxbrew')) {
		return 'brew upgrade yt-dlp';
	}
	if (path.includes('pipx')) return 'pipx upgrade yt-dlp';
	if (path.includes('site-packages') || path.includes('python')) return 'python3 -m pip install -U yt-dlp';
	if (path.includes('scoop')) return 'scoop update yt-dlp';
	if (path.includes('chocolatey')) return 'choco upgrade yt-dlp';
	if (process.platform === 'win32') return 'winget upgrade yt-dlp.yt-dlp';

	// A standalone build knows how to replace itself.
	return `${command} -U`;
}

/** Where the tool actually lives, so the right update command can be named. */
function toolPath(command: string): Promise<string | null> {
	if (command.includes('/') || command.includes('\\')) return Promise.resolve(command);

	return new Promise(resolve => {
		const proc = spawn(process.platform === 'win32' ? 'where' : 'which', [command]);
		const out: Buffer[] = [];
		proc.stdout.on('data', c => out.push(c));
		proc.on('error', () => resolve(null));
		proc.on('close', code => {
			if (code !== 0) { resolve(null); return; }
			resolve(Buffer.concat(out).toString('utf8').split(/\r?\n/)[0].trim() || null);
		});
	});
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
		const raw = e instanceof Error ? e.message : String(e);
		// A bot check is the one failure the viewer can act on, so the command
		// that updates yt-dlp comes with it, ready to copy.
		const fix = /not a bot|sign in to confirm/i.test(raw)
			? updateCommand(await toolPath(tools.ytDlpPath), tools.ytDlpPath)
			: undefined;

		res.writeHead(missing ? 501 : 502);
		res.end(JSON.stringify({ error: explain(raw), fix }));
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
		/* Covers the whole frame, so without this it swallows every click meant
		   for the picture — pausing by clicking would stop working. */
		pointer-events: none;
	}
	/* The suggested command is the one part of the notice worth reaching for. */
	#msg .msg-inner { max-width: 520px; }
	#msg-fix {
		display: flex; align-items: center; gap: 10px; margin-top: 14px;
		background: rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.12);
		border-radius: 6px; padding: 8px 10px; pointer-events: auto;
	}
	#msg-fix[hidden] { display: none; }
	#msg-command {
		flex: 1; text-align: left; overflow-x: auto; white-space: pre;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
		color: #fff; user-select: all;
	}
	#msg-copy {
		border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.1);
		color: #fff; border-radius: 5px; padding: 4px 10px; font: inherit;
		font-size: 12px; cursor: pointer;
	}
	#msg-copy:hover { background: rgba(255,255,255,.18); }
	#spin {
		position: absolute; left: 50%; top: 50%; width: 34px; height: 34px; margin: -17px 0 0 -17px;
		border: 3px solid rgba(255,255,255,.25); border-top-color: #fff; border-radius: 50%;
		display: none; animation: spin 1s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	/* Shown when the browser refuses to start with sound. Deliberately large and
	   centred: it is the one thing to aim at, and it takes the click whether or
	   not the video has loaded yet. */
	#unmute {
		position: absolute; inset: 0; display: none;
		align-items: center; justify-content: center;
		background: rgba(0,0,0,.35); border: none; padding: 0; margin: 0;
		cursor: pointer; color: #fff;
	}
	#unmute.shown { display: flex; }
	#unmute .circle {
		width: 76px; height: 76px; border-radius: 50%;
		background: rgba(0,0,0,.6); border: 2px solid rgba(255,255,255,.85);
		display: flex; align-items: center; justify-content: center;
		transition: transform .15s, background .15s;
	}
	#unmute:hover .circle { transform: scale(1.06); background: rgba(0,0,0,.75); }
	#unmute svg { display: block; }
	#unmute .hint {
		position: absolute; bottom: 30%; left: 0; right: 0; text-align: center;
		font-size: 12px; color: rgba(255,255,255,.85); text-shadow: 0 1px 3px rgba(0,0,0,.8);
	}
</style>
</head>
<body>
<div id="stage">
	<video id="v" playsinline></video>
	<div id="spin"></div>
	<button id="unmute" title="Play with sound">
		<span class="circle">
			<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"
				stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M4 9v6h4l5 4V5L8 9H4z"/>
				<line x1="16" y1="9" x2="21" y2="15"/>
				<line x1="21" y1="9" x2="16" y2="15"/>
			</svg>
		</span>
		<span class="hint">Click to play with sound</span>
	</button>
	<div id="msg">
		<div class="msg-inner">
			<div id="msg-text"></div>
			<div id="msg-fix" hidden>
				<code id="msg-command"></code>
				<button id="msg-copy">Copy</button>
			</div>
		</div>
	</div>
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
	var msgText = document.getElementById('msg-text');
	var msgFix = document.getElementById('msg-fix');
	var msgCommand = document.getElementById('msg-command');
	var copyBtn = document.getElementById('msg-copy');
	var spin = document.getElementById('spin');
	var unmute = document.getElementById('unmute');

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
	// Recovery attempts since the last time playback actually ran.
	var retries = 0;
	var MAX_RETRIES = 3;
	// Whether playback was running when it broke, so the retry resumes it.
	var wasPlaying = false;

	function send(data) { window.parent.postMessage(data, '*'); }

	function logError(message, detail) {
		send({ type: 'proxyLog', level: 'error', message: '[YOUTUBE_EXT][PROXY] ' + message, args: detail ? [String(detail)] : [] });
	}

	function showMessage(text, command) {
		msgText.textContent = text || '';
		msg.style.display = text ? 'flex' : 'none';

		msgCommand.textContent = command || '';
		msgFix.hidden = !command;
		copyBtn.textContent = 'Copy';
	}

	// The clipboard API is not always granted inside a webview, hence the
	// hidden-selection fallback.
	copyBtn.addEventListener('click', function() {
		var text = msgCommand.textContent;
		var done = function(ok) {
			copyBtn.textContent = ok ? 'Copied' : 'Select and copy';
			setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1600);
		};

		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(function() { done(true); }, function() { copyFallback(text, done); });
			return;
		}
		copyFallback(text, done);
	});

	function copyFallback(text, done) {
		var area = document.createElement('textarea');
		area.value = text;
		area.style.position = 'fixed';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		var ok = false;
		try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
		document.body.removeChild(area);
		done(ok);
	}

	function showSpinner(on) { spin.style.display = on ? 'block' : 'none'; }

	/**
	 * Starting with sound needs a click somewhere in this frame first; browsers
	 * only allow a muted start until then. So playback begins muted with the
	 * button up, and the click that presses it — whenever it comes, before the
	 * video has loaded or after — is what turns the sound on.
	 */
	function offerSound(on) {
		unmute.classList.toggle('shown', on);
	}

	function play() {
		wasPlaying = true;
		var promise = video.play();
		if (!promise || !promise.catch) return;

		promise.catch(function(err) {
			// play() also rejects when a new load interrupts it, which happens
			// routinely while starting; only a refusal by policy means the sound
			// is what stands in the way.
			if (!err || err.name !== 'NotAllowedError') return;

			video.muted = true;
			offerSound(true);
			var muted = video.play();
			if (muted && muted.catch) muted.catch(function() { /* the button is up */ });
		});
	}

	unmute.addEventListener('click', function() {
		video.muted = false;
		muteBtn.textContent = '🔊';
		offerSound(false);
		// The click counts as the gesture, so this attempt is allowed.
		var promise = video.play();
		if (promise && promise.catch) promise.catch(function() {});
	});

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
		wasPlaying = Boolean(autoplay);
		// Whatever went wrong before is being retried right now; the old notice
		// must not sit over a picture that plays again.
		showMessage('');
		showSpinner(true);
		video.src = mediaUrl(videoId, offset);
		video.load();
		if (autoplay) play();
		paint();
	}

	function loadInfo(id) {
		return fetch('/info?v=' + encodeURIComponent(id))
			.then(function(r) { return r.json().then(function(body) { return { ok: r.ok, body: body }; }); })
			.then(function(res) {
				if (!res.ok) {
					var failure = new Error(res.body && res.body.error || 'Failed to resolve the video');
					// The server may name a command that fixes it; the notice offers
					// it for copying.
					failure.fix = res.body && res.body.fix;
					throw failure;
				}
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
			showMessage(String(err && err.message || err), err && err.fix);
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
			// A press here is a gesture, so sound is allowed again.
			video.muted = false;
			offerSound(false);
			play();
		} else {
			wasPlaying = false;
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
	video.addEventListener('playing', function() {
		showSpinner(false);
		// Playback runs again: the failure is over and the budget is fresh.
		showMessage('');
		retries = 0;
		wasPlaying = true;
		// Playing with sound is proof the offer is not needed.
		if (!video.muted) offerSound(false);
		reportState(1);
		revealBar();
		paint();
	});
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
		var code = err ? err.code : 0;

		// A stream that dies mid-playback — the encode ended, the link expired,
		// what arrived no longer decodes — is fixed the same way: ask the server
		// for it again from where playback stood. Retries are capped so a video
		// that truly cannot play stops rather than loops.
		if ((code === 2 || code === 3) && retries < MAX_RETRIES) {
			retries++;
			logError('Media element error, retrying', code);
			startStream(position(), !video.paused || wasPlaying);
			return;
		}

		showMessage('Playback failed' + (err ? ' (code ' + code + ')' : ''));
		logError('Media element error', code);
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
			else if (autoplay) play(); else video.pause();
			return;
		}

		if (data.event === 'command') {
			if (data.func === 'playVideo') {
				// The stream is let go while a video is cued or after a failure,
				// and play() alone would have nothing to play: fetch it again
				// from where playback stood.
				if (playing) play();
				else startStream(position(), true);
			}
			else if (data.func === 'pauseVideo') { wasPlaying = false; video.pause(); }
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
