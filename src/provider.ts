import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { HistoryEntry, extractVideoId, formatYoutubeUrl, parseEntries } from './utils';

export class YouTubeViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'youtube-panel.view';
	public static readonly historyKey = 'youtube-history';
	public static readonly favoritesKey = 'youtube-favorites';
	public static readonly timestampsKey = 'youtube-timestamps';
	public static readonly autoplayKey = 'youtube-autoplay';

	private _view?: vscode.WebviewView;
	public activePanel?: vscode.WebviewPanel;
	public _lastPanelUrl?: string;
	public _lastPanelTime = 0;
	public _lastViewUrl?: string;
	public _lastViewTime = 0;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _state: vscode.Memento,
		private readonly _getProxyPort: () => number
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
 
	public loadUrl(url: string, startTime?: number, autoplay = true) {
		void this._handleLoadRequest(url);

		if (startTime === undefined) {
			startTime = this._getTimestamp(url);
		}

		if (this.activePanel) {
			this._lastPanelUrl = url;
			this._lastPanelTime = startTime;
		}

		if (!this.activePanel || !autoplay) {
			this._lastViewUrl = url;
			this._lastViewTime = startTime;
		}

		const formattedUrl = this._formatYoutubeUrl(url, startTime, autoplay);
		const message = {
			type: 'loadUrl',
			value: formattedUrl,
			originalUrl: url,
			startTime: startTime,
			autoplay: autoplay
		};

		if (this.activePanel) {
			this.activePanel.webview.postMessage(message);
		}
		if (this._view) {
			this._view.webview.postMessage(message);
		}
	}

	public _formatYoutubeUrl(url: string, startTime = 0, autoplay = true): string {
		return formatYoutubeUrl(url, startTime, autoplay, this._getProxyPort());
	}

	private async _saveUrl(url: string, title?: string): Promise<void> {
		const normalized = url.trim();
		if (!normalized) return;

		const history = this._getHistory();
		const deduped = history.filter(item => item.url !== normalized);
		deduped.unshift({ url: normalized, title: title });

		await this._state.update(YouTubeViewProvider.historyKey, deduped.slice(0, 50));
	}

	public async _handleLoadRequest(url: string): Promise<void> {
		await this._saveUrl(url);
		const title = await this._resolveTitle(url);
		if (title) {
			await this._saveUrl(url, title);
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
		return parseEntries(raw);
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

	public _getHistory(): HistoryEntry[] {
		const raw = this._state.get<unknown[]>(YouTubeViewProvider.historyKey, []);
		return parseEntries(raw);
	}

	private _getTimestamp(url: string): number {
		const timestamps = this._state.get<Record<string, number>>(YouTubeViewProvider.timestampsKey, {});
		const videoId = this._extractVideoId(url);
		return videoId ? (timestamps[videoId] || 0) : 0;
	}

	public async _saveTimestamp(url: string, time: number): Promise<void> {
		const videoId = this._extractVideoId(url);
		if (!videoId) return;
		const timestamps = this._state.get<Record<string, number>>(YouTubeViewProvider.timestampsKey, {});
		if (Math.abs((timestamps[videoId] || 0) - time) < 1) return;
		timestamps[videoId] = time;
		const keys = Object.keys(timestamps);
		if (keys.length > 100) delete timestamps[keys[0]];
		await this._state.update(YouTubeViewProvider.timestampsKey, timestamps);
	}

	private _extractVideoId(urlStr: string): string | undefined {
		return extractVideoId(urlStr);
	}

	private async _resolveTitle(url: string): Promise<string | undefined> {
		try {
			const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
			if (!response.ok) return undefined;
			const data = (await response.json()) as { title?: unknown };
			return typeof data.title === 'string' ? data.title : undefined;
		} catch { return undefined; }
	}

	private async _fetchRelated(videoId: string): Promise<string[]> {
		try {
			const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
				headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
			});
			const text = await res.text();
			const matches = text.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
			return [...new Set(Array.from(matches).map(m => m[1]))].filter(id => id !== videoId);
		} catch { return []; }
	}

	private async _searchVideos(query: string): Promise<{id: string, title: string, thumbnail: string}[]> {
		try {
			const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
			const text = await res.text();
			const results: {id: string, title: string, thumbnail: string}[] = [];
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
									results.push({ id: v.videoId, title: v.title.runs[0].text, thumbnail: v.thumbnail.thumbnails[0].url });
								}
							}
						}
					}
				} catch { /* ignore */ }
			}
			if (results.length === 0) {
				const matches = text.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"(.*?)"\}\]/g);
				for (const m of matches) {
					results.push({ id: m[1], title: m[2].replace(/\\u0026/g, '&'), thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` });
					if (results.length >= 20) break;
				}
			}
			return results;
		} catch { return []; }
	}

	public async resolveUrl(input: string): Promise<string> {
		const trimmed = input.trim();
		if (!trimmed) return '';
		if (/^https?:\/\//i.test(trimmed)) return trimmed;
		if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return `https://www.youtube.com/watch?v=${trimmed}`;
		if (trimmed.includes('.') && !trimmed.includes(' ') && trimmed.length > 3) return 'https://' + trimmed;
		const results = await this._searchVideos(trimmed);
		if (results.length > 0) return `https://www.youtube.com/watch?v=${results[0].id}`;
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

		const panel = vscode.window.createWebviewPanel('youtube-player', title || 'YouTube Player', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
		this.activePanel = panel;
		this._lastPanelUrl = url;
		this._lastPanelTime = startTime || 0;
		panel.webview.html = this._getHtmlForWebview(this._formatYoutubeUrl(url, startTime), url);
		this._setupWebviewHandlers(panel.webview, true);

		panel.onDidDispose(() => {
			const finalUrl = this._lastPanelUrl || url;
			const finalTime = this._lastPanelTime || startTime || 0;
			if (this.activePanel === panel) this.activePanel = undefined;
			void this._saveTimestamp(finalUrl, finalTime);
			this.loadUrl(finalUrl, finalTime, false);
		});

		panel.onDidChangeViewState(() => {
			if (!panel.visible && this._lastPanelUrl) {
				const url = this._lastPanelUrl;
				const time = this._lastPanelTime;
				void this._saveTimestamp(url, time);
				this._lastViewUrl = url;
				this._lastViewTime = time;
				if (this._view) this.loadUrl(url, time, false);
			}
		});
	}

	public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
		this._setupWebviewHandlers(webviewView.webview, false);

		webviewView.onDidChangeVisibility(() => {
			const url = this._lastViewUrl;
			const time = this._lastViewTime;
			if (webviewView.visible && url) {
				this.loadUrl(url, time, false);
			} else if (!webviewView.visible && url) {
				void this._saveTimestamp(url, time);
				this._lastPanelUrl = url;
				this._lastPanelTime = time;
				if (this.activePanel) this.loadUrl(url, time, false);
			}
		});

		let initialUrl = 'about:blank';
		let initialOriginalUrl = '';
		const lastUrl = this._lastViewUrl || this._getHistory()[0]?.url;
		if (lastUrl) {
			const startTime = this._lastViewTime || this._getTimestamp(lastUrl);
			initialUrl = this._formatYoutubeUrl(lastUrl, startTime);
			initialOriginalUrl = lastUrl;
			this._lastViewUrl = lastUrl;
			this._lastViewTime = startTime;
		}
		webviewView.webview.html = this._getHtmlForWebview(initialUrl, initialOriginalUrl);
	}

	private _getHtmlForWebview(initialUrl = 'about:blank', initialOriginalUrl = '') {
		try {
			const webviewPath = path.join(this._extensionUri.fsPath, 'src', 'webview');
			const html = fs.readFileSync(path.join(webviewPath, 'index.html'), 'utf8');
			const style = fs.readFileSync(path.join(webviewPath, 'style.css'), 'utf8');
			let script = fs.readFileSync(path.join(webviewPath, 'script.js'), 'utf8');

			script = script
				.replace('%%INITIAL_URL_JSON%%', JSON.stringify(initialUrl))
				.replace('%%INITIAL_ORIGINAL_URL_JSON%%', JSON.stringify(initialOriginalUrl))
				.replace('%%PROXY_PORT_JSON%%', JSON.stringify(this._getProxyPort()))
				.replace('%%AUTOPLAY_JSON%%', JSON.stringify(this._getAutoplay()));

			return html
				.replace('%%CSP%%', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-src http://127.0.0.1:* https://www.youtube.com https://youtube.com;")
				.replace('%%STYLE%%', style)
				.replace('%%SCRIPT%%', script)
				.replace('%%INITIAL_URL%%', initialUrl)
				.replace('%%EMPTY_STATE_STYLE%%', initialUrl !== 'about:blank' ? 'display:none' : '');
		} catch (err) {
			return `<!DOCTYPE html><html><body>Error loading webview assets: ${err}</body></html>`;
		}
	}

	private _setupWebviewHandlers(webview: vscode.Webview, isPanel: boolean) {
		webview.onDidReceiveMessage(async data => {
			switch (data.type) {
				case 'log': console.log(`[YOUTUBE_EXT][WEBVIEW] ${data.message}`, ...(data.args || [])); break;
				case 'timeUpdate':
					if (isPanel) this._lastPanelTime = data.time; else this._lastViewTime = data.time;
					break;
				case 'saveTimestamp':
					if (data.url && typeof data.time === 'number') void this._saveTimestamp(data.url, data.time);
					break;
				case 'proxyLog': console.log(`[YOUTUBE_EXT][PROXY][${data.level}] ${data.message}`, ...(data.args || [])); break;
				case 'requestLoad': {
					if (isPanel) { this._lastPanelUrl = data.value; this._lastPanelTime = 0; }
					const trimmedInput = data.value.trim();
					const isSearch = trimmedInput.includes(' ') || (!trimmedInput.includes('.') && !trimmedInput.startsWith('http') && !/^[a-zA-Z0-9_-]{11}$/.test(trimmedInput));
					if (isSearch) {
						const results = await this._searchVideos(trimmedInput);
						webview.postMessage({ type: 'searchResults', results });
					} else {
						const resolvedUrl = await this.resolveUrl(data.value);
						if (isPanel) { this._lastPanelUrl = resolvedUrl; this._lastPanelTime = 0; } else { this._lastViewUrl = resolvedUrl; this._lastViewTime = 0; }
						void this._handleLoadRequest(resolvedUrl);
						const startTime = this._getTimestamp(resolvedUrl);
						webview.postMessage({ type: 'loadUrl', value: this._formatYoutubeUrl(resolvedUrl, startTime), originalUrl: data.value, startTime });
					}
					break;
				}
				case 'requestHistory': webview.postMessage({ type: 'history', value: this._getHistory() }); break;
				case 'requestFavorites': webview.postMessage({ type: 'favorites', value: this._getFavorites() }); break;
				case 'addFavorite': await this._saveFavorite(data.url, data.title); webview.postMessage({ type: 'favorites', value: this._getFavorites() }); break;
				case 'removeFavorite': await this._removeFavorite(data.url); webview.postMessage({ type: 'favorites', value: this._getFavorites() }); break;
				case 'requestNextVideo': {
					const nextId = await this._findNextVideo(data.videoId);
					if (nextId) {
						const nextUrl = `https://www.youtube.com/watch?v=${nextId}`;
						if (isPanel) { this._lastPanelUrl = nextUrl; this._lastPanelTime = 0; } else { this._lastViewUrl = nextUrl; this._lastViewTime = 0; }
						void this._handleLoadRequest(nextUrl);
						
						// If manual request, always autoplay. If automatic (from video end), check the flag.
						const shouldAutoplay = data.manual !== false || this._getAutoplay();
						
						const startTime = 0;
						webview.postMessage({ 
							type: 'loadUrl', 
							value: this._formatYoutubeUrl(nextUrl, startTime, shouldAutoplay), 
							originalUrl: nextUrl, 
							startTime,
							autoplay: shouldAutoplay
						});
					}
					break;
				}
				case 'videoEnded': {
					if (this._getAutoplay()) {
						const nextId = await this._findNextVideo(data.videoId);
						if (nextId) {
							const nextUrl = `https://www.youtube.com/watch?v=${nextId}`;
							if (isPanel) { this._lastPanelUrl = nextUrl; this._lastPanelTime = 0; } else { this._lastViewUrl = nextUrl; this._lastViewTime = 0; }
							void this._handleLoadRequest(nextUrl);
							webview.postMessage({ type: 'loadUrl', value: this._formatYoutubeUrl(nextUrl, 0, true), originalUrl: nextUrl, startTime: 0, autoplay: true });
						}
					}
					break;
				}
				case 'setAutoplay': await this._state.update(YouTubeViewProvider.autoplayKey, !!data.value); break;
				case 'openExternal': if (isPanel) this.loadUrl(data.url, data.time); else { this.pause(); this.openInPanel(data.url, data.title, data.time); } break;
				case 'urlSelected': void this._saveUrl(data.value); break;
			}
		});
	}

	private _getAutoplay(): boolean {
		return this._state.get<boolean>(YouTubeViewProvider.autoplayKey, true);
	}
}
