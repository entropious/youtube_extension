import * as vscode from 'vscode';
import * as http from 'http';

let proxyServer: http.Server | null = null;
let proxyPort = 0;

type HistoryEntry = {
	url: string;
	title?: string;
};

function getProxyEmbedHtml(videoId: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>body,html,#p{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;color:#fff;}</style>
</head>
<body>
    <div id="p"></div>
    <script>
        let p;
        let v = '${videoId}';
        
        window.onYouTubeIframeAPIReady = function() {
            try {
                p = new YT.Player('p', {
                    height: '100%', width: '100%', videoId: v,
                    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1, enablejsapi: 1 },
                    events: {
                        onReady: e => { 
                            if(v) e.target.playVideo(); 
                        },
                        onStateChange: e => { 
                            window.parent.postMessage({event:'infoDelivery',info:{playerState:e.data}}, '*'); 
                        }
                    }
                });
            } catch (err) {}
        };

        if (window.YT && window.YT.Player) {
            window.onYouTubeIframeAPIReady();
        }
    </script>
    <script src="https://www.youtube.com/iframe_api"></script>
    <script>
        window.addEventListener('message', e => {
            let data = e.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch(err) { return; }
            }
            if (data.type === 'load') {
                v = data.id;
                if (p && p.loadVideoById) p.loadVideoById(v);
            } else if (data.event === 'command' && p && p[data.func]) {
                p[data.func]();
            }
        });
    </script>
