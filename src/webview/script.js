const vscode = acquireVsCodeApi();

function log(msg, ...args) {
    if (msg && (msg.includes('ERROR') || msg.includes('CRITICAL'))) {
        console.error(`[YOUTUBE_EXT][WEBVIEW] ${msg}`, ...args);
        vscode.postMessage({ type: 'log', message: msg, args: args });
    }
}

function proxyLog(level, msg, ...args) {
    if (level !== 'error') return; // ONLY ERRORS
    console[level](msg, ...args);
    window.parent.postMessage({ type: 'proxyLog', level, message: msg, args }, '*');
}



window.onerror = function(msg, url, line, col, error) {
    log('UNHANDLED ERROR:', { msg, url, line, col, error: error?.stack || error });
};

window.addEventListener('unhandledrejection', function(event) {
    log('UNHANDLED REJECTION:', event.reason);
});




const initialUrl = %%INITIAL_URL_JSON%%;
const initialOriginalUrl = %%INITIAL_ORIGINAL_URL_JSON%%;
const currentProxyPort = %%PROXY_PORT_JSON%%;
const initialAutoplaySetting = %%AUTOPLAY_JSON%%;
const initialPlaylistId = %%INITIAL_PLAYLIST_ID_JSON%%;
const initialCanPrev = %%INITIAL_CAN_PREV_JSON%%;
const initialChannelUrl = %%INITIAL_CHANNEL_URL_JSON%%;
const initialChannelName = %%INITIAL_CHANNEL_NAME_JSON%%;

const input = document.getElementById('url-input');
const clearBtn = document.getElementById('clear-btn');
const nextBtn = document.getElementById('next-btn');
const prevBtn = document.getElementById('prev-btn');
const openBtn = document.getElementById('open-btn');
const historyBtn = document.getElementById('history-btn');
const favoritesBtn = document.getElementById('favorites-btn');
const playlistListBtn = document.getElementById('playlist-list-btn');
const channelBtn = document.getElementById('channel-btn');
const favCurrentBtn = document.getElementById('fav-current-btn');
const iframe = document.getElementById('video-frame');
const emptyState = document.getElementById('empty-state');
const resultsContainer = document.getElementById('results-container');
const autoplayCheck = document.getElementById('autoplay-check');
const closeListBtn = document.getElementById('close-list-btn');
const statusText = document.getElementById('status-text');
const header = document.querySelector('.header');

let favorites = [];
let currentListType = null;
let currentPlaylistId = null;
let pendingHistoryRequest = false;
let pendingFavoritesRequest = false;
let pendingPlaylistRequest = false;
let pendingChannelRequest = false;

let currentChannelUrl = initialChannelUrl;
let currentChannelName = initialChannelName;

let currentVideoId = extractVideoId(initialUrl);
let isPaused = false;
let isIframeReady = false;
let pendingIframeLoad = null;

// Load saved settings
const savedState = vscode.getState() || {};
autoplayCheck.checked = initialAutoplaySetting;

let lastCurrentTime = 0;
let lastGlobalSaveTime = 0;
let lastRetryTime = 0;

autoplayCheck.addEventListener('change', () => {
    vscode.postMessage({ type: 'setAutoplay', value: autoplayCheck.checked });
	saveState();
});

let lastLoadedUrl = initialUrl;
let lastLoadedOriginalUrl = initialOriginalUrl;

// Global variable to keep track of the last saved state
let lastStateJson = '';

function saveState() {
	const state = { 
		autoplay: autoplayCheck.checked,
		currentUrl: lastLoadedUrl,
		currentOriginalUrl: lastLoadedOriginalUrl,
		currentTime: lastCurrentTime
	};
	const stateJson = JSON.stringify(state);
	if (stateJson !== lastStateJson) {
		vscode.setState(state);
		lastStateJson = stateJson;
	}
}





let effectiveUrl = initialUrl;
let effectiveOriginalUrl = initialOriginalUrl;

// Prefer extension-provided initial values if they exist, otherwise fallback to saved state
if ((effectiveUrl === 'about:blank' || !effectiveUrl) && savedState.currentUrl && savedState.currentUrl !== 'about:blank') {
	effectiveUrl = savedState.currentUrl;
	effectiveOriginalUrl = savedState.currentOriginalUrl || '';
}

