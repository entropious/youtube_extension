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
	/** Browser to take YouTube cookies from, as accepted by --cookies-from-browser. */
	cookiesFromBrowser: string;
	/** Path to a Netscape-format cookie file. */
	cookiesFile: string;
};

let tools: ToolConfig = {
	ytDlpPath: 'yt-dlp',
	ffmpegPath: 'ffmpeg',
	maxHeight: 1080,
	cookiesFromBrowser: '',
	cookiesFile: ''
};

export function setToolConfig(config: Partial<ToolConfig>): void {
	tools = { ...tools, ...config };
	streamCache.clear();
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

function runYtDlp(videoId: string): Promise<StreamInfo> {
	// HLS first, and by a wide margin: its segments are read by plain GETs, so
	// ffmpeg can both stream and seek them. The direct googlevideo links of the
	// progressive and adaptive formats answer 403 to the open byte range ffmpeg
	// asks for, and accept only small closed ranges — usable by yt-dlp itself,
	// but not by ffmpeg, which is why they sit at the end as a last resort.
	// Within HLS a combined rendition wins over a video+audio pair: one playlist
	// resolves several times faster.
	const height = tools.maxHeight;
	const format = [
		`b[protocol^=m3u8][vcodec^=avc1][acodec!=none][height<=${height}]`,
		`bv*[protocol^=m3u8][vcodec^=avc1][height<=${height}]+ba[protocol^=m3u8]`,
		'b[protocol=https][vcodec^=avc1][acodec!=none]',
		`bv*[vcodec^=avc1][height<=${height}]+ba[ext=m4a]`,
		'b'
	].join('/');

	const args = [
		'--no-playlist',
		'--no-warnings',
		'--no-progress',
		'-f', format,
		'-J'
	];
	// YouTube answers some requests with a bot check that only a signed-in
	// session gets past.
	if (tools.cookiesFromBrowser) args.push('--cookies-from-browser', tools.cookiesFromBrowser);
	if (tools.cookiesFile) args.push('--cookies', tools.cookiesFile);
	args.push(`https://www.youtube.com/watch?v=${videoId}`);

	return new Promise((resolve, reject) => {
		const proc = spawn(tools.ytDlpPath, args);
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
				const data = JSON.parse(Buffer.concat(out).toString('utf8'));
				// A pair selection reports both halves in requested_formats, video
				// first; a combined format describes itself at the top level.
				const picked: { url?: string; http_headers?: Record<string, string> }[] =
					Array.isArray(data.requested_formats) ? data.requested_formats : [data];
				const parts = picked
					.filter(f => typeof f?.url === 'string')
					.map(f => ({ url: f.url as string, headers: f.http_headers ?? {} }));
				if (!parts.length) {
					reject(new Error('yt-dlp returned no playable format'));
					return;
				}

				resolve({
					parts,
					duration: typeof data.duration === 'number' ? data.duration : 0,
					title: typeof data.title === 'string' ? data.title : ''
				});
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

	let stream: StreamInfo;
	try {
		stream = await resolveStream(videoId);
	} catch (e) {
		res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end(e instanceof Error ? e.message : String(e));
		return;
	}

	const args = ['-loglevel', 'error'];
	// Every input is opened at the offset, so a video+audio pair stays in sync.
	for (const part of stream.parts) {
		args.push(...headerArgs(part.headers));
		if (startAt > 0) args.push('-ss', String(startAt));
		args.push('-i', part.url);
	}

	const audioInput = stream.parts.length > 1 ? '1:a:0' : '0:a:0?';
	args.push(
		'-map', '0:v:0',
		'-map', audioInput,
		'-c:v', 'copy',
		'-c:a', 'libmp3lame', '-b:a', '128k',
		'-movflags', 'frag_keyframe+empty_moov+default_base_moof',
		'-f', 'mp4', 'pipe:1'
	);

	const ff = spawn(tools.ffmpegPath, args);

	res.writeHead(200, {
		'Content-Type': 'video/mp4',
		'Access-Control-Allow-Origin': '*',
		'Cache-Control': 'no-cache'
	});

	ff.stdout.pipe(res);
	ff.on('error', () => res.end());
	// A signed URL that has expired makes ffmpeg fail immediately; the next
	// request then resolves the video again instead of replaying the dead link.
	ff.on('close', code => { if (code !== 0) invalidateStream(videoId); });
	res.on('close', () => ff.kill('SIGKILL'));
}

/** Turns a yt-dlp failure into something the player page can act on. */
function explain(message: string): string {
	// YouTube serves a share of its catalogue to signed-in sessions only.
	if (/not a bot|sign in to confirm/i.test(message)) {
		return 'YouTube asks this video to be watched from a signed-in session. '
			+ 'Set "youtube-panel.cookiesFromBrowser" (e.g. chrome or safari) to the browser you are signed in with.';
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

		loadInfo(id).then(function(info) {
			if (videoId !== id) return;
			duration = info.duration || 0;
			startStream(startAt, autoplay);
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
		if (video.paused) {
			var p = video.play();
			if (p && p.catch) p.catch(function() {});
		} else {
			video.pause();
		}
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

	stage.addEventListener('pointermove', revealBar);
	stage.addEventListener('pointerdown', revealBar);
	stage.addEventListener('pointerleave', function() {
		if (!video.paused && !seeking) bar.classList.remove('shown');
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

	load(videoId, ${Math.max(0, Math.floor(startTime))}, ${autoplay ? 'true' : 'false'});
})();
</script>
</body>
</html>`;
}
