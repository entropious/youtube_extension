// Опрос плеера в Extension Development Host через CDP.
// Используется из devhost.sh; напрямую: node .probe/devhost-check.js <команда>
//
//   targets                 список CDP-таргетов окна
//   state                   состояние <video> и панели управления
//   play | pause            воспроизведение (с user gesture, иначе webview откажет)
//   seek <сек>              перемотка через ползунок страницы
//   load <videoId> [сек]    команда 'load', как её присылает webview
//   messages <сек>          собрать postMessage-события плеера за N секунд
//   eval <выражение>        произвольный код в контексте страницы плеера

const PORT = process.env.CDP_PORT || 9223;
const PLAYER_URL = '127.0.0.1';

async function targets() {
	const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
	return res.json();
}

async function webviewTarget() {
	const list = await targets();
	const found = list.find(t => (t.url || '').startsWith('vscode-webview://') && (t.url || '').includes('index.html') && t.webSocketDebuggerUrl);
	if (!found) throw new Error('панель расширения не найдена: откройте вид YouTube');
	return found;
}

async function playerTarget() {
	const list = await targets();
	const found = list.find(t => (t.url || '').includes(PLAYER_URL) && t.webSocketDebuggerUrl);
	if (!found) {
		throw new Error('страница плеера не найдена: загрузите видео (devhost.sh load <videoId>)');
	}
	return found;
}

function evaluate(wsUrl, expression, timeoutMs = 60000) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		const timer = setTimeout(() => { ws.close(); reject(new Error('таймаут CDP')); }, timeoutMs);
		const done = fn => value => { clearTimeout(timer); ws.close(); fn(value); };

		ws.onopen = () => ws.send(JSON.stringify({
			id: 1,
			method: 'Runtime.evaluate',
			// Без userGesture webview отклоняет play() по политике автовоспроизведения.
			params: { expression, awaitPromise: true, returnByValue: true, userGesture: true }
		}));

		ws.onmessage = event => {
			const msg = JSON.parse(event.data);
			if (msg.id !== 1) return;
			if (msg.error) return done(reject)(new Error(JSON.stringify(msg.error)));
			if (msg.result?.exceptionDetails) {
				return done(reject)(new Error(msg.result.exceptionDetails.text + ' ' + (msg.result.exceptionDetails.exception?.description || '')));
			}
			done(resolve)(msg.result?.result?.value);
		};

		ws.onerror = () => done(reject)(new Error('ошибка соединения CDP'));
	});
}

function dispatchMouse(wsUrl, x, y) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		const timer = setTimeout(() => { ws.close(); reject(new Error('таймаут CDP')); }, 15000);
		ws.onopen = () => ws.send(JSON.stringify({
			id: 1,
			method: 'Input.dispatchMouseEvent',
			params: { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }
		}));
		ws.onmessage = () => { clearTimeout(timer); ws.close(); resolve(); };
		ws.onerror = () => { clearTimeout(timer); reject(new Error('ошибка соединения CDP')); };
	});
}

/** Нажатие и отпускание в точке — как настоящий клик мышью. */
function dispatchClick(wsUrl, x, y) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		const timer = setTimeout(() => { ws.close(); reject(new Error('таймаут CDP')); }, 15000);
		const press = type => JSON.stringify({
			id: type === 'mousePressed' ? 1 : 2,
			method: 'Input.dispatchMouseEvent',
			params: { type, x, y, button: 'left', clickCount: 1 }
		});

		ws.onopen = () => ws.send(press('mousePressed'));
		ws.onmessage = event => {
			const msg = JSON.parse(event.data);
			if (msg.id === 1) return ws.send(press('mouseReleased'));
			if (msg.id === 2) { clearTimeout(timer); ws.close(); resolve(); }
		};
		ws.onerror = () => { clearTimeout(timer); reject(new Error('ошибка соединения CDP')); };
	});
}

async function run(expression) {
	const target = await playerTarget();
	return evaluate(target.webSocketDebuggerUrl, expression);
}