// Restore time from state only if we are loading the same video as what was in state
if (savedState.currentUrl && extractVideoId(savedState.currentUrl) === extractVideoId(effectiveUrl) && typeof savedState.currentTime === 'number' && savedState.currentTime > 0) {
	lastCurrentTime = savedState.currentTime;
	
	// If the current URL doesn't have a start parameter, or if the saved time is newer, update it
	// But let's trust the extension's URL if it already has a start parameter
	if (!effectiveUrl.includes('start=')) {
		if (effectiveUrl.includes('?')) {
			effectiveUrl += '&start=' + Math.floor(lastCurrentTime);
		} else {
			effectiveUrl += '?start=' + Math.floor(lastCurrentTime);
		}
	}
}

// FIX: If the proxy port changed since last save, update it to the current one
// FIX: If the proxy port changed since last save, update it to the current one
if (effectiveUrl.includes('127.0.0.1') && currentProxyPort > 0) {
	try {
		const urlObj = new URL(effectiveUrl);
		if (urlObj.port && urlObj.port != currentProxyPort) {
			effectiveUrl = effectiveUrl.replace('127.0.0.1:' + urlObj.port, '127.0.0.1:' + currentProxyPort);
		}

	} catch (e) {
		log('Error during port fix:', e);
	}
}


lastLoadedUrl = effectiveUrl;
lastLoadedOriginalUrl = effectiveOriginalUrl;

if (effectiveOriginalUrl) {
	input.value = effectiveOriginalUrl;
	clearBtn.style.display = 'block';
}

// Set initial playlist button states
prevBtn.style.display = initialPlaylistId ? 'flex' : 'none';
playlistListBtn.style.display = initialPlaylistId ? 'flex' : 'none';
channelBtn.style.display = initialChannelUrl ? 'flex' : 'none';
channelBtn.title = initialChannelName ? `Videos from ${initialChannelName}` : "Channel Videos";
prevBtn.disabled = !initialCanPrev;
prevBtn.title = initialCanPrev ? "Previous (Playlist)" : "First Video (Playlist)";
nextBtn.style.display = 'flex';
openBtn.style.display = 'flex';

if (effectiveUrl && effectiveUrl !== 'about:blank') {
	iframe.src = effectiveUrl;
	emptyState.style.display = 'none';
	statusText.textContent = 'Loading...';
	currentVideoId = extractVideoId(effectiveUrl);
    nextBtn.style.display = 'flex';
    openBtn.style.display = 'flex';
} else {
	iframe.src = 'about:blank';
	emptyState.style.display = 'flex';
	statusText.textContent = 'Ready';
	currentVideoId = '';
	prevBtn.style.display = 'none';
	playlistListBtn.style.display = 'none';
    favCurrentBtn.style.display = 'none';
    channelBtn.style.display = 'none';
    nextBtn.style.display = 'none';
    openBtn.style.display = 'none';
	setTimeout(() => emptyUrlInput.focus(), 100);
}



vscode.postMessage({ type: 'webviewReady' });
vscode.postMessage({ type: 'requestFavorites' });

input.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		const url = input.value;
		if (url) { loadVideo(url); }
	} else if (e.key === 'Escape') {
		closeList();
	}
});

input.addEventListener('input', () => {
	clearBtn.style.display = input.value ? 'block' : 'none';
});

clearBtn.addEventListener('click', () => {
	input.value = '';
	clearBtn.style.display = 'none';
	input.focus();
});

input.addEventListener('click', () => {
	input.select();
});


const emptyUrlInput = document.getElementById('empty-url-input');
const emptyUrlBtn = document.getElementById('empty-url-btn');

emptyUrlInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		const url = emptyUrlInput.value;
		if (url) { loadVideo(url); }
	} else if (e.key === 'Escape') {
		closeList();
	}
});

emptyUrlBtn.addEventListener('click', () => {
	const url = emptyUrlInput.value;
	if (url) { loadVideo(url); }
});

nextBtn.addEventListener('click', () => {
	requestNext(true);
});

prevBtn.addEventListener('click', () => {
	requestPrev();
});

