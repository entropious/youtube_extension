import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { HistoryEntry, extractVideoId, extractPlaylistId, formatYoutubeUrl, parseEntries } from './utils';

export class YouTubeViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'youtube-panel.view';
	public static readonly historyKey = 'youtube-history';
	public static readonly favoritesKey = 'youtube-favorites';
	public static readonly timestampsKey = 'youtube-timestamps';
	public static readonly autoplayKey = 'youtube-autoplay';
	public static readonly playlistIdKey = 'youtube-playlist-id';
	public static readonly playlistVideosKey = 'youtube-playlist-videos';
	public static readonly playlistTitlesKey = 'youtube-playlist-titles';
	public static readonly playlistTitleKey = 'youtube-playlist-title';

	private _sidebarView?: vscode.WebviewView;
	public _tabPanel?: vscode.WebviewPanel;
	private _isTabActive = false;
	private _sidebarHasInteracted = false;
	private _tabHasInteracted = false;
	public _lastUrl?: string;
	private _lastTime = 0;
	private _timestampCache: Record<string, number> = {};
	private _currentPlaylist: string[] = [];
	private _playlistTitles: Record<string, string> = {};
	private _playlistId?: string;
	private _currentChannelUrl?: string;
	private _currentChannelName?: string;
	private _currentPlaylistTitle?: string;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _state: vscode.Memento,
		private readonly _getProxyPort: () => number
	) { 
		this._playlistId = this._state.get<string>(YouTubeViewProvider.playlistIdKey);
		this._currentPlaylist = this._state.get<string[]>(YouTubeViewProvider.playlistVideosKey, []);
		this._playlistTitles = this._state.get<Record<string, string>>(YouTubeViewProvider.playlistTitlesKey, {});
		this._currentPlaylistTitle = this._state.get<string>(YouTubeViewProvider.playlistTitleKey);
	}

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

	public prevVideo() {
		this.postToActive({ type: 'prevVideo' });
	}

	public async saveCurrentState(): Promise<void> {
		if (this._lastUrl) {
			await this._saveTimestamp(this._lastUrl, this._lastTime, true);
		}
	}
 
	public async loadUrl(url: string, startTime?: number, targetView?: 'tab' | 'sidebar'): Promise<void> {
		const savePromise = this.saveCurrentState();
		void this._handleLoadRequest(url);

		if (startTime === undefined) {
			startTime = this._getTimestamp(url);
		}

		this._lastUrl = url;
		this._lastTime = startTime;

		let hasInteracted = false;
		if (targetView === 'tab') {
			hasInteracted = this._tabHasInteracted;
		} else if (targetView === 'sidebar') {
			hasInteracted = this._sidebarHasInteracted;
		} else {
			hasInteracted = this._isTabActive ? this._tabHasInteracted : this._sidebarHasInteracted;
		}

		const formattedUrl = this._formatYoutubeUrl(url, startTime, hasInteracted);
		const playlistId = extractPlaylistId(url);
		const videoId = extractVideoId(url) || '';
		
		this._syncPlaylistState(playlistId);
		const canPrev = !!(playlistId && this._currentPlaylist.length > 0 && this._currentPlaylist.indexOf(videoId) > 0);
		
		const message = {
			type: 'loadUrl',
			value: formattedUrl,
			originalUrl: url,
			startTime: startTime,
			autoplay: hasInteracted,
			targetView: targetView,
			playlistId: playlistId,
			canPrev: canPrev,
			authorUrl: this._currentChannelUrl,
			authorName: this._currentChannelName
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

	private async _loadUrlTargeted(webview: vscode.Webview, isTab: boolean, url: string, startTime?: number) {
		this._isTabActive = isTab;
		if (this._lastUrl) await this._saveTimestamp(this._lastUrl, this._lastTime, true);
		
		this._lastUrl = url;
		this._lastTime = startTime ?? this._getTimestamp(url);

		const finalStartTime = this._lastTime || 0;
		void this._handleLoadRequest(url);

		const hasInteracted = isTab ? this._tabHasInteracted : this._sidebarHasInteracted;

		const formattedUrl = this._formatYoutubeUrl(url, finalStartTime, hasInteracted);
		const playlistId = extractPlaylistId(url);
		const videoId = extractVideoId(url) || '';
		
		this._syncPlaylistState(playlistId);
		const canPrev = !!(playlistId && this._currentPlaylist.length > 0 && this._currentPlaylist.indexOf(videoId) > 0);

		webview.postMessage({
			type: 'loadUrl',
			value: formattedUrl,
			originalUrl: url,
			startTime: finalStartTime,
			autoplay: hasInteracted,
			playlistId: playlistId,
			playlistTitle: this._currentPlaylistTitle,
			canPrev: canPrev,
			authorUrl: this._currentChannelUrl,
			authorName: this._currentChannelName
		});
	}

	private async _saveUrl(url: string, title?: string): Promise<void> {
		const normalized = url.trim();
		if (!normalized) return;

		const history = this._getHistory();
		const existingIndex = history.findIndex(item => item.url === normalized);
		let finalTitle = title;

		// If no NEW title provided, try to keep the EXISTING one
		if (!finalTitle && existingIndex !== -1) {
			finalTitle = history[existingIndex].title;
		}

		const deduped = history.filter(item => item.url !== normalized);
		deduped.unshift({ url: normalized, title: finalTitle });

		await this._state.update(YouTubeViewProvider.historyKey, deduped.slice(0, 50));
	}

	public async _handleLoadRequest(url: string): Promise<void> {
		// Detect playlist
		const playlistId = extractPlaylistId(url);
		if (playlistId && playlistId !== this._playlistId) {
			this._playlistId = playlistId;
			const playlistData = await this._fetchPlaylist(playlistId);
			this._currentPlaylist = playlistData.ids;
			this._currentPlaylistTitle = playlistData.title;
			await this._state.update(YouTubeViewProvider.playlistIdKey, this._playlistId);
			await this._state.update(YouTubeViewProvider.playlistVideosKey, this._currentPlaylist);
			await this._state.update(YouTubeViewProvider.playlistTitlesKey, this._playlistTitles);
			await this._state.update(YouTubeViewProvider.playlistTitleKey, this._currentPlaylistTitle);
		} else if (!playlistId && this._playlistId) {
			this._playlistId = undefined;
			this._currentPlaylist = [];
			this._playlistTitles = {};
			this._currentPlaylistTitle = undefined;
			await this._state.update(YouTubeViewProvider.playlistIdKey, undefined);
			await this._state.update(YouTubeViewProvider.playlistVideosKey, undefined);
			await this._state.update(YouTubeViewProvider.playlistTitlesKey, undefined);
			await this._state.update(YouTubeViewProvider.playlistTitleKey, undefined);
		}

		// Immediately save/bubble up the URL in history (preserving any existing title)
		await this._saveUrl(url);

		// Resolve the info asynchronously
		const info = await this._resolveVideoInfo(url);
		if (info?.title) {
			const title = info.title;
			// Update history with the resolved title
			await this._saveUrl(url, title);
			
			// Also update any matching favorite that is missing a title
			const favorites = this._getFavorites();
			const index = favorites.findIndex(f => f.url === url);
			if (index !== -1 && !favorites[index].title) {
				favorites[index].title = title;
				await this._state.update(YouTubeViewProvider.favoritesKey, favorites);
			}
			
			// Update the webview title if it's the current video
			if (this._lastUrl === url) {
				if (this._tabPanel) this._tabPanel.title = title;
				this._currentChannelUrl = info.authorUrl;
				this._currentChannelName = info.authorName;
				this.postToAll({ 
					type: 'history', 
					value: this._getHistory() 
				});
				this.postToAll({
					type: 'channelUpdated',
					authorUrl: this._currentChannelUrl,
					authorName: this._currentChannelName,
                    authorThumbnail: info.authorThumbnail
				});
			}
		}
	}

	public _getFavorites(): HistoryEntry[] {
		const raw = this._state.get<unknown[]>(YouTubeViewProvider.favoritesKey, []);
		return parseEntries(raw);
	}

	private async _saveFavorite(url: string, title?: string, type?: 'video' | 'channel' | 'playlist', thumbnail?: string): Promise<void> {
		const normalized = url.trim();
		if (!normalized) return;
		const favorites = this._getFavorites();
		if (favorites.some(f => f.url === normalized)) return;
		const info = (!title && !type) ? await this._resolveVideoInfo(normalized) : null;
		const finalTitle = title || info?.title || normalized;
		favorites.unshift({ url: normalized, title: finalTitle, type, thumbnail });
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

	public async clearAll(): Promise<void> {
		await this._state.update(YouTubeViewProvider.historyKey, []);
		await this._state.update(YouTubeViewProvider.favoritesKey, []);
		await this._state.update(YouTubeViewProvider.timestampsKey, {});
		this._lastUrl = undefined;
		this._lastTime = 0;
		this._timestampCache = {};
		this._playlistId = undefined;
		this._currentPlaylist = [];
		this._currentPlaylistTitle = undefined;
		await this._state.update(YouTubeViewProvider.playlistIdKey, undefined);
		await this._state.update(YouTubeViewProvider.playlistVideosKey, undefined);
		await this._state.update(YouTubeViewProvider.playlistTitleKey, undefined);
		
		const message = { type: 'stateCleared' };
		if (this._sidebarView) {
			this._sidebarView.webview.postMessage(message);
		}
		if (this._tabPanel) {
			this._tabPanel.webview.postMessage(message);
		}
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

	private async _resolveVideoInfo(url: string): Promise<{title?: string, authorUrl?: string, authorName?: string, authorThumbnail?: string} | undefined> {
		try {
			const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
			if (!response.ok) return undefined;
			const data = (await response.json()) as { title?: unknown, author_url?: unknown, author_name?: unknown, thumbnail_url?: unknown };
			return {
				title: typeof data.title === 'string' ? data.title : undefined,
				authorUrl: typeof data.author_url === 'string' ? data.author_url : undefined,
				authorName: typeof data.author_name === 'string' ? data.author_name : undefined
			};
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

	private async _fetchPlaylist(playlistId: string): Promise<{ ids: string[], title?: string }> {
		try {
			const res = await fetch(`https://www.youtube.com/playlist?list=${playlistId}`, {
				headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
			});
			const text = await res.text();
			
			// 1. Extract Initial Data and Config
			const initialDataMatch = text.match(/var ytInitialData = (.*?);<\/script>/);
			const apiKeyMatch = text.match(/"INNERTUBE_API_KEY":"(.*?)"/);
			const clientVersionMatch = text.match(/"clientVersion":"(.*?)"/);
			
			if (!initialDataMatch) {
				// Fallback to simple regex if JSON not found
				const matches = text.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
				return { ids: [...new Set(Array.from(matches).map(m => m[1]))] };
			}

			let allIds: string[] = [];
			let continuationToken: string | undefined;
			const apiKey = apiKeyMatch ? apiKeyMatch[1] : '';
			const clientVersion = clientVersionMatch ? clientVersionMatch[1] : '2.20240320.01.00';

			const processData = (data: any) => {
				const jsonStr = JSON.stringify(data);
				// One simple pass to get both ID and Title from playlist items
				const matches = jsonStr.matchAll(/"playlistVideoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"(.*?)"\}\]/g);
				
				for (const m of matches) {
					const id = m[1];
					const title = m[2].replace(/\\u0026/g, '&');
					allIds.push(id);
					this._playlistTitles[id] = title;
				}

				const tokenMatch = jsonStr.match(/"continuationCommand":\{"token":"(.*?)"/);
				return tokenMatch ? tokenMatch[1] : undefined;
			};

			try {
				const data = JSON.parse(initialDataMatch[1]);
				continuationToken = processData(data);
				allIds = [...new Set(allIds)]; // Initial dedup
				
				// Extract playlist title
				const metadata = data.metadata?.playlistMetadataRenderer;
				if (metadata && metadata.title) {
					this._currentPlaylistTitle = metadata.title;
				} else {
					// Fallback to other locations
					this._currentPlaylistTitle = data.header?.playlistHeaderRenderer?.title?.simpleText || 
						data.header?.playlistHeaderRenderer?.title?.runs?.[0]?.text;
				}
			} catch (e) {
				console.error('Error parsing ytInitialData:', e);
			}

			// 2. Fetch continuations if they exist and we have the API key
			let safetyCounter = 0;
			while (continuationToken && apiKey && safetyCounter < 10) {
				safetyCounter++;
				try {
					const response = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
						method: 'POST',
						body: JSON.stringify({
							context: { client: { clientName: 'WEB', clientVersion: clientVersion } },
							continuation: continuationToken
						}),
						headers: { 'Content-Type': 'application/json' }
					});

					if (!response.ok) break;
					const data = await response.json();
					continuationToken = processData(data);
					allIds = [...new Set(allIds)]; // Keep it unique
				} catch (err) {
					console.error('Error fetching continuation:', err);
					break;
				}
			}

			return { ids: allIds, title: this._currentPlaylistTitle };
		} catch (e) { 
			console.error('Playlist fetch failed:', e);
			return { ids: [] }; 
		}
	}

	private async _fetchChannelVideos(channelUrl: string): Promise<{results: {id: string, title: string, thumbnail: string}[], thumbnail?: string}> {
		try {
			const videosUrl = channelUrl.endsWith('/videos') ? channelUrl : `${channelUrl}/videos`;
			const res = await fetch(videosUrl, {
				headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
			});
			const text = await res.text();
			const results: {id: string, title: string, thumbnail: string}[] = [];
            let channelThumbnail: string | undefined;
			
			const match = text.match(/var ytInitialData = (.*?);<\/script>/);
			if (match) {
				try {
					const data = JSON.parse(match[1]);

                    // Try to get channel thumbnail from Various potential locations
                    channelThumbnail = 
                        data.header?.c4TabbedHeaderRenderer?.avatar?.thumbnails?.[0]?.url ||
                        data.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.metadata?.metadataViewModel?.title?.avatarViewModel?.content?.image?.renderInfo?.layoutOptimizedImage?.source?.url ||
                        data.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.metadata?.metadataViewModel?.title?.avatarViewModel?.content?.image?.sources?.[0]?.url ||
                        data.metadata?.channelMetadataRenderer?.avatar?.thumbnails?.[0]?.url;

					// YouTube channel videos are usually in tabs[1] (Videos)
					const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs;
					if (tabs) {
						let videosTab = tabs.find((t: any) => t.tabRenderer?.title === 'Videos' || t.tabRenderer?.endpoint?.browseEndpoint?.params?.includes('videos'));
						if (!videosTab) videosTab = tabs[1]; // Fallback to second tab
						
						const contents = videosTab?.tabRenderer?.content?.richGridRenderer?.contents || 
							videosTab?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.gridRenderer?.items;
						
						if (contents) {
							for (const item of contents) {
								const video = item.richItemRenderer?.content?.videoRenderer || item.gridVideoRenderer || item.videoRenderer;
								if (video) {
									results.push({
										id: video.videoId,
										title: video.title?.runs?.[0]?.text || video.title?.simpleText || '',
										thumbnail: video.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`
									});
								}
							}
						}
					}
				} catch (e) { console.error('Error parsing channel ytInitialData:', e); }
			}
			
			if (results.length === 0) {
				// Fallback regex
				const matches = text.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"(.*?)"\}\]/g);
				for (const m of matches) {
					results.push({ id: m[1], title: m[2].replace(/\\u0026/g, '&'), thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` });
					if (results.length >= 30) break;
				}
			}
			return { results, thumbnail: channelThumbnail };
		} catch (e) {
			console.error('Channel fetch failed:', e);
			return { results: [] };
		}
	}

	private _apiConfig?: { key: string, version: string };

	private async _searchVideos(query: string, continuation?: string): Promise<{results: any[], continuation?: string}> {
		try {
			let data: any;
			if (continuation && this._apiConfig) {
				const response = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${this._apiConfig.key}`, {
					method: 'POST',
					body: JSON.stringify({
						context: { client: { clientName: 'WEB', clientVersion: this._apiConfig.version } },
						continuation: continuation
					}),
					headers: { 'Content-Type': 'application/json' }
				});
				if (!response.ok) return { results: [] };
				data = await response.json();
			} else {
				const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
					headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
				});
				const text = await res.text();
				const match = text.match(/var ytInitialData = (.*?);<\/script>/);
				if (match) {
					try {
						data = JSON.parse(match[1]);

						// Extract API config for future continuations
						const apiKeyMatch = text.match(/"INNERTUBE_API_KEY":"(.*?)"/);
						const clientVersionMatch = text.match(/"clientVersion":"(.*?)"/);
						if (apiKeyMatch && clientVersionMatch) {
							this._apiConfig = { key: apiKeyMatch[1], version: clientVersionMatch[1] };
						}
					} catch { /* ignore */ }
				}

				if (!data) {
					// Fallback to regex parsing if ytInitialData is missing or malformed
					const results: any[] = [];
					const matches = text.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"(.*?)"\}\]/g);
					for (const m of matches) {
						results.push({ 
							type: 'video',
							id: m[1], 
							title: m[2].replace(/\\u0026/g, '&'), 
							thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` 
						});
						if (results.length >= 20) break;
					}
					return { results };
				}
			}

			const allChannels: any[] = [];
			const allVideos: any[] = [];
			let nextContinuation: string | undefined;

			const processItems = (items: any[]) => {
				for (const content of items) {
					if (content.itemSectionRenderer) {
						processItems(content.itemSectionRenderer.contents);
					} else if (content.videoRenderer) {
						const v = content.videoRenderer;
						let thumb = v.thumbnail.thumbnails[0].url;
						if (thumb.startsWith('//')) thumb = 'https:' + thumb;
						allVideos.push({
							type: 'video',
							id: v.videoId,
							title: v.title.runs?.[0]?.text || v.title.simpleText,
							thumbnail: thumb,
							author: v.ownerText?.runs?.[0]?.text,
							views: v.shortViewCountText?.simpleText || v.viewCountText?.simpleText,
							published: v.publishedTimeText?.simpleText
						});
					} else if (content.channelRenderer) {
						const c = content.channelRenderer;
						let thumb = c.thumbnail.thumbnails[0].url;
						if (thumb.startsWith('//')) thumb = 'https:' + thumb;
						allChannels.push({
							type: 'channel',
							id: c.channelId,
							title: c.title.simpleText || c.title.runs?.[0]?.text,
							thumbnail: thumb,
							subscriberCount: c.subscriberCountText?.simpleText,
							videoCount: c.videoCountText?.simpleText,
							url: `https://www.youtube.com/channel/${c.channelId}`
						});
					} else if (content.continuationItemRenderer) {
						nextContinuation = content.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
					} else if (content.shelfRenderer) {
						const shelfContents = content.shelfRenderer.content?.verticalListRenderer?.items || content.shelfRenderer.content?.expandedShelfContentsRenderer?.items;
						if (shelfContents) processItems(shelfContents);
					} else if (content.richItemRenderer) {
						const richContent = content.richItemRenderer.content;
						if (richContent) processItems([richContent]);
					} else if (content.sectionListRenderer) {
						processItems(content.sectionListRenderer.contents);
					}
				}
			};

			const primaryContents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || 
				data.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems;

			if (primaryContents) {
				processItems(primaryContents);
			}

			const results: any[] = [];
			if (!continuation) {
				if (allChannels.length > 0) {
					results.push(...allChannels.slice(0, 5));
				}
				results.push(...allVideos);
			} else {
				// On pagination, only show videos
				results.push(...allVideos);
			}

			// Fallback helper for continuation token in different JSON structures
			if (!nextContinuation) {
				const sectionListArr = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
				if (sectionListArr.length > 0) {
					const lastItem = sectionListArr[sectionListArr.length - 1];
					if (lastItem?.continuationItemRenderer) {
						nextContinuation = lastItem.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
					}
				}
			}

			return { results, continuation: nextContinuation };
		} catch (e) {
			console.error('Search failed:', e);
			return { results: [] };
		}
	}


	public async resolveUrl(input: string): Promise<string> {
		const trimmed = input.trim();
		if (!trimmed) return '';

		if (/^https?:\/\//i.test(trimmed)) {
			const playlistId = extractPlaylistId(trimmed);
			const videoId = extractVideoId(trimmed);
			
			// If it's a playlist URL but NOT a specific video, resolve to the first video
			if (playlistId && !videoId) {
				const playlistData = await this._fetchPlaylist(playlistId);
				if (playlistData.ids.length > 0) {
					return `https://www.youtube.com/watch?v=${playlistData.ids[0]}&list=${playlistId}`;
				}
			}
			return trimmed;
		}

		if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return `https://www.youtube.com/watch?v=${trimmed}`;
		if (trimmed.includes('.') && !trimmed.includes(' ') && trimmed.length > 3) return 'https://' + trimmed;
		const { results } = await this._searchVideos(trimmed);
		if (results.length > 0) {
			const firstVideo = results.find(r => r.type === 'video');
			if (firstVideo) return `https://www.youtube.com/watch?v=${firstVideo.id}`;
			return results[0].url || trimmed;
		}
		return trimmed;
	}


	public async _findNextVideo(currentId: string): Promise<string | undefined> {
		if (this._currentPlaylist.length > 0) {
			const idx = this._currentPlaylist.indexOf(currentId);
			if (idx !== -1 && idx < this._currentPlaylist.length - 1) {
				return this._currentPlaylist[idx + 1];
			}
		}
		
		const ids = await this._fetchRelated(currentId);
		const filtered = ids.filter(id => id !== currentId);
		return filtered[Math.floor(Math.random() * Math.min(filtered.length, 5))];
	}

	public async _findPrevVideo(currentId: string): Promise<string | undefined> {
		if (this._currentPlaylist.length > 0) {
			const idx = this._currentPlaylist.indexOf(currentId);
			if (idx > 0) {
				return this._currentPlaylist[idx - 1];
			}
		}
		return undefined;
	}

	public openInPanel(url: string, title?: string, startTime?: number) {
		const wasMovingFromSidebar = !this._isTabActive;
		
		// If startTime not provided, try to take it from current session if moving from sidebar with same URL
		if (startTime === undefined && wasMovingFromSidebar && this._lastUrl === url) {
			startTime = this._lastTime;
		}

		this._isTabActive = true;
		
		// If we are moving from an active sidebar, transfer interaction state to ensure autoplay in tab
		if (wasMovingFromSidebar && this._sidebarHasInteracted) {
			this._tabHasInteracted = true;
		}

		if (this._tabPanel) {
			try {
				this._tabPanel.reveal();
				if (title) {
					this._tabPanel.title = title;
				}
				this.loadUrl(url, startTime, 'tab');
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
		this._lastTime = startTime ?? this._getTimestamp(url);
		
		// Keep interaction state if it was already set (e.g. when moving from sidebar)
		this._tabHasInteracted = this._tabHasInteracted || false;
		if (url && url !== 'about:blank') {
			void this._handleLoadRequest(url);
		}
		
		const videoId = extractVideoId(url) || '';
		const playlistId = extractPlaylistId(url);
		
		this._syncPlaylistState(playlistId);
		const canPrev = !!(playlistId && this._currentPlaylist.length > 0 && this._currentPlaylist.indexOf(videoId) > 0);

		panel.webview.html = this._getHtmlForWebview(this._formatYoutubeUrl(url, startTime, this._tabHasInteracted), url, { playlistId, playlistTitle: this._currentPlaylistTitle, canPrev });
		this._setupWebviewHandlers(panel.webview, true);

		panel.onDidDispose(() => {
			if (this._tabPanel === panel) this._tabPanel = undefined;
			if (this._isTabActive) {
				const targetUrl = this._lastUrl || url;
				const time = this._lastTime;
				void this._saveTimestamp(targetUrl, time);
				this.loadUrl(targetUrl, time, 'sidebar');
			}
		});

		panel.onDidChangeViewState(e => {
			const p = e.webviewPanel;
			const url = this._lastUrl;
			const time = this._lastTime;
			if (!url) return;

			if (p.visible) {
				// Tab became visible/active - sync FROM sidebar TO tab
				if (this._tabHasInteracted && !this._isTabActive) {
					this._isTabActive = true;
					this.loadUrl(url, time, 'tab');
				}
			} else {
				// Tab became hidden - sync FROM tab TO sidebar
				if (this._sidebarHasInteracted && this._isTabActive) {
					this._isTabActive = false;
					void this._saveTimestamp(url, time);
					this.loadUrl(url, time, 'sidebar');
				}
			}
		});
	}

	public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
		this._sidebarView = webviewView;
		this._sidebarHasInteracted = false;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
		this._setupWebviewHandlers(webviewView.webview, false);

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) this._isTabActive = false;
			const url = this._lastUrl;
			const time = this._lastTime;
			if (webviewView.visible && url) {
				this.loadUrl(url, time, 'sidebar');
			} else if (!webviewView.visible && url) {
					void this._saveTimestamp(url, time);
				if (this._tabPanel) this.loadUrl(url, time, 'tab');
			}
		});

		let initialUrl = 'about:blank';
		let initialOriginalUrl = '';
		let playlistId: string | undefined;
		let canPrev = false;

		const lastUrl = this._lastUrl || this._getHistory()[0]?.url;
		if (lastUrl) {
			const startTime = this._lastTime || this._getTimestamp(lastUrl);
			// Sidebar (view) interaction state decides initial autoplay
			initialUrl = this._formatYoutubeUrl(lastUrl, startTime, this._sidebarHasInteracted);
			initialOriginalUrl = lastUrl;
			this._lastUrl = lastUrl;
			this._lastTime = startTime;
			
			const videoId = extractVideoId(lastUrl) || '';
			playlistId = extractPlaylistId(lastUrl);

			this._syncPlaylistState(playlistId);
			canPrev = !!(playlistId && this._currentPlaylist.length > 0 && this._currentPlaylist.indexOf(videoId) > 0);

			// Trigger a background load request to ensure playlist and history/titles are restored/synced
			void this._handleLoadRequest(lastUrl);
		}
		webviewView.webview.html = this._getHtmlForWebview(initialUrl, initialOriginalUrl, { playlistId, playlistTitle: this._currentPlaylistTitle, canPrev });
	}

	private _getHtmlForWebview(initialUrl = 'about:blank', initialOriginalUrl = '', options: { playlistId?: string, playlistTitle?: string, canPrev?: boolean } = {}) {
		try {
			const webviewPath = path.join(this._extensionUri.fsPath, 'src', 'webview');
			const html = fs.readFileSync(path.join(webviewPath, 'index.html'), 'utf8');
			const style = fs.readFileSync(path.join(webviewPath, 'style.css'), 'utf8');
			let script = fs.readFileSync(path.join(webviewPath, 'script.js'), 'utf8');

			script = script
				.replace('%%INITIAL_URL_JSON%%', JSON.stringify(initialUrl))
				.replace('%%INITIAL_ORIGINAL_URL_JSON%%', JSON.stringify(initialOriginalUrl))
				.replace('%%PROXY_PORT_JSON%%', JSON.stringify(this._getProxyPort()))
				.replace('%%AUTOPLAY_JSON%%', JSON.stringify(this._getAutoplay()))
				.replace('%%INITIAL_PLAYLIST_ID_JSON%%', JSON.stringify(options.playlistId || null))
				.replace('%%INITIAL_CAN_PREV_JSON%%', JSON.stringify(!!options.canPrev))
				.replace('%%INITIAL_PLAYLIST_TITLE_JSON%%', JSON.stringify(options.playlistTitle || null))
				.replace('%%INITIAL_CHANNEL_URL_JSON%%', JSON.stringify(this._currentChannelUrl || null))
				.replace('%%INITIAL_CHANNEL_NAME_JSON%%', JSON.stringify(this._currentChannelName || null));

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
					if (isTab) this._tabHasInteracted = true;
					else this._sidebarHasInteracted = true;
					
					if (data.status === 'playing') {
						this._isTabActive = isTab;
						this.pauseAllExcept(isTab);
					}
					break;
				case 'timeUpdate': {
					if (data.url && data.url !== this._lastUrl) return; // Drop updates from old videos
					
					// Only update session time if this view is current active one
					if (isTab === this._isTabActive) {
						this._lastTime = data.time;
						const vid = this._extractVideoId(this._lastUrl || '');
						if (vid) this._timestampCache[vid] = data.time;
					}
					break;
				}
				case 'saveTimestamp':
					if (data.url && typeof data.time === 'number') {
						if (isTab === this._isTabActive) {
							if (data.url === (this._lastUrl || '')) this._lastTime = data.time;
							await this._saveTimestamp(data.url, data.time);
						}
					}
					break;
				case 'proxyLog': console.log(`[YOUTUBE_EXT][PROXY][${data.level}] ${data.message}`, ...(data.args || [])); break;
				case 'requestLoad': {
					const trimmedInput = data.value.trim();
					const isSearch = trimmedInput.includes(' ') || (!trimmedInput.includes('.') && !trimmedInput.startsWith('http') && !/^[a-zA-Z0-9_-]{11}$/.test(trimmedInput));
					if (isSearch) {
						const { results, continuation } = await this._searchVideos(trimmedInput);
						webview.postMessage({ type: 'searchResults', results, continuation, query: trimmedInput });
					} else {
						const resolvedUrl = await this.resolveUrl(data.value);
						await this._loadUrlTargeted(webview, isTab, resolvedUrl);
					}
					break;
				}
				case 'requestMoreSearchResults': {
					const { results, continuation } = await this._searchVideos(data.query, data.continuation);
					webview.postMessage({ type: 'moreSearchResults', results, continuation, query: data.query });
					break;
				}
				case 'requestHistory': 
					webview.postMessage({ type: 'history', value: this._getHistory() }); 
					break;
				case 'requestFavorites': 
					webview.postMessage({ type: 'favorites', value: this._getFavorites() }); 
					break;
				case 'addFavorite': 
					await this._saveFavorite(data.url, data.title, data.itemType, data.thumbnail); 
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
						const nextUrl = `https://www.youtube.com/watch?v=${nextId}${this._playlistId ? `&list=${this._playlistId}` : ''}`;
						const settingAutoplay = this._getAutoplay();
						if (data.manual || settingAutoplay) {
							await this._loadUrlTargeted(webview, isTab, nextUrl, 0);
						}
					}
					break;
				}
				case 'requestPrevVideo': {
					const prevId = await this._findPrevVideo(data.videoId);
					if (prevId) {
						const prevUrl = `https://www.youtube.com/watch?v=${prevId}${this._playlistId ? `&list=${this._playlistId}` : ''}`;
						await this._loadUrlTargeted(webview, isTab, prevUrl, 0);
					}
					break;
				}
				case 'videoEnded': {
					if (this._getAutoplay()) {
						const nextId = await this._findNextVideo(data.videoId);
						if (nextId) {
							const nextUrl = `https://www.youtube.com/watch?v=${nextId}${this._playlistId ? `&list=${this._playlistId}` : ''}`;
							await this._loadUrlTargeted(webview, isTab, nextUrl, 0);
						}
					}
					break;
				}
				case 'setAutoplay': await this._state.update(YouTubeViewProvider.autoplayKey, !!data.value); this.postToAll({ type: 'autoplayUpdated', value: !!data.value }); break;
				case 'openExternal': if (isTab) this.loadUrl(data.url, data.time, 'tab'); else { this.pause(); this.openInPanel(data.url, data.title, data.time); } break;
				case 'urlSelected': void this._saveUrl(data.value); break;
					break;
				case 'requestPlaylist': {
					const pId = data.url ? extractPlaylistId(data.url) : this._playlistId;
					if (pId) {
						if (pId !== this._playlistId) {
							// If different playlist, need to fetch it first
							const playlistData = await this._fetchPlaylist(pId);
							const playlistEntries = playlistData.ids.map(id => ({
								url: `https://www.youtube.com/watch?v=${id}&list=${pId}`,
								title: this._playlistTitles[id]
							}));
							webview.postMessage({ type: 'playlist', value: playlistEntries, playlistId: pId, playlistTitle: playlistData.title });
						} else {
							// Same playlist as current
							const playlistEntries = this._currentPlaylist.map(id => ({
								url: `https://www.youtube.com/watch?v=${id}&list=${this._playlistId}`,
								title: this._playlistTitles[id]
							}));
							webview.postMessage({ type: 'playlist', value: playlistEntries, playlistId: this._playlistId, playlistTitle: this._currentPlaylistTitle });
						}
					}
					break;
				}
				case 'requestChannelVideos': {
					const targetUrl = data.url || this._currentChannelUrl;
					const targetName = data.name || this._currentChannelName;
                    const providedThumb = data.thumbnail;
					if (targetUrl) {
						this._currentChannelUrl = targetUrl;
						this._currentChannelName = targetName;
						const { results, thumbnail } = await this._fetchChannelVideos(targetUrl);
                        const finalThumb = providedThumb || thumbnail;
						webview.postMessage({ type: 'channelVideos', results, channelName: targetName, channelThumbnail: finalThumb });
						this.postToAll({
							type: 'channelUpdated',
							authorUrl: this._currentChannelUrl,
							authorName: this._currentChannelName,
                            authorThumbnail: finalThumb
						});
					}
					break;
				}
			}
		});
	}

	private _getAutoplay(): boolean {
		return this._state.get<boolean>(YouTubeViewProvider.autoplayKey, true);
	}

	private _syncPlaylistState(playlistId: string | undefined) {
		if (!playlistId) {
			this._playlistId = undefined;
			this._currentPlaylist = [];
			this._playlistTitles = {};
		} else if (playlistId !== this._playlistId) {
			this._currentPlaylist = [];
			this._playlistTitles = {};
		}
	}
}