/** То же для панели: её разметка лежит во вложенном фрейме, он и даёт `doc`. */
async function inPanel(expression) {
	const target = await webviewTarget();
	return evaluate(target.webSocketDebuggerUrl, `(() => {
		const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
		const win = frame ? frame.contentWindow : window;
		const doc = win.document;
		return eval(${JSON.stringify(expression)});
	})()`);
}

// Состояние полосы глав читается со стороны панели: класс, сигналы от плеера и
// число переключений — по нему видно мигание.
async function readChaptersState() {
	const panel = await webviewTarget();
	return evaluate(panel.webSocketDebuggerUrl, `(() => {
		const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
		const win = frame ? frame.contentWindow : window;
		const doc = win.document;
		const mod = doc.getElementById('chapters-module');
		const box = mod && mod.getBoundingClientRect();
		return {
			signals: (win.__zoneMsgs || []).filter(m => m.type === 'pointerZone').map(m => m.bottom),
			classToggles: win.__toggles,
			barHeightVar: doc.body.style.getPropertyValue('--player-bar-height'),
			hasChapters: doc.body.classList.contains('has-chapters'),
			chaptersOpen: doc.body.classList.contains('chapters-open'),
			// Верх полосы выше нижней границы окна = она выехала.
			visible: box ? box.top < doc.documentElement.clientHeight - 4 : null
		};
	})()`);
}

// --- выражения, исполняемые на странице плеера ---

const STATE = `(() => {
	const v = document.querySelector('video');
	const spinner = document.getElementById('spin');
	return {
		videoSrc: v && v.src,
		readyState: v && v.readyState,
		currentTime: v && Math.round(v.currentTime * 10) / 10,
		paused: v && v.paused,
		mediaError: v && v.error && v.error.code,
		label: document.getElementById('time').textContent,
		message: document.getElementById('msg').textContent.slice(0, 200),
		spinnerVisible: spinner ? getComputedStyle(spinner).display !== 'none' : null
	};
})()`;

const collect = (seconds, action) => `(async () => {
	const got = [];
	window.addEventListener('message', e => got.push(e.data));
	${action}
	await new Promise(r => setTimeout(r, ${Math.round(seconds * 1000)}));
	return {
		state: ${STATE},
		playerStates: got.filter(m => m && m.event === 'infoDelivery').map(m => m.info.playerState),
		timeUpdates: got.filter(m => m && m.event === 'timeUpdate').length,
		lastTimeUpdate: got.filter(m => m && m.event === 'timeUpdate').slice(-1)[0],
		playerReady: got.filter(m => m && m.type === 'playerReady').map(m => m.videoId),
		errorsReported: got.filter(m => m && m.type === 'proxyLog').map(m => String(m.message).slice(0, 120))
	};
})()`;