openBtn.addEventListener('click', () => {
	const normalized = normalizeInput(input.value);
	if (normalized) {
		vscode.postMessage({ 
			type: 'openExternal', 
			url: normalized,
			time: lastCurrentTime || 0,
			title: statusText.textContent === 'Playing' || statusText.textContent === 'Paused' ? undefined : statusText.textContent
		});
	}
});

historyBtn.addEventListener('click', (e) => {
	e.stopPropagation();
    if (currentListType === 'history' && resultsContainer.style.display !== 'none') {
        closeList();
    } else {
        pendingHistoryRequest = true;
	    vscode.postMessage({ type: 'requestHistory' });
    }
});

favoritesBtn.addEventListener('click', (e) => {
	e.stopPropagation();
    if (currentListType === 'favorites' && resultsContainer.style.display !== 'none') {
        closeList();
    } else {
        pendingFavoritesRequest = true;
        log('Requesting favorites from extension');
        vscode.postMessage({ type: 'requestFavorites' });
    }
});

playlistListBtn.addEventListener('click', (e) => {
	e.stopPropagation();
    if (currentListType === 'playlist' && resultsContainer.style.display !== 'none') {
        closeList();
    } else {
        pendingPlaylistRequest = true;
        vscode.postMessage({ type: 'requestPlaylist' });
    }
});

channelBtn.addEventListener('click', (e) => {
	e.stopPropagation();
    if (currentListType === 'channel' && resultsContainer.style.display !== 'none') {
        closeList();
    } else {
        pendingChannelRequest = true;
        vscode.postMessage({ type: 'requestChannelVideos' });
    }
});

favCurrentBtn.addEventListener('click', () => {
    if (!currentVideoId) return;
    
    const currentlyFavorited = isFavorited(lastLoadedOriginalUrl);
    if (currentlyFavorited) {
        vscode.postMessage({ type: 'removeFavorite', url: lastLoadedOriginalUrl });
    } else {
        vscode.postMessage({ 
            type: 'addFavorite', 
            url: lastLoadedOriginalUrl, 
            title: statusText.textContent === 'Playing' || statusText.textContent === 'Paused' ? undefined : statusText.textContent 
        });
    }
});

closeListBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeList();
});

function closeList() {
    const isSearch = currentListType === 'search results';
    resultsContainer.style.display = 'none';
    document.body.classList.remove('list-open');
    closeListBtn.style.display = 'none';
    
    // Restore the current URL to the input ONLY when closing search results
    if (isSearch && lastLoadedOriginalUrl) {
        input.value = lastLoadedOriginalUrl;
        clearBtn.style.display = 'block';
    }

    currentListType = null;

    if (!currentVideoId && (!iframe.src || iframe.src === 'about:blank')) {
        emptyState.style.display = 'flex';
        iframe.style.display = 'none';
    } else {
        emptyState.style.display = 'none';
        iframe.style.display = 'block';
    }
    statusText.textContent = (currentVideoId && !isPaused) ? 'Playing' : 'Ready';
}

document.addEventListener('click', () => {
    // No dropdowns to hide anymore
});

resultsContainer.addEventListener('mouseleave', (e) => {
    if (currentListType && currentListType !== 'search results') {
        // If moving to the header area (top: 0 to top: 72px), let's see if we should close
        // But maybe it's simpler to just close it as requested
        closeList();
    }
});





