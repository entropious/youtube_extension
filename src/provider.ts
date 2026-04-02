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

	private _sidebarView?: vscode.WebviewView;
	public _tabPanel?: vscode.WebviewPanel;
	private _isTabActive = false;
	public _lastUrl?: string;
	public _lastTime = 0;
	private _timestampCache: Record<string, number> = {};

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _state: vscode.Memento,
		private readonly _getProxyPort: () => number
	) { }

	private postToAll(message: any) {
		if (this._tabPanel) this._tabPanel.webview.postMessage(message);
		if (this._sidebarView) this._sidebarView.webview.postMessage(message);
	}

	private postToActive(message: any) {
		let target: vscode.WebviewPanel | vscode.WebviewView | undefined;

		if (this._isTabActive && this._tabPanel) {
			target = this._tabPanel;
		} else {
			target = this._sidebarView;
		}
		target?.webview.postMessage(message);
	}

	public togglePlay() {
		this.postToActive({ type: 'togglePlay' });
	}

	public pauseAllExcept(exceptTab: boolean) {
		const message = { type: 'pause' };
		if (exceptTab) {
			if (this._sidebarView) this._sidebarView.webview.postMessage(message);
		} else {
			if (this._tabPanel) this._tabPanel.webview.postMessage(message);
		}
	}

	public pause() {
		this.postToActive({ type: 'pause' });
	}

	public nextVideo() {
		this.postToActive({ type: 'nextVideo' });
	}

	public async saveCurrentState(): Promise<void> {
		if (this._lastUrl) {
			await this._saveTimestamp(this._lastUrl, this._lastTime, true);
		}
	}
 
	public async loadUrl(url: string, startTime?: number, autoplay = true, targetView?: 'tab' | 'sidebar'): Promise<void> {
		const savePromise = this.saveCurrentState();
		void this._handleLoadRequest(url);

		if (startTime === undefined) {
			startTime = this._getTimestamp(url);
		}

		this._lastUrl = url;
		this._lastTime = startTime;

		const formattedUrl = this._formatYoutubeUrl(url, startTime, autoplay);
		const message = {
			type: 'loadUrl',
			value: formattedUrl,
			originalUrl: url,
			startTime: startTime,
			autoplay: autoplay,
			targetView: targetView
		};
		if (targetView === 'tab' && this._tabPanel) {
			this._tabPanel.webview.postMessage(message);
		} else if (targetView === 'sidebar' && this._sidebarView) {
			this._sidebarView.webview.postMessage(message);
		} else {
			this.postToActive(message);
		}
		await savePromise;
	}

	public _formatYoutubeUrl(url: string, startTime = 0, autoplay = true): string {
		return formatYoutubeUrl(url, startTime, autoplay, this._getProxyPort());
	}

	private async _loadUrlTargeted(webview: vscode.Webview, isTab: boolean, url: string, startTime?: number, autoplay = true) {
		this._isTabActive = isTab;
		if (this._lastUrl) await this._saveTimestamp(this._lastUrl, this._lastTime, true);
		
		this._lastUrl = url;
		this._lastTime = startTime ?? this._getTimestamp(url);

		const finalStartTime = this._lastTime || 0;
		void this._handleLoadRequest(url);

		const formattedUrl = this._formatYoutubeUrl(url, finalStartTime, autoplay);
		webview.postMessage({
			type: 'loadUrl',
			value: formattedUrl,
			originalUrl: url,
			startTime: finalStartTime,
			autoplay: autoplay
		});
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

	private async _removeHistory(url: string): Promise<void> {
		const history = this._getHistory();
		const filtered = history.filter(h => h.url !== url);
		await this._state.update(YouTubeViewProvider.historyKey, filtered);
	}

	private async _clearHistory(): Promise<void> {
		await this._state.update(YouTubeViewProvider.historyKey, []);
	}

	private _getTimestamp(url: string): number {
		const videoId = this._extractVideoId(url);
		if (!videoId) return 0;
		if (this._timestampCache[videoId] !== undefined) return this._timestampCache[videoId];
		
		const timestamps = this._state.get<Record<string, any>>(YouTubeViewProvider.timestampsKey, {});
		const entry = timestamps[videoId];
		
		if (typeof entry === 'object' && entry !== null && 'time' in entry) {
			return entry.time || 0;
		}
		return typeof entry === 'number' ? entry : 0;
	}

	public async _saveTimestamp(url: string, time: number, force = false): Promise<void> {
		const videoId = this._extractVideoId(url);
		if (!videoId) return;
		this._timestampCache[videoId] = time;
		
		const raw = this._state.get<Record<string, any>>(YouTubeViewProvider.timestampsKey, {});
		const timestamps = JSON.parse(JSON.stringify(raw));
		
		const currentEntry = timestamps[videoId];
		const currentTime = (typeof currentEntry === 'object' && currentEntry !== null) ? currentEntry.time : currentEntry;
		
		if (!force && Math.abs((currentTime || 0) - time) < 1) return;
		
		timestamps[videoId] = {
			time: time,
			lastUsed: Date.now()
		};

		const entries = Object.entries(timestamps);
		if (entries.length > 500) {
			// Explicit LRU: sort by lastUsed (missing lastUsed go first)
			entries.sort((a: any, b: any) => {
				const timeA = (typeof a[1] === 'object' && a[1]?.lastUsed) || 0;
				const timeB = (typeof b[1] === 'object' && b[1]?.lastUsed) || 0;
				return timeA - timeB;
			});
			
			// Remove the oldest one
			const [oldestKey] = entries[0];
			delete timestamps[oldestKey];
		}
		
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
		this._isTabActive = true;
		if (this._tabPanel) {
			try {
				this._tabPanel.reveal(vscode.ViewColumn.One);
				this._tabPanel.title = title || 'YouTube Player';
				this.loadUrl(url, startTime, true, 'tab');
				return;
			} catch {
				this._tabPanel = undefined;
			}
		}

		const panel = vscode.window.createWebviewPanel('youtube-player', title || 'YouTube Player', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
		this._setupTabPanel(panel, url, title, startTime);
	}

	public _setupTabPanel(panel: vscode.WebviewPanel, url: string, title?: string, startTime?: number) {
		this._tabPanel = panel;
		this._lastUrl = url;
		this._lastTime = startTime || 0;
		panel.webview.html = this._getHtmlForWebview(this._formatYoutubeUrl(url, startTime), url);
		this._setupWebviewHandlers(panel.webview, true);

		panel.onDidDispose(() => {
			if (this._tabPanel === panel) this._tabPanel = undefined;
			if (this._isTabActive) {
				void this._saveTimestamp(this._lastUrl || url, this._lastTime);
				this.loadUrl(this._lastUrl || url, this._lastTime, false, 'sidebar');
			}
		});
	}

	public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
		this._sidebarView = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
		this._setupWebviewHandlers(webviewView.webview, false);

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) this._isTabActive = false;
			const url = this._lastUrl;
			const time = this._lastTime;
			if (webviewView.visible && url) {
				this.loadUrl(url, time, false, 'sidebar');
			} else if (!webviewView.visible && url) {
				void this._saveTimestamp(url, time);
				if (this._tabPanel) this.loadUrl(url, time, false, 'tab');
			}
		});

		let initialUrl = 'about:blank';
		let initialOriginalUrl = '';
		const lastUrl = this._lastUrl || this._getHistory()[0]?.url;
		if (lastUrl) {
			const startTime = this._lastTime || this._getTimestamp(lastUrl);
			// Sidebar (view) should NEVER autoplay on initial restore/load
			initialUrl = this._formatYoutubeUrl(lastUrl, startTime, false);
			initialOriginalUrl = lastUrl;
			this._lastUrl = lastUrl;
			this._lastTime = startTime;
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

	private _setupWebviewHandlers(webview: vscode.Webview, isTab: boolean) {
		webview.onDidReceiveMessage(async data => {
			switch (data.type) {
				case 'log': console.log(`[YOUTUBE_EXT][WEBVIEW] ${data.message}`, ...(data.args || [])); break;

				case 'playbackStatus':
					if (data.status === 'playing') {
						this._isTabActive = isTab;
						this.pauseAllExcept(isTab);
					}
					break;
				case 'timeUpdate': {
					if (data.url && data.url !== this._lastUrl) return; // Drop updates from old videos
					this._lastTime = data.time;
					const vid = this._extractVideoId(this._lastUrl || '');
					if (vid) this._timestampCache[vid] = data.time;
					break;
				}
				case 'saveTimestamp':
					if (data.url && typeof data.time === 'number') await this._saveTimestamp(data.url, data.time);
					break;
				case 'proxyLog': console.log(`[YOUTUBE_EXT][PROXY][${data.level}] ${data.message}`, ...(data.args || [])); break;
				case 'requestLoad': {
					const trimmedInput = data.value.trim();
					const isSearch = trimmedInput.includes(' ') || (!trimmedInput.includes('.') && !trimmedInput.startsWith('http') && !/^[a-zA-Z0-9_-]{11}$/.test(trimmedInput));
					if (isSearch) {
						const results = await this._searchVideos(trimmedInput);
						webview.postMessage({ type: 'searchResults', results });
					} else {
						const resolvedUrl = await this.resolveUrl(data.value);
						await this._loadUrlTargeted(webview, isTab, resolvedUrl);
					}
					break;
				}
				case 'requestHistory': 
					webview.postMessage({ type: 'history', value: this._getHistory() }); 
					break;
				case 'requestFavorites': 
					webview.postMessage({ type: 'favorites', value: this._getFavorites() }); 
					break;
				case 'addFavorite': 
					await this._saveFavorite(data.url, data.title); 
					this.postToAll({ type: 'favorites', value: this._getFavorites() }); 
					break;
				case 'removeFavorite': 
					await this._removeFavorite(data.url); 
					this.postToAll({ type: 'favorites', value: this._getFavorites() }); 
					break;
				case 'removeHistory':
					await this._removeHistory(data.url);
					this.postToAll({ type: 'history', value: this._getHistory() });
					break;
				case 'clearHistory':
					await this._clearHistory();
					this.postToAll({ type: 'history', value: [] });
					break;
				case 'requestNextVideo': {
					const nextId = await this._findNextVideo(data.videoId);
					if (nextId) {
						const nextUrl = `https://www.youtube.com/watch?v=${nextId}`;
						const shouldAutoplay = data.manual !== false || this._getAutoplay();
						await this._loadUrlTargeted(webview, isTab, nextUrl, 0, shouldAutoplay);
					}
					break;
				}
				case 'videoEnded': {
					if (this._getAutoplay()) {
						const nextId = await this._findNextVideo(data.videoId);
						if (nextId) {
							const nextUrl = `https://www.youtube.com/watch?v=${nextId}`;
							await this._loadUrlTargeted(webview, isTab, nextUrl, 0, true);
						}
					}
					break;
				}
				case 'setAutoplay': await this._state.update(YouTubeViewProvider.autoplayKey, !!data.value); this.postToAll({ type: 'autoplayUpdated', value: !!data.value }); break;
				case 'openExternal': if (isTab) this.loadUrl(data.url, data.time, true, 'tab'); else { this.pause(); this.openInPanel(data.url, data.title, data.time); } break;
				case 'urlSelected': void this._saveUrl(data.value); break;
			}
		});
	}

	private _getAutoplay(): boolean {
		return this._state.get<boolean>(YouTubeViewProvider.autoplayKey, true);
	}
}
