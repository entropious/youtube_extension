// Насколько звук расходится с картинкой на длинном видео.
//
//   node .probe/avsync.js [videoId|auto] [минут] [высота] [plain|fix|cuts|drift|seek]
//
// plain — видео прогоняется через те же resolveStream и ffmpegArgs, что и в
// расширении, только в файл и без оглядки на реальное время. Потом по пакетам
// аудио считается, где звук оказался бы у плеера, играющего его сплошняком по
// счёту сэмплов, против того, где он стоит по своим меткам времени.
// fix — тот же прогон с aresample=async, который подгоняет сэмплы под метки.
// cuts — без ffmpeg: где начинается сегмент с одним и тем же номером в
// плейлисте видео и в плейлисте звука по их длительностям.
// drift — то же по настоящему времени: метки TS у видео, число сэмплов у звука.
// seek — перемотка целиком через /media; точки задаёт AVSYNC_AT=сек,сек,...
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const yt = require('../out/ytproxy');

/** Скачивает целиком, с повторами: googlevideo иногда отвечает пустым телом. */
function get(url, headers = {}, tries = 4) {
	return new Promise((resolve, reject) => {
		https.get(url, { headers }, res => {
			if (res.statusCode >= 300 && res.headers.location) return resolve(get(res.headers.location, headers, tries));
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => {
				const body = Buffer.concat(chunks);
				if (res.statusCode === 200 && body.length > 0) return resolve(body);
				if (tries <= 1) return reject(new Error(`сегмент: ${res.statusCode}, ${body.length} байт`));
				setTimeout(() => resolve(get(url, headers, tries - 1)), 1000);
			});
		}).on('error', reject);
	});
}

const [idArg = 'auto', minutesArg = '20', heightArg = '360', variant = 'plain'] = process.argv.slice(2);
const seconds = Number(minutesArg) * 60;
const out = path.join(__dirname, `avsync-${variant}.mp4`);

// auto — первое подходящее по длине из поиска, auto:<запрос> — по своему запросу.
function findLongVideo(query) {
	const r = spawnSync('yt-dlp', ['--flat-playlist', '--print', '%(id)s %(duration)s',
		`ytsearch15:${query || 'full lecture course'}`], { encoding: 'utf8' });
	const hit = r.stdout.split('\n').map(l => l.split(' ')).find(([, d]) => Number(d) > seconds + 60);
	if (!hit) throw new Error('не нашлось видео длиннее ' + minutesArg + ' мин');
	return hit[0];
}