function loadVideo(url) {
	const normalized = normalizeInput(url);
	
	if (!normalized) {
		statusText.textContent = 'Invalid Input';
		return;
	}

	const isSearch = normalized.includes(' ') || (!normalized.includes('.') && !normalized.startsWith('http') && !/^[a-zA-Z0-9_-]{11}$/.test(normalized));
	
	if (isSearch) {
		statusText.textContent = 'Searching...';
	} else {
		statusText.textContent = 'Loading...';
	}

	vscode.postMessage({ type: 'requestLoad', value: normalized });


	
	setTimeout(() => {
		closeList();
	}, 50);

	
	updateFavoriteButton();
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

	if (data && data.type === 'proxyLog') {
		vscode.postMessage({ type: 'proxyLog', level: data.level, message: data.message, args: data.args });
	}

	if (data && data.event === 'timeUpdate' && typeof data.time === 'number') {
		// Ignore events from old videos
		if (data.videoId && data.videoId !== currentVideoId) {
			log('Ignoring timeUpdate from old video:', data.videoId, 'current:', currentVideoId);
			return;
		}
		
		// Self-healing: if the actual video ID in the player doesn't match what we expect
		if (data.actualVideoId && currentVideoId && data.actualVideoId !== currentVideoId) {
			log('CRITICAL: Player is playing WRONG video ID:', data.actualVideoId, 'expected:', currentVideoId);
			if (!lastRetryTime || Date.now() - lastRetryTime > 5000) {
				log('Attempting emergency retry of load command...');
				lastRetryTime = Date.now();
				const retryData = { type: 'load', id: currentVideoId, startTime: lastCurrentTime, autoplay: true };
				iframe.contentWindow.postMessage(retryData, '*');
			}
		}

		lastCurrentTime = data.time;


		
		// Inform extension host (memory only, for visibility change triggers)
		vscode.postMessage({ type: 'timeUpdate', time: lastCurrentTime, url: lastLoadedOriginalUrl });
		
		// VS Code state (for panel hide/show) - can be updated frequently as it's memory-mapped
		saveState();
		
		// Global storage (to survive VS Code restart) - only every 5 seconds
		const now = Date.now();
		if (now - lastGlobalSaveTime > 5000) {
			lastGlobalSaveTime = now;
			vscode.postMessage({ 
				type: 'saveTimestamp', 
				url: lastLoadedOriginalUrl, 
				time: Math.floor(lastCurrentTime) 
			});
		}
	}

	if (data && data.event === 'infoDelivery' && data.info) {
		// Ignore events from old videos
		if (data.videoId && data.videoId !== currentVideoId) {
			log('Ignoring infoDelivery from old video:', data.videoId, 'current:', currentVideoId);
			return;
		}

		const newState = data.info.playerState;
		if (newState === 1) { // PLAYING
			isPaused = false;
			statusText.textContent = 'Playing';
			vscode.postMessage({ type: 'playbackStatus', status: 'playing' });
		} else if (newState === 2) { // PAUSED
			isPaused = true;
			statusText.textContent = 'Paused';
			vscode.postMessage({ type: 'playbackStatus', status: 'paused' });
			// Save immediately on pause
			vscode.postMessage({ 
				type: 'saveTimestamp', 
				url: lastLoadedOriginalUrl, 
				time: Math.floor(lastCurrentTime) 
			});
		} else if (newState === 0) { // ENDED
			isPaused = true;
			statusText.textContent = 'Ended';
			vscode.postMessage({ type: 'videoEnded', videoId: currentVideoId });
		}
	}

	if (data && data.type === 'playerReady') {
		isIframeReady = true;
		if (pendingIframeLoad) {
			iframe.contentWindow.postMessage(pendingIframeLoad, '*');
			pendingIframeLoad = null;
		}
	}



	switch (message.type) {
		case 'loadUrl':
			const nextId = extractVideoId(message.value);
			const startTime = message.startTime || 0;
			const startAutoplay = message.autoplay !== false;
			const proxyUrlPrefix = message.value.split('/embed')[0] + '/embed';
			const isSameVideo = nextId === currentVideoId;
			const isSameProxy = iframe.src.startsWith(proxyUrlPrefix);
			
			if (isSameProxy) {

				const loadData = { type: 'load', id: nextId, startTime: startTime, autoplay: startAutoplay };
				
				if (isIframeReady) {
					iframe.contentWindow.postMessage(loadData, '*');
				} else {
					pendingIframeLoad = loadData;
				}


			} else {
				log('New proxy instance or port changed, reloading iframe.src', message.value);
				isIframeReady = false;
				pendingIframeLoad = null;
				iframe.src = message.value;
			}
			
			input.value = message.originalUrl || message.value;
			clearBtn.style.display = input.value ? 'block' : 'none';
			
			const oldId = currentVideoId;
			currentVideoId = nextId;
			lastLoadedUrl = message.value;
			lastLoadedOriginalUrl = message.originalUrl || message.value;

			
			// Only reset time if it's a new video or if it's not a resume-from-pause event
			if (startTime === 0) {
				lastCurrentTime = 0;
			} else {
				lastCurrentTime = startTime;
			}
			
			saveState();



			
			emptyState.style.display = 'none';
			statusText.textContent = 'Loading...';
			isPaused = !startAutoplay;
			
			// Show/Hide and Disable/Enable Previous button
			prevBtn.style.display = message.playlistId ? 'flex' : 'none';
			playlistListBtn.style.display = message.playlistId ? 'flex' : 'none';
			currentPlaylistId = message.playlistId;
			prevBtn.disabled = !message.canPrev;
			prevBtn.title = message.canPrev ? "Previous (Playlist)" : "First Video (Playlist)";
			nextBtn.style.display = 'flex';
			openBtn.style.display = 'flex';

			currentChannelUrl = message.authorUrl;
			currentChannelName = message.authorName;
			channelBtn.style.display = currentChannelUrl ? 'flex' : 'none';
			channelBtn.title = currentChannelName ? `Videos from ${currentChannelName}` : "Channel Videos";

			updateFavoriteButton();
			break;

		case 'channelUpdated':
			currentChannelUrl = message.authorUrl;
			currentChannelName = message.authorName;
			channelBtn.style.display = currentChannelUrl ? 'flex' : 'none';
			channelBtn.title = currentChannelName ? `Videos from ${currentChannelName}` : "Channel Videos";
			break;


		case 'searchResults':
			showSearchResults(message.results);
			break;
		case 'history':
			if (pendingHistoryRequest || (currentListType === 'history' && resultsContainer.style.display !== 'none')) {
			    showHistory(message.value);
                pendingHistoryRequest = false;
            }
			break;
		case 'favorites':
			favorites = message.value;
            if (pendingFavoritesRequest || (currentListType === 'favorites' && resultsContainer.style.display !== 'none')) {
			    showFavorites(favorites);
                pendingFavoritesRequest = false;
            }
			updateFavoriteButton();
			break;
		case 'playlist':
			if (pendingPlaylistRequest || (currentListType === 'playlist' && resultsContainer.style.display !== 'none')) {
				showPlaylist(message.value);
				pendingPlaylistRequest = false;
			}
			break;
		case 'channelVideos':
			if (pendingChannelRequest || (currentListType === 'channel' && resultsContainer.style.display !== 'none')) {
				showChannelVideos(message.channelName, message.results);
				pendingChannelRequest = false;
			}
			break;
		case 'autoplayUpdated':
			autoplayCheck.checked = !!message.value;
			saveState();
			break;


		case 'togglePlay':
			togglePlay();
			break;
		case 'pause':
			pause();
			break;
		case 'nextVideo':
			requestNext(true);
			break;
		case 'prevVideo':
			requestPrev();
			break;
		case 'stateCleared':
			log('State cleared by extension');
			lastLoadedUrl = 'about:blank';
			lastLoadedOriginalUrl = '';
			currentVideoId = '';
			lastCurrentTime = 0;
			iframe.src = 'about:blank';
			input.value = '';
			emptyUrlInput.value = '';
			emptyState.style.display = 'flex';
			statusText.textContent = 'Ready';
			clearBtn.style.display = 'none';
			prevBtn.style.display = 'none';
			channelBtn.style.display = 'none';
			saveState();
			setTimeout(() => emptyUrlInput.focus(), 100);
			break;
	}
	saveState();
});

