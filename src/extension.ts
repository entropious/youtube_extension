import * as vscode from 'vscode';
import * as http from 'http';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';

let proxyServer: http.Server | null = null;
let proxyPort = 0;

type HistoryEntry = {
	url: string;
	title?: string;
};
 
let provider: YouTubeViewProvider | null = null;

function getProxyEmbedHtml(videoId: string, startTime: number = 0, autoplay: boolean = true): string {
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
        let s = ${startTime};
        let a = ${autoplay ? 1 : 0};
        
        window.onYouTubeIframeAPIReady = function() {
            try {
                p = new YT.Player('p', {
                    height: '100%', width: '100%', videoId: v,
                    playerVars: { autoplay: a, rel: 0, modestbranding: 1, playsinline: 1, enablejsapi: 1, start: s },
                    events: {
                        onReady: e => { 
                            if(v && a) e.target.playVideo(); 
                            // Report time every second
                            setInterval(() => {
                                if (p && p.getCurrentTime) {
                                    const time = p.getCurrentTime();
                                    window.parent.postMessage({event:'timeUpdate', time: Math.floor(time)}, '*');
                                }
                            }, 1000);
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
                const startTime = data.startTime || 0;
                const startAutoplay = data.autoplay !== false;
                if (p && p.loadVideoById) {
                    if (startAutoplay) {
                        p.loadVideoById({ videoId: v, startSeconds: startTime });
                    } else {
                        p.cueVideoById({ videoId: v, startSeconds: startTime });
                    }
                }
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
		const startTime = parseInt(url.searchParams.get('start') ?? '0', 10);
		const autoplay = url.searchParams.get('autoplay') !== '0';

		if (videoId && !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
			res.writeHead(400); res.end('Invalid video id'); return;
		}

		res.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
			'Cache-Control': 'no-cache'
		});
		res.end(getProxyEmbedHtml(videoId, startTime, autoplay));
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

export async function deactivate() {
	if (provider) {
		await provider.saveCurrentState();
	}

	if (proxyServer) {
		proxyServer.close();
		proxyServer = null;
		proxyPort = 0;
	}
}

export async function activate(context: vscode.ExtensionContext) {
	await startProxyServer();
 
	provider = new YouTubeViewProvider(context.extensionUri, context.globalState);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(YouTubeViewProvider.viewType, provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.loadUrl', async () => {
			const url = await vscode.window.showInputBox({
				prompt: "Enter YouTube Video URL or Search query",
				placeHolder: "https://www.youtube.com/watch?v=... or 'lofi hip hop'"
			});
			if (url && provider) {
				const resolvedUrl = await provider.resolveUrl(url);
				provider.loadUrl(resolvedUrl);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.togglePlay', () => {
			provider?.togglePlay();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.nextVideo', () => {
			provider?.nextVideo();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.openInPanel', (url: string, title?: string, startTime?: number) => {
			provider?.openInPanel(url, title, startTime);
		})
	);
}

class YouTubeViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'youtube-panel.view';
	private static readonly historyKey = 'youtube-history';
	private static readonly favoritesKey = 'youtube-favorites';
	private static readonly timestampsKey = 'youtube-timestamps';

	private _view?: vscode.WebviewView;
	public activePanel?: vscode.WebviewPanel;
	private _lastPanelUrl?: string;
	private _lastPanelTime: number = 0;
	private _lastViewUrl?: string;
	private _lastViewTime: number = 0;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _state: vscode.Memento
	) { }

	public togglePlay() {
		const target = this.activePanel?.webview || this._view?.webview;
		target?.postMessage({ type: 'togglePlay' });
	}

	public pause() {
		const target = this.activePanel?.webview || this._view?.webview;
		target?.postMessage({ type: 'pause' });
	}

	public nextVideo() {
		const target = this.activePanel?.webview || this._view?.webview;
		target?.postMessage({ type: 'nextVideo' });
	}

	public async saveCurrentState(): Promise<void> {
		if (this._lastViewUrl) {
			await this._saveTimestamp(this._lastViewUrl, this._lastViewTime);
		}
		if (this.activePanel && this._lastPanelUrl) {
			await this._saveTimestamp(this._lastPanelUrl, this._lastPanelTime);
		}
	}
 
	public loadUrl(url: string, startTime?: number, autoplay: boolean = true) {
		const target = this.activePanel?.webview || this._view?.webview;
		if (target) {
			void this._handleLoadRequest(url);
			
			if (this.activePanel?.webview === target) {
				this._lastPanelUrl = url;
				this._lastPanelTime = startTime || 0;
			} else {
				this._lastViewUrl = url;
				this._lastViewTime = startTime || 0;
			}
			
			// If startTime is not provided, try to load it from state
			if (startTime === undefined) {
				startTime = this._getTimestamp(url);
			}

			target.postMessage({
				type: 'loadUrl',
				value: this._formatYoutubeUrl(url, startTime, autoplay),
				originalUrl: url,
				startTime: startTime,
				autoplay: autoplay
			});
		}
	}

	public _formatYoutubeUrl(url: string, startTime: number = 0, autoplay: boolean = true): string {
		const toEmbed = (id: string): string => {
			const startParam = startTime > 0 ? `&start=${startTime}` : '';
			const autoplayParam = autoplay ? '&autoplay=1' : '&autoplay=0';
			if (proxyPort) {
				return `http://127.0.0.1:${proxyPort}/embed?v=${id}${startParam}${autoplayParam}`;
			}

			return `https://www.youtube.com/embed/${id}?rel=0&modestbranding=1&playsinline=1&enablejsapi=1${autoplayParam}${startParam}`;
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

	public async _handleLoadRequest(url: string): Promise<void> {
		// Save immediately to avoid race conditions
		await this._saveUrl(url);
		
		const title = await this._resolveTitle(url);
		
		if (title) {
			await this._saveUrl(url, title);
			
			// Update favorites if it exists there too
			const favorites = this._getFavorites();
			const index = favorites.findIndex(f => f.url === url);
			if (index !== -1 && !favorites[index].title) {
				favorites[index].title = title;
				await this._state.update(YouTubeViewProvider.favoritesKey, favorites);
			}
		}
	}

	public _getFavorites(): HistoryEntry[] {
		const raw = this._state.get<unknown[]>(YouTubeViewProvider.favoritesKey, []);
		return this._parseEntries(raw);
	}

	private async _saveFavorite(url: string, title?: string): Promise<void> {
		const normalized = url.trim();
		if (!normalized) return;

		const favorites = this._getFavorites();
		if (favorites.some(f => f.url === normalized)) return;

		const finalTitle = title || await this._resolveTitle(normalized);
		favorites.unshift({ url: normalized, title: finalTitle });
		await this._state.update(YouTubeViewProvider.favoritesKey, favorites);
	}

	private async _removeFavorite(url: string): Promise<void> {
		const favorites = this._getFavorites();
		const filtered = favorites.filter(f => f.url !== url);
		await this._state.update(YouTubeViewProvider.favoritesKey, filtered);
	}

	private _parseEntries(raw: unknown[]): HistoryEntry[] {
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

	public _getHistory(): HistoryEntry[] {
		const raw = this._state.get<unknown[]>(YouTubeViewProvider.historyKey, []);
		return this._parseEntries(raw);
	}

	private _getTimestamp(url: string): number {
		const timestamps = this._state.get<Record<string, number>>(YouTubeViewProvider.timestampsKey, {});
		const videoId = this._extractVideoId(url);
		return videoId ? (timestamps[videoId] || 0) : 0;
	}

	private async _saveTimestamp(url: string, time: number): Promise<void> {
		const videoId = this._extractVideoId(url);
		if (!videoId) return;

		const timestamps = this._state.get<Record<string, number>>(YouTubeViewProvider.timestampsKey, {});
		
		// If time is close to end (e.g. within 5 sec of end), we might want to reset? 
		// For now simple save.
		if (Math.abs((timestamps[videoId] || 0) - time) < 1) return; // Don't save if it's the same second

		timestamps[videoId] = time;
		
		// Keep storage lean - maybe limit to 100 recent videos
		const keys = Object.keys(timestamps);
		if (keys.length > 100) {
			delete timestamps[keys[0]];
		}

		await this._state.update(YouTubeViewProvider.timestampsKey, timestamps);
	}

	private _extractVideoId(urlStr: string): string | undefined {
		try {
			const parsed = new URL(urlStr);
			const host = parsed.hostname.replace(/^www\./, '');
			if (host === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0];
			if (host === 'youtube.com' || host === 'm.youtube.com') {
				if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || undefined;
				if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/').filter(Boolean)[1];
				if (parsed.pathname.startsWith('/embed/')) return parsed.pathname.split('/').filter(Boolean)[1];
			}
		} catch {
			// Fallback for non-url strings that might be IDs
			if (/^[a-zA-Z0-9_-]{11}$/.test(urlStr)) return urlStr;
		}
		return undefined;
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

	private async _searchVideos(query: string): Promise<{id: string, title: string, thumbnail: string}[]> {
		try {
			const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
			const text = await res.text();
			
			const results: {id: string, title: string, thumbnail: string}[] = [];
			
			// Try to parse ytInitialData
			const match = text.match(/var ytInitialData = (.*?);<\/script>/);
			if (match) {
				try {
					const data = JSON.parse(match[1]);
					const contents = data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
					for (const content of contents) {
						if (content.itemSectionRenderer) {
							for (const item of content.itemSectionRenderer.contents) {
								if (item.videoRenderer) {
									const v = item.videoRenderer;
									results.push({
										id: v.videoId,
										title: v.title.runs[0].text,
										thumbnail: v.thumbnail.thumbnails[0].url
									});
								}
							}
						}
					}
				} catch (e) {
					// Fallback
				}
			}
			
			if (results.length === 0) {
				// Fallback to simple regex if JSON parsing fails
				const matches = text.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"(.*?)"\}\]/g);
				for (const m of matches) {
					results.push({
						id: m[1],
						title: m[2].replace(/\\u0026/g, '&'),
						thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`
					});
					if (results.length >= 20) break;
				}
			}
			
			return results;
		} catch {
			return [];
		}
	}

	public async resolveUrl(input: string): Promise<string> {
		const trimmed = input.trim();
		if (!trimmed) {
			return '';
		}

		// Already a full URL
		if (/^https?:\/\//i.test(trimmed)) {
			return trimmed;
		}

		// YouTube ID
		if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
			return `https://www.youtube.com/watch?v=${trimmed}`;
		}

		// Likely a domain name without protocol
		if (trimmed.includes('.') && !trimmed.includes(' ') && trimmed.length > 3) {
			return 'https://' + trimmed;
		}

		// Treat as search query
		const results = await this._searchVideos(trimmed);
		if (results.length > 0) {
			return `https://www.youtube.com/watch?v=${results[0]}`;
		}

		return trimmed;
	}

	public async _findNextVideo(currentId: string): Promise<string | undefined> {
		const ids = await this._fetchRelated(currentId);
		const filtered = ids.filter(id => id !== currentId);
		return filtered[Math.floor(Math.random() * Math.min(filtered.length, 5))];
	}

	public openInPanel(url: string, title?: string, startTime?: number) {
		if (this.activePanel) {
			this.activePanel.reveal(vscode.ViewColumn.One);
			this.activePanel.title = title || 'YouTube Player';
			this.loadUrl(url, startTime);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'youtube-player',
			title || 'YouTube Player',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		this.activePanel = panel;
		this._lastPanelUrl = url;
		this._lastPanelTime = startTime || 0;

		panel.webview.html = this._getHtmlForWebview(this._formatYoutubeUrl(url, startTime), url);

		this._setupWebviewHandlers(panel.webview, true);

		panel.onDidDispose(() => {
			if (this.activePanel === panel) {
				this.activePanel = undefined;
			}
			void this._saveTimestamp(this._lastPanelUrl || url, this._lastPanelTime);
			this.loadUrl(this._lastPanelUrl || url, this._lastPanelTime, false);
		});

		panel.onDidChangeViewState(() => {
			if (!panel.visible && this._lastPanelUrl) {
				void this._saveTimestamp(this._lastPanelUrl, this._lastPanelTime);
			}
		});
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

		this._setupWebviewHandlers(webviewView.webview, false);

		webviewView.onDidChangeVisibility(() => {
			if (!webviewView.visible && this._lastViewUrl) {
				void this._saveTimestamp(this._lastViewUrl, this._lastViewTime);
			}
		});

		const last = this._getHistory()[0];
		let initialUrl = 'about:blank';
		let initialOriginalUrl = '';
		if (last) {
			const startTime = this._getTimestamp(last.url);
			initialUrl = this._formatYoutubeUrl(last.url, startTime);
			initialOriginalUrl = last.url;
			this._lastViewUrl = last.url;
			this._lastViewTime = startTime;
		}

		webviewView.webview.html = this._getHtmlForWebview(initialUrl, initialOriginalUrl);
		
		// Load the last timestamp if we have a last video
		if (last) {
			const timestamp = this._getTimestamp(last.url);
			if (timestamp > 0) {
				// We don't want to auto-load/seek here immediately because the webview might not be ready
				// but script.js handles it via its own state or by asking for it.
				// Actually, script.js uses INITIAL_URL_JSON which we should update to include the timestamp if possible.
			}
		}
	}

	private _getHtmlForWebview(initialUrl: string = 'about:blank', initialOriginalUrl: string = '') {
		try {
			const webviewPath = path.join(this._extensionUri.fsPath, 'src', 'webview');
			let html = fs.readFileSync(path.join(webviewPath, 'index.html'), 'utf8');
			const style = fs.readFileSync(path.join(webviewPath, 'style.css'), 'utf8');
			let script = fs.readFileSync(path.join(webviewPath, 'script.js'), 'utf8');

			const csp = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-src http://127.0.0.1:* https://www.youtube.com https://youtube.com;";

			script = script
				.replace('%%INITIAL_URL_JSON%%', JSON.stringify(initialUrl))
				.replace('%%INITIAL_ORIGINAL_URL_JSON%%', JSON.stringify(initialOriginalUrl));

			html = html
				.replace('%%CSP%%', csp)
				.replace('%%STYLE%%', style)
				.replace('%%SCRIPT%%', script)
				.replace('%%INITIAL_URL%%', initialUrl)
				.replace('%%EMPTY_STATE_STYLE%%', initialUrl !== 'about:blank' ? 'display:none' : '');

			return html;
		} catch (err) {
			return `<!DOCTYPE html><html><body>Error loading webview assets: ${err}</body></html>`;
		}
	}

	private _setupWebviewHandlers(webview: vscode.Webview, isPanel: boolean) {
		webview.onDidReceiveMessage(async data => {
			switch (data.type) {
				case 'timeUpdate':
					if (isPanel) {
						this._lastPanelTime = data.time;
					} else {
						this._lastViewTime = data.time;
					}
					break;
				case 'saveTimestamp':
					if (data.url && typeof data.time === 'number') {
						void this._saveTimestamp(data.url, data.time);
					}
					break;
				case 'requestLoad':
					if (isPanel) {
						this._lastPanelUrl = data.value;
						this._lastPanelTime = 0;
					}
					const trimmedInput = data.value.trim();
					const isSearch = trimmedInput.includes(' ') || (!trimmedInput.includes('.') && !trimmedInput.startsWith('http') && !/^[a-zA-Z0-9_-]{11}$/.test(trimmedInput));
					
					if (isSearch) {
						const results = await this._searchVideos(trimmedInput);
						webview.postMessage({ type: 'searchResults', results });
					} else {
						const resolvedUrl = await this.resolveUrl(data.value);
						if (isPanel) {
							this._lastPanelUrl = resolvedUrl;
							this._lastPanelTime = 0;
						} else {
							this._lastViewUrl = resolvedUrl;
							this._lastViewTime = 0;
						}
						void this._handleLoadRequest(resolvedUrl);
						const startTime = this._getTimestamp(resolvedUrl);
						webview.postMessage({
							type: 'loadUrl',
							value: this._formatYoutubeUrl(resolvedUrl, startTime),
							originalUrl: data.value,
							startTime: startTime
						});
					}
					break;
				case 'requestHistory':
					webview.postMessage({ type: 'history', value: this._getHistory() });
					break;
				case 'requestFavorites':
					webview.postMessage({ type: 'favorites', value: this._getFavorites() });
					break;
				case 'addFavorite':
					await this._saveFavorite(data.url, data.title);
					webview.postMessage({ type: 'favorites', value: this._getFavorites() });
					break;
				case 'removeFavorite':
					await this._removeFavorite(data.url);
					webview.postMessage({ type: 'favorites', value: this._getFavorites() });
					break;
				case 'requestNextVideo':
					const nextId = await this._findNextVideo(data.videoId);
					if (nextId) {
						const nextUrl = `https://www.youtube.com/watch?v=${nextId}`;
						if (isPanel) {
							this._lastPanelUrl = nextUrl;
							this._lastPanelTime = 0;
						} else {
							this._lastViewUrl = nextUrl;
							this._lastViewTime = 0;
						}
						void this._handleLoadRequest(nextUrl);
						webview.postMessage({
							type: 'loadUrl',
							value: this._formatYoutubeUrl(nextUrl),
							originalUrl: nextUrl,
							startTime: 0
						});
					}
					break;
				case 'openExternal':
					if (isPanel) {
						this.loadUrl(data.url, data.time);
					} else {
						this.pause();
						this.openInPanel(data.url, data.title, data.time);
					}
					break;
				case 'urlSelected':
					void this._saveUrl(data.value);
					break;
			}
		});
	}
}