function probe(args) {
	const r = spawnSync('ffprobe', ['-v', 'error', ...args, out], { encoding: 'utf8', maxBuffer: 1 << 28 });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

(async () => {
	const videoId = idArg.startsWith('auto') ? findLongVideo(idArg.slice(5)) : idArg;
	yt.setToolConfig({ ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', maxHeight: Number(heightArg) });
	const stream = await yt.resolveStream(videoId);
	console.log(`видео ${videoId}, ${stream.parts.length === 1 ? 'один поток' : 'пара потоков'}, ` +
		`${stream.parts.map(p => p.url.includes('m3u8') ? 'HLS' : 'progressive').join('+')}, ${minutesArg} мин`);

	if (variant === 'seek') {
		// Перемотка целиком, как в расширении: /media?t= через тот же сервер,
		// ffmpeg читает обрезанные плейлисты с него же. В выходе ищется, какой
		// момент исходника показывает картинка (декодированные кадры сверяются по
		// контрольной сумме с сегментом YouTube) и какой играет звук (корреляция
		// с исходным звуком того же сегмента).
		const http = require('http');
		const [v, a] = await yt.ensurePlaylists(videoId, stream);
		const server = http.createServer((req, res) => {
			const u = new URL(req.url, 'http://x');
			const q = k => u.searchParams.get(k);
			if (u.pathname === '/playlist') return void yt.handlePlaylist(res, q('v'), Number(q('i')), Number(q('from')));
			if (u.pathname === '/media') return void yt.handleMedia(res, q('v'), Number(q('t')));
			res.writeHead(404).end();
		});
		await new Promise(r => server.listen(0, '127.0.0.1', r));
		yt.setServerPort(server.address().port);

		const frames = (file, limit) => {
			const r = spawnSync('ffmpeg', ['-v', 'info', '-copyts', '-i', file, '-map', '0:v:0',
				'-frames:v', String(limit), '-vf', 'showinfo', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
			return [...r.stderr.matchAll(/pts_time:(\S+).*?checksum:(\S+)/g)].map(m => ({ t: Number(m[1]), sum: m[2] }));
		};
		const pcm = (file, seconds) => {
			const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-t', String(seconds),
				'-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
			const b = r.stdout;
			const out = new Float32Array(b.length / 2);
			for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2);
			return out;
		};
		const firstPts = (file, kind) => parseFloat(spawnSync('ffprobe', ['-v', 'error', '-select_streams', kind,
			'-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout);

		const targets = (process.env.AVSYNC_AT || '603.3,1203.1,1800').split(',').map(Number);
		for (const at of targets) {
			const file = path.join(__dirname, 'avsync-seek.mp4');
			await new Promise((resolve, reject) => {
				const sink = fs.createWriteStream(file);
				let bytes = 0;
				const req = http.get(`http://127.0.0.1:${server.address().port}/media?v=${videoId}&t=${at}`, res => {
					res.on('data', c => {
						sink.write(c);
						bytes += c.length;
						if (bytes > 14e6) { req.destroy(); sink.end(resolve); }
					});
					res.on('end', () => sink.end(resolve));
				});
				req.on('error', () => sink.end(resolve));
				setTimeout(() => { req.destroy(); sink.end(resolve); }, 60000);
			});

			const cut = yt.segmentAt(v, at);
			const seg = v.segments[cut.index].url;
			const v0 = frames(v.segments[0].url, 1)[0].t;

			// Картинка: первый кадр выхода, найденный среди кадров сегмента.
			const outFrames = frames(file, 5);
			const srcFrames = frames(seg, 400);
			const match = srcFrames.find(f => f.sum === outFrames[0].sum);
			const videoSrc = match ? match.t - v0 : NaN;
			const videoOut = outFrames[0].t;

			// Звук: окно в 2 с из выхода, начиная с 1 с, ищется в звуке сегмента.
			const outPcm = pcm(file, 4);
			const aSeg = path.join(__dirname, 'avsync-src.aac');
			fs.writeFileSync(aSeg, Buffer.concat(await Promise.all([cut.index, cut.index + 1].map(i =>
				get(a.segments[i].url, stream.parts[1].headers)))));
			const srcPcm = pcm(aSeg, 12);
			const win = outPcm.subarray(8000, 24000);
			let best = -Infinity, lag = 0;
			for (let L = 0; L + win.length <= srcPcm.length; L++) {
				let s = 0, e = 0;
				for (let i = 0; i < win.length; i += 2) { s += win[i] * srcPcm[L + i]; e += srcPcm[L + i] * srcPcm[L + i]; }
				const score = s / Math.sqrt(e || 1);
				if (score > best) { best = score; lag = L; }
			}
			const audioOut = firstPts(file, 'a:0');
			// PCM выхода начинается с первого пакета звука; окно взято через 1 с.
			const audioSrcAtWindow = cut.startsAt + lag / 8000;
			const audioSrc = audioSrcAtWindow - 1;

			console.log(`\nперемотка на ${at} с: сегмент ${cut.index} с ${cut.startsAt.toFixed(2)} с, внутри ${(at - cut.startsAt).toFixed(2)} с`);
			console.log(`  картинка: первый кадр выхода pts ${videoOut.toFixed(3)} = исходник ${videoSrc.toFixed(3)} с`);
			console.log(`  звук:     первый пакет выхода pts ${audioOut.toFixed(3)} = исходник ${audioSrc.toFixed(3)} с`);
			const dv = videoSrc - videoOut, da = audioSrc - audioOut;
			console.log(`  звук опережает картинку на ${((da - dv) * 1000).toFixed(0)} мс`);
			fs.unlinkSync(file); fs.unlinkSync(aSeg);
		}
		yt.shutdownStreams();
		server.close();
		return;
	}

	if (variant === 'drift') {
		// Звук в этих плейлистах — голый ADTS без меток, так что его настоящее
		// время — это число сэмплов во всех сегментах до него. Видео — TS со
		// своими метками. Перемотка режет оба плейлиста на сегменте N и приводит
		// каждый вход к нулю, поэтому их разница в сегменте N и есть рассинхрон.
		const [v, a] = await yt.ensurePlaylists(videoId, stream);
		const adtsFrames = buf => {
			let i = 0, frames = 0;
			if (buf.slice(0, 3).toString() === 'ID3') i = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]);
			while (i + 7 <= buf.length) {
				if (buf[i] !== 0xff || (buf[i + 1] & 0xf0) !== 0xf0) { i++; continue; }
				const len = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
				frames += (buf[i + 6] & 3) + 1;
				i += Math.max(len, 7);
			}
			return frames;
		};
		const tsStart = url => {
			const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time',
				'-of', 'csv=p=0', url], { encoding: 'utf8' });
			const n = parseFloat(r.stdout);
			if (Number.isNaN(n)) throw new Error(`ffprobe видео: ${r.stderr.slice(0, 300)}`);
			return n;
		};

		const step = Math.max(1, Math.round(Number(minutesArg) / 10));
		const points = [];
		for (let m = 0; m <= Number(minutesArg); m += step) {
			const cut = yt.segmentAt(v, m * 60);
			if (m * 60 >= cut.startsAt + v.segments[cut.index].duration) break;
			points.push({ m, index: cut.index, extinf: cut.startsAt });
		}
		const last = points[points.length - 1].index;
		const frames = new Array(last).fill(0);
		const headers = stream.parts[1].headers || {};
		for (let i = 0; i < last; i += 8) {
			await Promise.all(a.segments.slice(i, Math.min(i + 8, last)).map((s, k) =>
				get(s.url, headers).then(b => { frames[i + k] = adtsFrames(b); })));
		}
		const v0 = tsStart(v.segments[0].url);
		console.log(`сегментов звука скачано ${last}, видео TS начинается с ${v0.toFixed(3)} с`);
		console.log('минута   сегмент   по плейлисту   видео (TS)   звук (сэмплы)   звук позже картинки');
		for (const p of points) {
			const video = tsStart(v.segments[p.index].url) - v0;
			const audio = frames.slice(0, p.index).reduce((s, f) => s + f, 0) * 1024 / 44100;
			console.log(`${String(p.m).padStart(6)}   ${String(p.index).padStart(7)}   ${p.extinf.toFixed(3).padStart(12)}   ${video.toFixed(3).padStart(10)}   ${audio.toFixed(3).padStart(13)}   ${((audio - video) * 1000).toFixed(0).padStart(10)} мс`);
		}
		return;
	}

	if (variant === 'cuts') {
		const lists = await yt.ensurePlaylists(videoId, stream);
		if (!lists || lists.length < 2) { console.log('один плейлист — резать нечего'); return; }
		const [v, a] = lists;
		const durs = l => l.segments.map(s => s.duration);
		const uniq = xs => [...new Set(xs.map(x => x.toFixed(3)))].slice(0, 6).join(', ');
		console.log('заголовок видео:', v.header.join(' | ').slice(0, 400));
		console.log('заголовок звука:', a.header.join(' | ').slice(0, 400));
		console.log('сегмент видео:', v.segments[1].url.slice(0, 200));
		console.log('сегмент звука:', a.segments[1].url.slice(0, 200));
		console.log(`сегментов: видео ${v.segments.length} (${uniq(durs(v))}), звук ${a.segments.length} (${uniq(durs(a))})`);
		// Первые метки времени в самих сегментах: ffmpeg приводит к нулю каждый
		// вход отдельно, так что их разница в сегменте, с которого начали,
		// и становится сдвигом звука относительно картинки.
		const first = (url, kind) => {
			const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', kind, '-show_entries',
				'packet=pts_time', '-read_intervals', '%+#8', '-of', 'csv=p=0', url], { encoding: 'utf8' });
			const pts = Math.min(...r.stdout.trim().split('\n').map(Number).filter(n => !Number.isNaN(n)));
			if (Number.isNaN(pts)) console.log(`  ffprobe ${kind}: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 300)}`);
			return pts;
		};
		for (const [name, l] of [['видео', v], ['звук', a]]) {
			const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
				'format=format_name,start_time,duration:stream=codec_name,start_time,duration,r_frame_rate,sample_rate',
				'-of', 'compact', l.segments[5].url], { encoding: 'utf8' });
			console.log(`контейнер ${name}: ${r.stdout.trim().replace(/\n/g, ' ; ')} ${r.stderr.slice(0, 200)}`);
		}
		console.log('минута   сегмент   видео pts    звук pts    звук позже картинки');
		let base = null;
		for (let m = 0; m <= Number(minutesArg); m += Math.max(1, Math.round(Number(minutesArg) / 10))) {
			const cut = yt.segmentAt(v, m * 60);
			if (m * 60 >= cut.startsAt + v.segments[cut.index].duration) break;
			const vp = first(v.segments[cut.index].url, 'v:0');
			const ap = first(a.segments[cut.index].url, 'a:0');
			const d = (ap - vp) * 1000;
			if (base === null) base = d;
			console.log(`${String(m).padStart(6)}   ${String(cut.index).padStart(7)}   ${vp.toFixed(3).padStart(9)}   ${ap.toFixed(3).padStart(9)}   ${d.toFixed(0).padStart(8)} мс (от начала ${(d - base).toFixed(0)})`);
		}
		console.log('минута   сегмент   видео с   звук с   звук отстаёт');
		for (let m = 0; m <= Number(minutesArg); m += Math.max(1, Math.round(Number(minutesArg) / 10))) {
			const cut = yt.segmentAt(v, m * 60);
			const audioStart = a.segments.slice(0, cut.index).reduce((s, x) => s + x.duration, 0);
			console.log(`${String(m).padStart(6)}   ${String(cut.index).padStart(7)}   ${cut.startsAt.toFixed(2).padStart(7)}   ${audioStart.toFixed(2).padStart(6)}   ${((cut.startsAt - audioStart) * 1000).toFixed(0).padStart(9)} мс`);
		}
		return;
	}

	const args = yt.ffmpegArgs(stream);
	args[args.lastIndexOf('pipe:1')] = out;
	const at = args.indexOf('-c:a');
	args.splice(at, 0, '-t', String(seconds));
	if (variant === 'fix') args.splice(at, 0, '-af', 'aresample=async=1:first_pts=0');
	args.unshift('-y');

	const started = Date.now();
	await new Promise((resolve, reject) => {
		const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
		let err = '';
		ff.stderr.on('data', c => { err += c; });
		ff.on('exit', code => code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ': ' + err)));
	});
	console.log(`ffmpeg: ${((Date.now() - started) / 1000).toFixed(0)} с, ${(fs.statSync(out).size / 1e6).toFixed(0)} МБ`);

	const rate = Number(probe(['-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0']));
	const frame = 1152 / rate;
	const pts = probe(['-select_streams', 'a:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0'])
		.split('\n').map(Number);
	const video = probe(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0'])
		.split('\n').map(Number).filter(n => !Number.isNaN(n));

	let gaps = 0, overlaps = 0;
	for (let k = 1; k < pts.length; k++) {
		const step = pts[k] - pts[k - 1] - frame;
		if (step > 0.001) gaps++;
		if (step < -0.001) overlaps++;
	}
	console.log(`аудио ${rate} Гц, ${pts.length} кадров; дыр ${gaps}, нахлёстов ${overlaps}`);
	console.log(`начало: аудио ${pts[0].toFixed(3)} с, видео ${Math.min(...video).toFixed(3)} с`);

	console.log('минута   звук по меткам   звук по счёту   звук опережает');
	for (let m = 0; m <= Number(minutesArg); m += Math.max(1, Math.round(Number(minutesArg) / 10))) {
		const k = pts.findIndex(p => p >= m * 60);
		if (k < 0) break;
		const counted = pts[0] + k * frame;
		const ahead = (pts[k] - counted) * 1000;
		console.log(`${String(m).padStart(6)}   ${pts[k].toFixed(3).padStart(14)}   ${counted.toFixed(3).padStart(13)}   ${ahead.toFixed(0).padStart(11)} мс`);
	}

	fs.unlinkSync(out);
})().catch(e => { console.error(e.message); process.exit(1); });