function requestNext(force = false) {
	if (currentVideoId) {
		statusText.textContent = 'Finding next...';
		vscode.postMessage({ 
			type: 'requestNextVideo', 
			videoId: currentVideoId,
			manual: !!force
		});
	}
}

function requestPrev() {
	if (currentVideoId) {
		statusText.textContent = 'Finding previous...';
		vscode.postMessage({ 
			type: 'requestPrevVideo', 
			videoId: currentVideoId
		});
	}
}

function renderList(title, items, type, onClearAll) {
	resultsContainer.innerHTML = '';
	currentListType = type;
	
    // Show integrated close button ONLY for search results
    closeListBtn.style.display = (type === 'search results' ? 'flex' : 'none');
    document.body.classList.add('list-open');

	// Header for history/favorites with Clear All
	if (onClearAll || title) {
		const header = document.createElement('div');
		header.className = 'list-header';
		
		const titleEl = document.createElement('div');
		titleEl.className = 'list-title';
		titleEl.textContent = title;
		header.appendChild(titleEl);

		if (onClearAll) {
			const clearBtn = document.createElement('button');
			clearBtn.className = 'clear-all-btn-big';
			clearBtn.textContent = 'Clear All';
			clearBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				onClearAll();
			});
			header.appendChild(clearBtn);
		}
		resultsContainer.appendChild(header);
	}

	if (items.length === 0) {
		const noResults = document.createElement('div');
		noResults.className = 'no-results-msg';
		noResults.textContent = `No ${type} found`;
		resultsContainer.appendChild(noResults);
	} else {
		items.forEach(item => {
			let videoId, thumbnailUrl, linkUrl, itemTitle;
			
			if (type === 'search results' || type === 'channel') {
				videoId = item.id;
				thumbnailUrl = item.thumbnail || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');
				linkUrl = `https://www.youtube.com/watch?v=${item.id}`;
				itemTitle = item.title;
			} else {
				videoId = extractVideoId(item.url);
				thumbnailUrl = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '';
				linkUrl = item.url;
				itemTitle = item.title || item.url;
			}

			const div = document.createElement('div');
			div.className = 'list-item';
			const isCurrent = linkUrl === lastLoadedOriginalUrl;
			if (isCurrent) div.classList.add('current');

			div.innerHTML = `
				<div class="item-thumb" style="background-image: url('${thumbnailUrl}')"></div>
				<div class="item-info">
					<div class="item-title ${isCurrent ? 'current' : ''}">${itemTitle}</div>
				</div>
				${(type !== 'search results' && type !== 'playlist' && type !== 'channel') ? `<button class="item-remove-btn" title="Remove">✕</button>` : ''}
			`;
			
			div.addEventListener('click', (e) => {
				if (e.target.classList.contains('item-remove-btn')) return;
				loadVideo(linkUrl);
			});

			if (type !== 'search results' && type !== 'playlist' && type !== 'channel') {
				const removeBtn = div.querySelector('.item-remove-btn');
				removeBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					if (type === 'history') {
						vscode.postMessage({ type: 'removeHistory', url: item.url });
					} else {
						vscode.postMessage({ type: 'removeFavorite', url: item.url });
					}
				});
			}

			resultsContainer.appendChild(div);
		});
	}
	resultsContainer.style.display = 'flex';
	emptyState.style.display = 'none';
	statusText.textContent = title;
}

