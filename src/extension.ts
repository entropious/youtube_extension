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
<html lang="en" style="height:100%;margin:0;padding:0;background:#000;">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		html, body { height:100%; margin:0; padding:0; background:#000; overflow:hidden; }
		#player { width:100%; height:100%; border:0; }
	</style>
</head>
<body>
	<iframe id="player"
		src="https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&iv_load_policy=3&playsinline=1&enablejsapi=1"
		allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
		allowfullscreen>
	</iframe>
	<script>
		window.addEventListener('message', (event) => {
			const player = document.getElementById('player');
			if (player && player.contentWindow) {
				player.contentWindow.postMessage(event.data, '*');
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
		if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
			res.writeHead(400);
			res.end('Invalid video id');
			return;
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
}

class YouTubeViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'youtube-panel.view';
	private static readonly historyKey = 'youtube-history';

	private _view?: vscode.WebviewView;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _state: vscode.Memento
	) { }

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

		webviewView.webview.html = this._getHtmlForWebview();

		webviewView.webview.onDidReceiveMessage(data => {
			switch (data.type) {
				case 'webviewReady': {
					const last = this._getHistory()[0];
					if (last) {
						this._view?.webview.postMessage({
							type: 'loadUrl',
							value: this._formatYoutubeUrl(last.url),
							originalUrl: last.url
						});
					}
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
			}
		});

	}

	public togglePlay() {
		this._view?.webview.postMessage({ type: 'togglePlay' });
	}

	public loadUrl(url: string) {
		if (this._view) {
			void this._saveUrl(url);
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

	private async _saveUrl(url: string): Promise<void> {
		await this._saveUrlWithTitle(url);
	}

	private async _handleLoadRequest(url: string): Promise<void> {
		const title = await this._resolveTitle(url);
		await this._saveUrlWithTitle(url, title);
	}

	private async _saveUrlWithTitle(url: string, title?: string): Promise<void> {
		const normalized = url.trim();
		if (!normalized) {
			return;
		}

		const history = this._getHistory();
		const deduped = history.filter(item => item.url !== normalized);
		deduped.unshift({ url: normalized, title: title || deduped[0]?.title });

		await this._state.update(YouTubeViewProvider.historyKey, deduped.slice(0, 10));
	}

	private _getHistory(): HistoryEntry[] {
		const raw = this._state.get<unknown[]>(YouTubeViewProvider.historyKey, []);
		return raw
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

	private _getHtmlForWebview() {
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-src http://127.0.0.1:* https://www.youtube.com https://youtube.com;">
				<style>
					body {
						margin: 0;
						padding: 0;
						width: 100%;
						height: 100vh;
						display: flex;
						flex-direction: column;
						background-color: transparent;
						overflow: hidden;
						font-family: var(--vscode-font-family);
					}

					.top-hitbox {
						position: absolute;
						top: 0;
						left: 0;
						right: 0;
						height: 48px;
						z-index: 999;
					}

					.header {
						position: absolute;
						top: 0;
						left: 0;
						right: 0;
						display: flex;
						align-items: center;
						padding: 4px 8px;
						background: rgba(30,30,30,0.95);
						backdrop-filter: blur(8px);
						z-index: 1000;
						transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
						transform: translateY(-100%);
						opacity: 0;
                        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
					}

					.top-hitbox:hover + .header,
					.header:hover {
						transform: translateY(0);
						opacity: 1;
					}

					input {
						flex-grow: 1;
						background: var(--vscode-input-background);
						color: var(--vscode-input-foreground);
						border: 1px solid var(--vscode-input-border);
						padding: 4px 8px;
						margin: 0 4px;
                        outline: none;
					}

					button {
						background: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border: none;
						padding: 4px 12px;
						cursor: pointer;
					}

					button:hover {
						background: var(--vscode-button-hoverBackground);
					}

					#history-btn {
                        background: transparent;
                        color: var(--vscode-foreground);
                        font-size: 16px;
                        padding: 0 8px;
                    }

					.player-container {
						flex-grow: 1;
						position: relative;
						background: black;
					}

					iframe {
						width: 100%;
						height: 100%;
						border: none;
					}

                    .history-dropdown {
                        display: none;
                        position: absolute;
                        top: 100%;
                        left: 8px;
                        right: 8px;
                        background: var(--vscode-dropdown-background);
                        border: 1px solid var(--vscode-dropdown-border);
                        max-height: 200px;
                        overflow-y: auto;
                        z-index: 2000;
                        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
                    }

                    .history-item {
                        padding: 6px 10px;
                        cursor: pointer;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        color: var(--vscode-dropdown-foreground);
                    }

                    .history-item:hover {
                        background: var(--vscode-list-hoverBackground);
                    }

                    .visible {
                        display: block;
                    }
				</style>
			</head>
			<body>
				<div class="top-hitbox"></div>
				<div class="header">
					<input type="text" id="url-input" placeholder="YouTube URL...">
					<button id="load-btn">Go</button>
					<button id="open-btn">Open</button>
                    <button id="history-btn">▼</button>
                    <div id="history-dropdown" class="history-dropdown"></div>
				</div>
				<div class="player-container">
					<div id="empty-state" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);font-size:13px;z-index:1;pointer-events:none; text-align:center; padding:0 16px;">Paste a YouTube URL and press Go.<br/>If YouTube shows error 153, use Open to play in browser.</div>
					<iframe id="video-frame" src="about:blank" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share" allowfullscreen></iframe>
				</div>

				<script>
					const vscode = acquireVsCodeApi();
					const input = document.getElementById('url-input');
					const loadBtn = document.getElementById('load-btn');
					const openBtn = document.getElementById('open-btn');
					const historyBtn = document.getElementById('history-btn');
					const historyDropdown = document.getElementById('history-dropdown');
					const iframe = document.getElementById('video-frame');
					const emptyState = document.getElementById('empty-state');

					vscode.postMessage({ type: 'webviewReady' });

					input.addEventListener('keydown', (e) => {
						if (e.key === 'Enter') {
							const url = input.value;
							if (url) {
								loadVideo(url);
							}
						}
					});

					loadBtn.addEventListener('click', () => {
						const url = input.value;
						if (url) {
							loadVideo(url);
						}
					});

					openBtn.addEventListener('click', () => {
						const normalized = normalizeInput(input.value);
						if (!normalized) {
							return;
						}

						vscode.postMessage({ type: 'openExternal', value: normalized });
					});

                    historyBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'requestHistory' });
                    });

                    document.addEventListener('click', () => {
                        historyDropdown.classList.remove('visible');
                    });

					function loadVideo(url) {
	                        const normalized = normalizeInput(url);
	                        const formatted = toEmbedUrl(normalized);

	                        if (!formatted) {
	                            emptyState.textContent = 'Invalid YouTube URL';
	                            emptyState.style.display = 'flex';
	                            return;
	                        }

	                        vscode.postMessage({ type: 'requestLoad', value: normalized });
	                        emptyState.style.display = 'none';
	                        historyDropdown.classList.remove('visible');
					}

					window.addEventListener('message', event => {
						const message = event.data;
							switch (message.type) {
								case 'loadUrl':
									iframe.src = message.value;
									input.value = message.originalUrl || message.value;
	                                emptyState.style.display = 'none';
                                    isPaused = false;
									break;
                            case 'history':
                                showHistory(message.value);
                                break;
                            case 'togglePlay':
                                togglePlay();
                                break;
						}
					});

	                    function normalizeInput(url) {
	                        const trimmed = url.trim();
	                        if (!trimmed) {
	                            return '';
	                        }

	                        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
	                            return trimmed;
	                        }

	                        return 'https://' + trimmed;
	                    }

	                    function toEmbedUrl(url) {
	                        const toEmbed = (id) => {
	                            const params = new URLSearchParams({
	                                rel: '0',
	                                modestbranding: '1',
	                                playsinline: '1',
                                    enablejsapi: '1',
                                    autoplay: '1'
	                            });

	                            return 'https://www.youtube.com/embed/' + id + '?' + params.toString();
	                        };

	                        if (!url) {
	                            return '';
	                        }

	                        try {
	                            const parsed = new URL(url);
	                            const host = parsed.hostname.replace(/^www[.]/, '');

	                            if (host === 'youtu.be') {
	                                const id = parsed.pathname.split('/').filter(Boolean)[0];
	                                return id ? toEmbed(id) : '';
	                            }

	                            if (host === 'youtube.com' || host === 'm.youtube.com') {
	                                if (parsed.pathname === '/watch') {
	                                    const id = parsed.searchParams.get('v');
	                                    return id ? toEmbed(id) : '';
	                                }

	                                if (parsed.pathname.startsWith('/shorts/')) {
	                                    const id = parsed.pathname.split('/').filter(Boolean)[1];
	                                    return id ? toEmbed(id) : '';
	                                }

	                                if (parsed.pathname.startsWith('/embed/')) {
	                                    const id = parsed.pathname.split('/').filter(Boolean)[1];
	                                    return id ? toEmbed(id) : '';
	                                }
	                            }
	                        } catch {
	                            return '';
	                        }

	                        return '';
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

                    let isPaused = false;
                    function togglePlay() {
                        const command = isPaused ? 'playVideo' : 'pauseVideo';
                        if (iframe && iframe.contentWindow) {
                            iframe.contentWindow.postMessage(JSON.stringify({
                                event: 'command',
                                func: command
                            }), '*');
                            isPaused = !isPaused;
                        }
                    }
				</script>
			</body>
			</html>`;
	}
}