const commands = {
	async targets() {
		for (const t of await targets()) console.log(t.type, '|', (t.url || '').slice(0, 100));
	},

	async state() {
		console.log(JSON.stringify(await run(STATE), null, 1));
	},

	// Что сервер стримит прямо сейчас: по нему видно, был ли поток на месте,
	// когда вкладка попросила его себе.
	async streams() {
		const target = await playerTarget();
		const port = (target.url.match(/127\.0\.0\.1:(\d+)/) || [])[1];
		const res = await fetch(`http://127.0.0.1:${port}/streams`);
		console.log(JSON.stringify(await res.json(), null, 1));
	},

	// Каждая страница плеера отдельно: при переносе видео между панелью и
	// вкладкой их две, и различать их приходится по адресу.
	async players() {
		const list = (await targets()).filter(t => (t.url || '').includes(PLAYER_URL) && t.webSocketDebuggerUrl);
		const states = [];
		for (const target of list) {
			states.push({
				url: target.url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, ''),
				...(await evaluate(target.webSocketDebuggerUrl, STATE))
			});
		}
		console.log(JSON.stringify(states, null, 1));
	},

	// Выражение в контексте панели. Её разметка живёт во вложенном фрейме, а
	// `doc` в выражении — это его документ, где и лежат кнопки вокруг плеера.
	async panel(expression) {
		if (!expression) throw new Error('нужно выражение');
		console.log(JSON.stringify(await inPanel(expression), null, 1));
	},

	// Перенос играющего видео в отдельную вкладку — кнопка в панели.
	async totab() {
		console.log(JSON.stringify(await inPanel(`(() => {
			const button = doc.getElementById('open-btn');
			if (!button) return 'кнопки нет';
			button.click();
			return 'clicked';
		})()`), null, 1));
	},

	// Пока поток не готов, play() прерывается очередной загрузкой источника.
	async ready(timeoutSec = '40') {
		const result = await run(`(async () => {
			const v = document.querySelector('video');
			const until = Date.now() + ${(Number(timeoutSec) || 40) * 1000};
			while (Date.now() < until) {
				if (v.readyState >= 3) return { ready: true, waitedMs: undefined, state: ${STATE} };
				if (document.getElementById('msg').textContent) break;
				await new Promise(r => setTimeout(r, 500));
			}
			return { ready: false, state: ${STATE} };
		})()`);
		console.log(JSON.stringify(result, null, 1));
		if (!result?.ready) process.exit(3);
	},

	async play() {
		console.log(JSON.stringify(await run(collect(8, `
			const v = document.querySelector('video');
			try { await v.play(); } catch (e) { got.push({ type: 'proxyLog', message: 'play() отклонён: ' + e }); }
		`)), null, 1));
	},

	async pause() {
		console.log(JSON.stringify(await run(collect(2, `document.querySelector('video').pause();`)), null, 1));
	},

	async seek(seconds) {
		const target = Number(seconds);
		if (!Number.isFinite(target)) throw new Error('нужны секунды: seek 120');
		console.log(JSON.stringify(await run(collect(14, `
			const seek = document.getElementById('seek');
			const dur = ${target};
			const v = document.querySelector('video');
			// Ползунок нормирован на 1000 шагов от длительности видео.
			const total = Number((document.getElementById('time').textContent.split('/')[1] || '').trim().split(':').reduce((a, p) => a * 60 + Number(p), 0));
			seek.value = String(Math.round(dur / total * 1000));
			seek.dispatchEvent(new Event('change'));
		`)), null, 1));
	},

	async load(videoId, startAt = '0') {
		if (!videoId) throw new Error('нужен videoId: load kJQP7kiw5Fk [сек]');
		console.log(JSON.stringify(await run(collect(16, `
			window.postMessage({ type: 'load', id: ${JSON.stringify(videoId)}, startTime: ${Number(startAt) || 0}, autoplay: true }, '*');
		`)), null, 1));
	},

	async messages(seconds = '5') {
		console.log(JSON.stringify(await run(collect(Number(seconds) || 5, '')), null, 1));
	},

	// Плеер шлёт события наверх, в панель, поэтому принимающую сторону видно
	// только из её собственного контекста.
	async webview(seconds = '6') {
		const target = await webviewTarget();
		const result = await evaluate(target.webSocketDebuggerUrl, `(async () => {
			// Разметка панели живёт во вложенном фрейме контейнера webview.
			const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
			const win = frame ? frame.contentWindow : window;
			const doc = win.document;
			const got = [];
			win.addEventListener('message', e => got.push(e.data));
			await new Promise(r => setTimeout(r, ${(Number(seconds) || 6) * 1000}));
			const status = doc.getElementById('status-text');
			return {
				status: status && status.textContent,
				iframeSrc: (doc.getElementById('video-frame') || {}).src,
				playerStates: got.filter(m => m && m.event === 'infoDelivery').map(m => m.info.playerState),
				timeUpdates: got.filter(m => m && m.event === 'timeUpdate').length,
				lastTime: got.filter(m => m && m.event === 'timeUpdate').slice(-1)[0],
				playerReady: got.filter(m => m && m.type === 'playerReady').map(m => m.videoId),
				errors: got.filter(m => m && m.type === 'proxyLog').map(m => String(m.message).slice(0, 120))
			};
		})()`);
		console.log(JSON.stringify(result, null, 1));
	},

	// Пробел нажимается в панели (фокус обычно там, а не в плеере), клик — по
	// самой картинке; в обоих случаях состояние проверяется у плеера.
	async space() {
		const panel = await webviewTarget();
		await evaluate(panel.webSocketDebuggerUrl, `(() => {
			const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
			const win = frame ? frame.contentWindow : window;
			win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
			return true;
		})()`);
		await new Promise(r => setTimeout(r, 2500));
		console.log(JSON.stringify(await run(STATE), null, 1));
	},

	async click() {
		await run(`(() => { document.querySelector('video').click(); return true; })()`);
		await new Promise(r => setTimeout(r, 2500));
		console.log(JSON.stringify(await run(STATE), null, 1));
	},

	// Настоящее движение мыши к нижнему краю кадра: синтетические события не
	// дают ни :hover, ни того сигнала, по которому выезжают главы.
	async chapters() {
		const player = await playerTarget();
		const panelTarget = await webviewTarget();
		// Счётчик сообщений показывает, дошёл ли сигнал от плеера до панели.
		await evaluate(panelTarget.webSocketDebuggerUrl, `(() => {
			const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
			const win = frame ? frame.contentWindow : window;
			win.__zoneMsgs = [];
			win.addEventListener('message', e => {
				if (e.data && (e.data.type === 'pointerZone' || e.data.type === 'barHeight')) win.__zoneMsgs.push(e.data);
			});
			// Мигание полосы глав видно как череда переключений класса.
			win.__toggles = 0;
			new win.MutationObserver(() => win.__toggles++)
				.observe(win.document.body, { attributes: true, attributeFilter: ['class'] });
			return true;
		})()`);

		// Плеер записывает свои указательные события: видно, что именно
		// сбрасывает зону обратно наверх.
		await evaluate(player.webSocketDebuggerUrl, `(() => {
			window.__events = [];
			const stage = document.getElementById('stage');
			['pointermove', 'pointerleave', 'pointerout', 'mouseleave'].forEach(name => {
				stage.addEventListener(name, e => window.__events.push(name + '@' + Math.round(e.clientY || -1)));
			});
			return true;
		})()`);

		const size = await evaluate(player.webSocketDebuggerUrl, '({ w: innerWidth, h: innerHeight })');
		// Курсор ведётся вниз шагами, как рукой: так видно, дёргается ли полоса
		// по пути и остаётся ли она открытой, когда мышь на ней замерла.
		const x = Math.round(size.w / 2);
		for (let y = Math.round(size.h / 2); y <= size.h - 6; y += 12) {
			await dispatchMouse(player.webSocketDebuggerUrl, x, y);
			await new Promise(r => setTimeout(r, 60));
		}
		await new Promise(r => setTimeout(r, 2500));

		const opened = await readChaptersState();

		// Обратный ход: увести курсор вверх — полоса должна уехать, и тоже один раз.
		for (let y = Math.round(size.h - 6); y >= size.h / 2; y -= 12) {
			await dispatchMouse(player.webSocketDebuggerUrl, x, y);
			await new Promise(r => setTimeout(r, 60));
		}
		await new Promise(r => setTimeout(r, 1200));
		const closed = await readChaptersState();

		const events = await evaluate(player.webSocketDebuggerUrl, 'window.__events || []');
		console.log(JSON.stringify({
			открылась: opened,
			закрылась: closed,
			движенийПлеера: events.length
		}, null, 1));
	},

	// Экран установки: перекрывает панель, пока yt-dlp или ffmpeg не найдены.
	// Проверяется как есть; чтобы увидеть его при установленных инструментах,
	// пропишите в настройках несуществующие пути (см. devhost.sh setup).
	async setup() {
		const panel = await webviewTarget();
		const result = await evaluate(panel.webSocketDebuggerUrl, `(async () => {
			const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
			const win = frame ? frame.contentWindow : window;
			const doc = win.document;
			const gate = doc.getElementById('setup-gate');
			// Нажимается ровно та кнопка, что и рукой: она перепроверяет
			// инструменты и убирает экран, когда всё нашлось.
			const recheck = doc.getElementById('setup-recheck');
			if (recheck) {
				recheck.click();
				await new Promise(r => setTimeout(r, 2000));
			}
			const shown = gate && !gate.hidden;
			// Кнопка Copy сообщает результат собственным текстом.
			let copyResult = null;
			const copyButton = doc.querySelector('#setup-recipes button');
			if (shown && copyButton) {
				copyButton.click();
				await new Promise(r => setTimeout(r, 400));
				copyResult = copyButton.textContent;
			}
			return {
				экранПоказан: Boolean(shown),
				копирование: copyResult,
				заголовок: shown ? doc.getElementById('setup-title').textContent : null,
				инструменты: Array.from(doc.querySelectorAll('#setup-tools li')).map(li => li.textContent.trim().replace(/\\s+/g, ' ')),
				команды: Array.from(doc.querySelectorAll('#setup-recipes code')).map(c => c.textContent),
				перекрываетПанель: shown ? win.getComputedStyle(gate).zIndex : null
			};
		})()`);
		console.log(JSON.stringify(result, null, 1));
	},

	// Синхронизация с Claude: переключатель в панели, хуки в ~/.claude и реакция
	// плеера на состояние, которое пишет хук.
	//   claude            показать текущее состояние
	//   claude on | off   переключить тумблер, как рукой
	//   claude busy|idle  записать состояние хуком и посмотреть на плеер
	async claude(action) {
		const fs = require('fs');
		const os = require('os');
		const path = require('path');
		const stateDir = path.join(os.homedir(), '.claude', 'youtube-panel');
		const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
		const panel = await webviewTarget();

		if (action === 'on' || action === 'off') {
			await evaluate(panel.webSocketDebuggerUrl, `(() => {
				const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
				const doc = (frame ? frame.contentWindow : window).document;
				const box = doc.getElementById('claude-toggle');
				if (box.checked !== ${action === 'on'}) box.click();
				return true;
			})()`);
			await new Promise(r => setTimeout(r, 1500));
		}

		if (action === 'busy' || action === 'idle') {
			// Ровно то, что делает хук Claude Code.
			const { execFileSync } = require('child_process');
			execFileSync('sh', [path.join(stateDir, 'youtube-hook.sh'), action]);
			await new Promise(r => setTimeout(r, 2000));
		}

		const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
		const ourEvents = Object.entries(settings.hooks ?? {})
			.filter(([, entries]) => JSON.stringify(entries).includes('youtube-hook.sh'))
			.map(([event]) => event);

		const ui = await evaluate(panel.webSocketDebuggerUrl, `(() => {
			const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
			const doc = (frame ? frame.contentWindow : window).document;
			const win = frame ? frame.contentWindow : window;
			const box = doc.getElementById('claude-toggle');
			const sync = doc.querySelector('.claude-sync');
			const rect = sync.getBoundingClientRect();
			return {
				тумблер: box ? box.checked : null,
				// Проверка «вверху справа»: ближе к правому краю, чем к левому.
				вверхуСправа: rect.top < 40 && rect.right > doc.documentElement.clientWidth - 40,
				// Прячется вместе с шапкой: обе прозрачны, пока нет наведения.
				прозрачность: {
					переключатель: win.getComputedStyle(sync).opacity,
					шапка: win.getComputedStyle(doc.querySelector('.header')).opacity
				}
			};
		})()`);

		// Наведение на сам переключатель должно его проявить, как и наведение
		// на верхнюю кромку панели.
		const box = await evaluate(panel.webSocketDebuggerUrl, `(() => {
			const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
			const doc = (frame ? frame.contentWindow : window).document;
			const r = doc.querySelector('.claude-sync').getBoundingClientRect();
			return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		})()`);
		await dispatchMouse(panel.webSocketDebuggerUrl, box.x, box.y);
		await new Promise(r => setTimeout(r, 600));
		const hovered = await evaluate(panel.webSocketDebuggerUrl, `(() => {
			const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
			const win = frame ? frame.contentWindow : window;
			return win.getComputedStyle(win.document.querySelector('.claude-sync')).opacity;
		})()`);

		console.log(JSON.stringify({
			...ui,
			прозрачностьПриНаведении: hovered,
			событияХуков: ourEvents,
			скриптХука: fs.existsSync(path.join(stateDir, 'youtube-hook.sh')),
			состояние: fs.existsSync(path.join(stateDir, 'state'))
				? fs.readFileSync(path.join(stateDir, 'state'), 'utf8').trim()
				: null,
			плеер: await run(STATE)
		}, null, 1));
	},

	// Сколько проходит от команды загрузки до первых кадров.
	async timing(videoId = 'kJQP7kiw5Fk') {
		const { execFileSync } = require('child_process');
		const path = require('path');
		const root = path.join(__dirname, '..');
		const code = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
		const args = [
			`--user-data-dir=${path.join(root, '.probe/vscode-user')}`,
			`--extensions-dir=${path.join(root, '.probe/vscode-ext')}`,
			'--open-url',
			`vscode://entro.youtube-panel/load?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${videoId}`
		];

		const started = Date.now();
		execFileSync(code, args, { stdio: 'ignore' });

		let pageAt = 0;
		let readyAt = 0;
		while (Date.now() - started < 60000) {
			try {
				const player = await playerTarget();
				if (!pageAt) pageAt = Date.now();
				const state = await evaluate(player.webSocketDebuggerUrl, `(() => {
					const v = document.querySelector('video');
					return { ready: v ? v.readyState : 0, src: v ? v.src : '' };
				})()`, 5000);
				if (state.src.includes(videoId) && state.ready >= 3) { readyAt = Date.now(); break; }
			} catch {
				// Страница плеера ещё не поднялась.
			}
			await new Promise(r => setTimeout(r, 150));
		}

		// Сетевые тайминги самой страницы: когда она спросила /info и /media и
		// сколько ждала ответа — это отделяет резолв от доставки видео.
		let requests = [];
		try {
			const player = await playerTarget();
			requests = await evaluate(player.webSocketDebuggerUrl, `(() => {
				const ms = v => Math.round(v);
				return performance.getEntriesByType('resource')
					.filter(e => /\\/(info|media)\\?/.test(e.name))
					.map(e => ({
						запрос: e.name.replace(/^https?:\\/\\/[^/]+/, ''),
						начался: ms(e.startTime),
						первыйБайт: ms(e.responseStart),
						закончился: e.responseEnd ? ms(e.responseEnd) : null
					}));
			})()`, 10000);
		} catch {
			// Страница могла не подняться.
		}

		console.log(JSON.stringify({
			видео: videoId,
			страницаПлеера: pageAt ? `${pageAt - started} мс` : 'не появилась',
			первыеКадры: readyAt ? `${readyAt - started} мс` : 'не дождались',
			запросыСтраницы: requests
		}, null, 1));
	},

	// Сколько занимает перемотка: от движения ползунка до кадров с новой позиции.
	async seektiming(seconds = '150') {
		const result = await run(`(async () => {
			const v = document.querySelector('video');
			const seek = document.getElementById('seek');
			const total = (document.getElementById('time').textContent.split('/')[1] || '')
				.trim().split(':').reduce((a, p) => a * 60 + Number(p), 0);
			if (!total) return { ошибка: 'длительность неизвестна' };

			const started = performance.now();
			let ready = 0;
			v.addEventListener('loadeddata', () => { if (!ready) ready = performance.now(); }, { once: true });

			seek.value = String(Math.round(${Number(seconds) || 150} / total * 1000));
			seek.dispatchEvent(new Event('change'));

			const until = performance.now() + 30000;
			while (performance.now() < until && !ready) await new Promise(r => setTimeout(r, 25));

			return {
				перемотка: ready ? Math.round(ready - started) + ' мс' : 'не дождались',
				позиция: document.getElementById('time').textContent,
				играет: !v.paused
			};
		})()`);
		console.log(JSON.stringify(result, null, 1));
	},

	// Обрыв потока, как после долгой паузы: ffmpeg убивается, и видно, поднимет
	// ли плеер воспроизведение сам и уходит ли сообщение об ошибке.
	async recover() {
		const { execSync } = require('child_process');
		const before = await run(STATE);

		try {
			execSync("ps ax -o pid,command | grep '[f]fmpeg -loglevel error' | awk '{print $1}' | xargs -r kill -9");
		} catch { /* процесса могло и не быть */ }

		// Ошибка доходит до элемента не мгновенно, и на восстановление нужен
		// новый запрос к серверу.
		await new Promise(r => setTimeout(r, 9000));
		const after = await run(STATE);

		console.log(JSON.stringify({
			доОбрыва: { играет: !before.paused, время: before.currentTime, сообщение: before.message },
			послеОбрыва: { играет: !after.paused, время: after.currentTime, сообщение: after.message, ошибка: after.mediaError }
		}, null, 1));
	},

	// Настоящий клик в середину кадра: в отличие от video.click() он учитывает,
	// что поверх видео может лежать другой элемент и перехватывать нажатие.
	//   tap            просто клик
	//   tap msg        клик поверх показанного сообщения об ошибке
	//   tap unmute     клик поверх предложения включить звук
	async tap(overlay) {
		const player = await playerTarget();

		if (overlay === 'msg') {
			await evaluate(player.webSocketDebuggerUrl,
				`(() => { const m = document.getElementById('msg'); m.textContent = 'Playback failed (code 3)'; m.style.display = 'flex'; return true; })()`);
		}
		if (overlay === 'unmute') {
			await evaluate(player.webSocketDebuggerUrl,
				`(() => { document.getElementById('unmute').classList.add('shown'); return true; })()`);
		}

		const size = await evaluate(player.webSocketDebuggerUrl, '({ w: innerWidth, h: innerHeight })');
		const x = Math.round(size.w / 2);
		const y = Math.round(size.h / 2);

		const before = await run(STATE);
		const target = await evaluate(player.webSocketDebuggerUrl, `(() => {
			const el = document.elementFromPoint(${x}, ${y});
			return el ? (el.id || el.tagName) : 'ничего';
		})()`);

		await dispatchClick(player.webSocketDebuggerUrl, x, y);
		await new Promise(r => setTimeout(r, 1200));
		const after = await run(STATE);

		console.log(JSON.stringify({
			подКурсором: target,
			доКлика: { играет: !before.paused },
			послеКлика: { играет: !after.paused }
		}, null, 1));
	},

	// Как выглядит отказ YouTube с командой, которую можно скопировать.
	async errorfix() {
		// showMessage живёт в замыкании страницы, поэтому разметка заполняется
		// напрямую — обработчик кнопки висит на самом элементе и сработает.
		const result = await run(`(async () => {
			document.getElementById('msg-text').textContent = 'YouTube refused this video to an anonymous session. A newer yt-dlp often gets past it.';
			document.getElementById('msg-command').textContent = 'brew upgrade yt-dlp';
			document.getElementById('msg-fix').hidden = false;
			document.getElementById('msg').style.display = 'flex';
			await new Promise(r => setTimeout(r, 300));
			document.getElementById('msg-copy').click();
			await new Promise(r => setTimeout(r, 600));
			return {
				сообщение: document.getElementById('msg-text').textContent.slice(0, 60),
				команда: document.getElementById('msg-command').textContent,
				кнопка: document.getElementById('msg-copy').textContent,
				блокВиден: !document.getElementById('msg-fix').hidden
			};
		})()`);
		console.log(JSON.stringify(result, null, 1));
	},

	async eval(expression) {
		if (!expression) throw new Error('нужно выражение');
		console.log(JSON.stringify(await run(expression), null, 1));
	}
};

const [name, ...rest] = process.argv.slice(2);
const command = commands[name];
if (!command) {
	console.error('команды: ' + Object.keys(commands).join(', '));
	process.exit(2);
}

command(...rest).catch(e => { console.error('ошибка:', e.message); process.exit(1); });