</body>
</html>`;
}

async function startProxyServer(): Promise<void> {
	if (proxyServer && proxyPort) {
		return;
	}

	proxyServer = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		
		if (url.pathname !== '/embed') {
			res.writeHead(404);
			res.end('Not Found');
			return;
		}

		const videoId = url.searchParams.get('v') ?? '';
		if (videoId && !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
			res.writeHead(400); res.end('Invalid video id'); return;
		}

		res.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
			'Cache-Control': 'no-cache'
		});
		res.end(getProxyEmbedHtml(videoId));
	});

	await new Promise<void>((resolve, reject) => {
		proxyServer?.once('error', reject);
		proxyServer?.listen(0, '127.0.0.1', () => {
			const addr = proxyServer?.address();
			if (!addr || typeof addr === 'string') {
				reject(new Error('Failed to bind proxy port'));
				return;
			}

			proxyPort = addr.port;
			resolve();
		});
	});
}

export function deactivate() {
	if (proxyServer) {
		proxyServer.close();
		proxyServer = null;
		proxyPort = 0;
	}
}

export async function activate(context: vscode.ExtensionContext) {
	await startProxyServer();

	const provider = new YouTubeViewProvider(context.extensionUri, context.globalState);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(YouTubeViewProvider.viewType, provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.loadUrl', async () => {
			const url = await vscode.window.showInputBox({
				prompt: "Enter YouTube Video URL",
				placeHolder: "https://www.youtube.com/watch?v=..."
			});
			if (url) {
				provider.loadUrl(url);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.togglePlay', () => {
			provider.togglePlay();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.nextVideo', () => {
			provider.nextVideo();
		})
	);
}

class YouTubeViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'youtube-panel.view';
	private static readonly historyKey = 'youtube-history';

	private _view?: vscode.WebviewView;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _state: vscode.Memento
	) { }

	public togglePlay() {
		this._view?.webview.postMessage({ type: 'togglePlay' });
	}

	public nextVideo() {
		this._view?.webview.postMessage({ type: 'nextVideo' });
	}

	public loadUrl(url: string) {
		if (this._view) {
			void this._handleLoadRequest(url);
			this._view.webview.postMessage({
				type: 'loadUrl',
				value: this._formatYoutubeUrl(url),
				originalUrl: url
			});
		}
	}

	private _formatYoutubeUrl(url: string): string {
		const toEmbed = (id: string): string => {
			if (proxyPort) {
				return `http://127.0.0.1:${proxyPort}/embed?v=${id}`;
			}

			return `https://www.youtube.com/embed/${id}?rel=0&modestbranding=1&playsinline=1&enablejsapi=1&autoplay=1`;
		};

		try {
			const parsed = new URL(url);
			const host = parsed.hostname.replace(/^www\./, '');

			if (host === 'youtu.be') {
				const id = parsed.pathname.split('/').filter(Boolean)[0];
				return id ? toEmbed(id) : url;
			}

			if (host === 'youtube.com' || host === 'm.youtube.com') {
				if (parsed.pathname === '/watch') {
					const id = parsed.searchParams.get('v');
					return id ? toEmbed(id) : url;
				}

				if (parsed.pathname.startsWith('/shorts/')) {
					const id = parsed.pathname.split('/').filter(Boolean)[1];
					return id ? toEmbed(id) : url;
				}

				if (parsed.pathname.startsWith('/embed/')) {
					const id = parsed.pathname.split('/').filter(Boolean)[1];
					return id ? toEmbed(id) : url;
				}
			}
		} catch {
			// Keep original URL if parsing fails.
		}

		return url;
	}

	private async _saveUrl(url: string, title?: string): Promise<void> {
		const normalized = url.trim();
		if (!normalized) {
			return;
		}

		const history = this._getHistory();
		const deduped = history.filter(item => item.url !== normalized);
		deduped.unshift({ url: normalized, title: title });

		await this._state.update(YouTubeViewProvider.historyKey, deduped.slice(0, 50));
	}

	private async _handleLoadRequest(url: string): Promise<void> {
		// Save immediately to avoid race conditions
		await this._saveUrl(url);
		
		const title = await this._resolveTitle(url);
		
		if (title) {
			await this._saveUrl(url, title);
		}
	}

	private _getHistory(): HistoryEntry[] {
		const raw = this._state.get<unknown[]>(YouTubeViewProvider.historyKey, []);
		const history = raw
			.map((item): HistoryEntry | null => {
				if (typeof item === 'string') {
					return { url: item };
				}

				if (item && typeof item === 'object' && 'url' in item && typeof (item as { url: unknown }).url === 'string') {
					const maybeTitle = (item as { title?: unknown }).title;
					return {
						url: (item as { url: string }).url,
						title: typeof maybeTitle === 'string' ? maybeTitle : undefined
					};
				}

				return null;
			})
			.filter((entry): entry is HistoryEntry => Boolean(entry));
		
		return history;
	}

	private async _resolveTitle(url: string): Promise<string | undefined> {
		try {
			const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
			if (!response.ok) {
				return undefined;
			}

			const data = (await response.json()) as { title?: unknown };
			return typeof data.title === 'string' ? data.title : undefined;
		} catch {
			return undefined;
		}
	}

	private async _fetchRelated(videoId: string): Promise<string[]> {
		try {
			const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
				headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
			});
			const text = await res.text();
			const matches = text.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
			const ids = Array.from(matches).map(m => m[1]);
			return [...new Set(ids)].filter(id => id !== videoId);
		} catch {
			return [];
		}
	}

	private async _searchVideos(query: string): Promise<string[]> {
		try {
			const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
			const text = await res.text();
			const matches = text.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
			return [...new Set(Array.from(matches).map(m => m[1]))];
		} catch {
			return [];
		}
	}

	private async _findNextVideo(currentId: string): Promise<string | undefined> {
		const ids = await this._fetchRelated(currentId);
		const filtered = ids.filter(id => id !== currentId);
		return filtered[Math.floor(Math.random() * Math.min(filtered.length, 5))];
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		webviewView.webview.onDidReceiveMessage(async data => {
			switch (data.type) {
				case 'webviewReady': {
					break;
				}
				case 'requestLoad':
					void this._handleLoadRequest(data.value);
					this._view?.webview.postMessage({
						type: 'loadUrl',
						value: this._formatYoutubeUrl(data.value),
						originalUrl: data.value
					});
					break;
				case 'urlSelected':
					void this._saveUrl(data.value);
					break;
				case 'openExternal':
					void vscode.env.openExternal(vscode.Uri.parse(data.value));
					break;
				case 'requestHistory':
					this._view?.webview.postMessage({ type: 'history', value: this._getHistory() });
					break;
				case 'requestNextVideo':
					const nextId = await this._findNextVideo(data.videoId);
					if (nextId) {
						const nextUrl = `https://www.youtube.com/watch?v=${nextId}`;
						this.loadUrl(nextUrl);
					}
					break;
			}
		});

		const last = this._getHistory()[0];
		let initialUrl = 'about:blank';
		let initialOriginalUrl = '';
		if (last) {
			initialUrl = this._formatYoutubeUrl(last.url);
			initialOriginalUrl = last.url;
		}

		webviewView.webview.html = this._getHtmlForWebview(initialUrl, initialOriginalUrl);
	}

	private _getHtmlForWebview(initialUrl: string = 'about:blank', initialOriginalUrl: string = '') {
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-src http://127.0.0.1:* https://www.youtube.com https://youtube.com;">
				<style>
					:root {
						--accent-color: #ff0000;
						--header-bg: rgba(25, 25, 25, 0.9);
						--input-bg: rgba(45, 45, 45, 0.8);
						--transition-speed: 0.3s;
					}

					body {
						margin: 0;
						padding: 0;
						width: 100%;
						height: 100vh;
						display: flex;
						flex-direction: column;
						background-color: #000;
						overflow: hidden;
						font-family: var(--vscode-font-family), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
					}

					.top-hitbox {
						position: absolute;
						top: 0;
						left: 0;
						right: 0;
						height: 60px;
						z-index: 999;
					}

					.header {
						position: absolute;
						top: 0;
						left: 0;
						right: 0;
						display: flex;
						flex-direction: column;
						padding: 8px 12px;
						background: var(--header-bg);
						backdrop-filter: blur(12px);
						border-bottom: 1px solid rgba(255, 255, 255, 0.1);
						z-index: 1000;
						transition: all var(--transition-speed) cubic-bezier(0.4, 0, 0.2, 1);
						transform: translateY(-100%);
						opacity: 0;
						box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8);
					}

					.top-hitbox:hover + .header,
					.header:hover {
						transform: translateY(0);
						opacity: 1;
					}

					.input-row {
						display: flex;
						align-items: center;
						gap: 8px;
						margin-bottom: 8px;
					}

					.settings-row {
						display: flex;
						align-items: center;
						justify-content: space-between;
						font-size: 11px;
						color: rgba(255, 255, 255, 0.7);
					}

					.autoplay-group {
						display: flex;
						align-items: center;
						gap: 8px;
					}

					input[type="text"] {
						flex-grow: 1;
						background: var(--input-bg);
						color: #fff;
						border: 1px solid rgba(255, 255, 255, 0.1);
						border-radius: 4px;
						padding: 6px 10px;
						outline: none;
						transition: border-color 0.2s;
					}

					input[type="text"]:focus {
						border-color: var(--accent-color);
					}

					button {
						background: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border: none;
						border-radius: 4px;
						padding: 6px 12px;
						font-weight: 500;
						cursor: pointer;
						transition: opacity 0.2s;
					}

					button:hover {
						opacity: 0.9;
						background: var(--vscode-button-hoverBackground);
					}

					#history-btn {
						background: transparent;
						font-size: 14px;
						padding: 0 4px;
                        color: #aaa;
					}

					#history-btn:hover {
                        color: #fff;
                    }

					.player-container {
						flex-grow: 1;
						position: relative;
						background: #000;
					}

					iframe {
						width: 100%;
						height: 100%;
						border: none;
					}

					select {
						background: var(--input-bg);
						color: #fff;
						border: 1px solid rgba(255, 255, 255, 0.1);
						border-radius: 3px;
						padding: 2px 4px;
						font-size: 10px;
						outline: none;
					}

					.checkbox-wrapper {
						display: flex;
						align-items: center;
						gap: 4px;
						cursor: pointer;
					}

					.checkbox-wrapper input {
						cursor: pointer;
						accent-color: var(--accent-color);
					}

					.history-dropdown {
						display: none;
						position: absolute;
						top: 100%;
						left: 8px;
						right: 8px;
						background: #1e1e1e;
						border: 1px solid rgba(255, 255, 255, 0.1);
						border-radius: 4px;
						max-height: 300px;
						overflow-y: auto;
						z-index: 2000;
						box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
					}

					.history-item {
						padding: 10px 14px;
						cursor: pointer;
						white-space: nowrap;
						overflow: hidden;
						text-overflow: ellipsis;
						border-bottom: 1px solid rgba(255, 255, 255, 0.05);
						transition: background 0.2s;
						font-size: 12px;
					}

					.history-item:hover {
						background: rgba(255, 255, 255, 0.08);
					}

					.visible {
						display: block;
					}

					#empty-state {
						position: absolute;
						inset: 0;
						display: flex;
						flex-direction: column;
						align-items: center;
						justify-content: center;
						color: #777;
						font-size: 14px;
						z-index: 1;
						pointer-events: none;
						text-align: center;
						padding: 40px;
					}

					#empty-state svg {
						width: 48px;
						height: 48px;
						margin-bottom: 16px;
						fill: #333;
					}
				</style>
			</head>
			<body>
				<div class="top-hitbox"></div>
				<div class="header">
					<div class="input-row">
						<button id="history-btn" title="Recent History">🕒</button>
						<input type="text" id="url-input" placeholder="Paste YouTube URL here...">
						<button id="load-btn">Go</button>
						<button id="next-btn" title="Next (Similar/Popular/Random)">⏭</button>
						<button id="open-btn" title="Open in Browser">↗</button>
					</div>
					<div class="settings-row">
						<div class="autoplay-group">
							<label class="checkbox-wrapper">
								<input type="checkbox" id="autoplay-check">
								Continuous Play (Similar)
							</label>
						</div>
						<div id="status-text">Ready</div>
					</div>
					<div id="history-dropdown" class="history-dropdown"></div>
				</div>
				<div class="player-container">
					<div id="empty-state" style="${initialUrl !== 'about:blank' ? 'display:none' : ''}">
						<svg viewBox="0 0 24 24"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg>
						Paste a YouTube URL to start watching.<br/>
						<span style="font-size:11px; margin-top:8px; opacity:0.6;">Tip: Use Continuous Play to keep the music going.</span>
					</div>
					<iframe id="video-frame" src="${initialUrl}" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share" allowfullscreen></iframe>
				</div>

				<script>
					const vscode = acquireVsCodeApi();
					
					const initialUrl = ${JSON.stringify(initialUrl)};
					const initialOriginalUrl = ${JSON.stringify(initialOriginalUrl)};
					const input = document.getElementById('url-input');
					const loadBtn = document.getElementById('load-btn');
					const nextBtn = document.getElementById('next-btn');
					const openBtn = document.getElementById('open-btn');
					const historyBtn = document.getElementById('history-btn');
					const historyDropdown = document.getElementById('history-dropdown');
					const iframe = document.getElementById('video-frame');
					const emptyState = document.getElementById('empty-state');
					const autoplayCheck = document.getElementById('autoplay-check');
					const statusText = document.getElementById('status-text');

					let currentVideoId = extractVideoId(initialUrl);
					let isPaused = false;

					// Load saved settings
					const state = vscode.getState() || { autoplay: true };
					autoplayCheck.checked = state.autoplay;

					autoplayCheck.addEventListener('change', () => {
						saveState();
					});

					let lastLoadedUrl = initialUrl;
					let lastLoadedOriginalUrl = initialOriginalUrl;

					function saveState() {
						vscode.setState({ 
							autoplay: autoplayCheck.checked,
							currentUrl: lastLoadedUrl,
							currentOriginalUrl: input.value
						});
					}

					
					// Priority: 1. vscode.getState(), 2. initialUrl from extension
					const savedState = vscode.getState();
					let effectiveUrl = (savedState && savedState.currentUrl && savedState.currentUrl !== 'about:blank') 
						? savedState.currentUrl 
						: initialUrl;
					const effectiveOriginalUrl = (savedState && savedState.currentOriginalUrl) 
						? savedState.currentOriginalUrl 
						: initialOriginalUrl;

					// FIX: If the proxy port changed since last save, update it to the current one
					if (effectiveUrl.includes('127.0.0.1') && initialUrl.includes('127.0.0.1')) {
						try {
							const currentPort = new URL(initialUrl).port;
							const savedPort = new URL(effectiveUrl).port;
							if (currentPort && savedPort && currentPort !== savedPort) {
								effectiveUrl = effectiveUrl.replace('127.0.0.1:' + savedPort, '127.0.0.1:' + currentPort);
							}
						} catch (e) {
							// Ignored
						}
					}

					lastLoadedUrl = effectiveUrl;
					lastLoadedOriginalUrl = effectiveOriginalUrl;

					if (effectiveOriginalUrl) {
						input.value = effectiveOriginalUrl;
					}
					
					if (effectiveUrl && effectiveUrl !== 'about:blank') {
						iframe.src = effectiveUrl;
						emptyState.style.display = 'none';
						statusText.textContent = 'Loading...';
					} else {
						iframe.src = 'about:blank';
						emptyState.style.display = 'flex';
						statusText.textContent = 'Ready';
					}

					vscode.postMessage({ type: 'webviewReady' });

					input.addEventListener('keydown', (e) => {
						if (e.key === 'Enter') {
							const url = input.value;
							if (url) { loadVideo(url); }
						}
					});

					loadBtn.addEventListener('click', () => {
						const url = input.value;
						if (url) { loadVideo(url); }
					});

					nextBtn.addEventListener('click', () => {
						requestNext(true);
					});

					openBtn.addEventListener('click', () => {
						const normalized = normalizeInput(input.value);
						if (normalized) {
							vscode.postMessage({ type: 'openExternal', value: normalized });
						}
					});

					historyBtn.addEventListener('click', (e) => {
						e.stopPropagation();
						if (historyDropdown.classList.contains('visible')) {
							historyDropdown.classList.remove('visible');
						} else {
							vscode.postMessage({ type: 'requestHistory' });
						}
					});

					document.addEventListener('click', () => {
						historyDropdown.classList.remove('visible');
					});

					function loadVideo(url) {
						const normalized = normalizeInput(url);
						if (!normalized) {
							statusText.textContent = 'Invalid URL';
							return;
						}

						currentVideoId = extractVideoId(normalized);
						vscode.postMessage({ type: 'requestLoad', value: normalized });
						
						emptyState.style.display = 'none';
						historyDropdown.classList.remove('visible');
						statusText.textContent = 'Loading...';
					}

					function extractVideoId(url) {
						if (!url) return '';
						try {
							const parsed = new URL(url);
							const host = parsed.hostname.replace(/^www[.]/, '');
							if (host === 'youtu.be') return parsed.pathname.split('/')[1];
							if (host.includes('youtube.com')) {
								if (parsed.pathname === '/watch') return parsed.searchParams.get('v');
								if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2];
								if (parsed.pathname.startsWith('/embed/')) return parsed.pathname.split('/')[2];
							}
							if (host.includes('127.0.0.1')) {
								return parsed.searchParams.get('v') || '';
							}
						} catch(e) {}
						
						// Try to match a raw 11-char ID
						const match = url.match(/[a-zA-Z0-9_-]{11}/);
						return match ? match[0] : '';
					}

					window.addEventListener('message', event => {
						const message = event.data;
						
						// Handle YouTube IFrame API messages
						let data = message;
						if (typeof data === 'string') {
							try { data = JSON.parse(data); } catch(e) { return; }
						}

						if (data && data.event === 'infoDelivery' && data.info) {
							if (data.info.playerState === 0) {
								requestNext();
							} else if (data.info.playerState === 1) {
								isPaused = false;
								statusText.textContent = 'Playing';
							} else if (data.info.playerState === 2) {
								isPaused = true;
								statusText.textContent = 'Paused';
							}
						}

						switch (message.type) {
							case 'loadUrl':
								const nextId = extractVideoId(message.value);
								const proxyUrlPrefix = message.value.split('/embed')[0] + '/embed';
								
								if (iframe.src.startsWith(proxyUrlPrefix)) {
									iframe.contentWindow.postMessage({ type: 'load', id: nextId }, '*');
								} else {
									iframe.src = message.value;
								}
								
								input.value = message.originalUrl || message.value;
								currentVideoId = nextId;
								lastLoadedUrl = message.value;
								saveState();
								
								emptyState.style.display = 'none';
								isPaused = false;
								statusText.textContent = 'Playing';
								break;
							case 'history':
								showHistory(message.value);
								break;
							case 'togglePlay':
								togglePlay();
								break;
							case 'nextVideo':
								requestNext(true);
								break;
						}
						saveState();
					});

					function requestNext(force = false) {
						if ((autoplayCheck.checked || force) && currentVideoId) {
							statusText.textContent = 'Finding next...';
							vscode.postMessage({ 
								type: 'requestNextVideo', 
								videoId: currentVideoId
							});
						} else {
							statusText.textContent = 'Ended';
						}
					}

					function normalizeInput(url) {
						const trimmed = url.trim();
						if (!trimmed) return '';
						if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
						return 'https://' + trimmed;
					}

					function showHistory(urls) {
						historyDropdown.innerHTML = '';
						if (urls.length === 0) {
							const item = document.createElement('div');
							item.className = 'history-item';
							item.textContent = 'No history yet';
							historyDropdown.appendChild(item);
						} else {
							urls.forEach(entry => {
								const item = document.createElement('div');
								item.className = 'history-item';
								item.textContent = entry.title || entry.url;
								item.title = entry.url;
								item.addEventListener('click', () => {
									loadVideo(entry.url);
								});
								historyDropdown.appendChild(item);
							});
						}
						historyDropdown.classList.add('visible');
					}

					function togglePlay() {
						const command = isPaused ? 'playVideo' : 'pauseVideo';
						if (iframe && iframe.contentWindow) {
							iframe.contentWindow.postMessage({
								event: 'command',
								func: command
							}, '*');
						// isPaused will be updated by the state change message
						}
					}
				</script>
			</body>
			</html>`;
	}
}