function showSearchResults(results) {
	renderList('Search results', results, 'search results');
}

function normalizeInput(url) {
	const trimmed = url.trim();
	if (!trimmed) return '';
	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
	
	// If it looks like a search query (contains spaces or no dot), return as is
	if (trimmed.includes(' ') || !trimmed.includes('.')) {
		return trimmed;
	}
	
	return 'https://' + trimmed;
}

function showHistory(urls) {
	renderList('Recent History', urls, 'history', () => {
		vscode.postMessage({ type: 'clearHistory' });
	});
}

function showFavorites(urls) {
	renderList('Favorites', urls, 'favorites');
}

function showPlaylist(urls) {
	renderList('Playlist Videos', urls, 'playlist');
}

function showChannelVideos(channelName, results) {
	renderList(channelName ? `Videos from ${channelName}` : 'Channel Videos', results, 'channel');
}

function isFavorited(url) {
    if (!url) return false;
    return favorites.some(f => f.url === url);
}



function updateFavoriteButton() {
    if (!currentVideoId) {
        favCurrentBtn.style.display = 'none';
        return;
    }
    favCurrentBtn.style.display = 'flex';
    const isFav = isFavorited(lastLoadedOriginalUrl);

    if (isFav) {
        favCurrentBtn.classList.add('active');
        favCurrentBtn.title = 'Remove from Favorites';
    } else {
        favCurrentBtn.classList.remove('active');
        favCurrentBtn.title = 'Add to Favorites';
    }
}


function togglePlay() {
	const command = isPaused ? 'playVideo' : 'pauseVideo';
	if (iframe && iframe.contentWindow) {
		iframe.contentWindow.postMessage({
			event: 'command',
			func: command
		}, '*');
	}
}

function pause() {
	if (!isPaused && iframe && iframe.contentWindow) {
		iframe.contentWindow.postMessage({
			event: 'command',
			func: 'pauseVideo'
		}, '*');
	}
}
