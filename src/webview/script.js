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
let pendingRequests = {
    history: false,
    favorites: false,
    playlist: false,
    channel: false
};
let currentSearchQuery = '';
let currentSearchContinuation = null;
let currentFavoriteFilter = 'all';

let currentChannelUrl = initialChannelUrl;
let currentChannelName = initialChannelName;
let currentChannelThumbnail = null;

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

function attachListListener(btn, type, messageType) {
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasAlreadyOpen = (currentListType === type && resultsContainer.style.display !== 'none');
        if (wasAlreadyOpen) {
            closeList();
        } else {
            // Restore URL immediately when switching/opening, but don't hide the container to avoid flicker
            restoreUrlToInput();
            closeListBtn.style.display = 'none'; // Hide search close button if it was there
            
            pendingRequests[type] = true;
            vscode.postMessage({ type: messageType });
        }
    });
}

attachListListener(historyBtn, 'history', 'requestHistory');
attachListListener(favoritesBtn, 'favorites', 'requestFavorites');
attachListListener(playlistListBtn, 'playlist', 'requestPlaylist');
attachListListener(channelBtn, 'channel', 'requestChannelVideos');

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

function restoreUrlToInput() {
    if (lastLoadedOriginalUrl && input.value !== lastLoadedOriginalUrl) {
        input.value = lastLoadedOriginalUrl;
        clearBtn.style.display = 'block';
    }
}

function closeList(restoreUrl = true) {
    resultsContainer.style.display = 'none';
    document.body.classList.remove('list-open');
    closeListBtn.style.display = 'none';
    
    // Restore the current URL to the input when closing any list if it was changed (e.g. by search query)
    if (restoreUrl) {
        restoreUrlToInput();
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
		closeList(false);
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
	const matches = url.match(/[a-zA-Z0-9_-]{11,}/g);
	if (matches) {
		for (const m of matches) {
			if (m.length === 11) return m;
		}
	}
	return '';
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
            if (message.authorThumbnail) currentChannelThumbnail = message.authorThumbnail;
			channelBtn.style.display = currentChannelUrl ? 'flex' : 'none';
			channelBtn.title = currentChannelName ? `Videos from ${currentChannelName}` : "Channel Videos";
            updateFavoriteButton();
			break;


		case 'searchResults':
			showSearchResults(message.results, message.continuation, message.query);
			break;
		case 'moreSearchResults':
			showMoreSearchResults(message.results, message.continuation);
			break;
		case 'history':
			if (pendingRequests.history || (currentListType === 'history' && resultsContainer.style.display !== 'none')) {
			    showHistory(message.value);
                pendingRequests.history = false;
            }
			break;
		case 'favorites':
			favorites = message.value;
            if (pendingRequests.favorites || (currentListType === 'favorites' && resultsContainer.style.display !== 'none')) {
			    showFavorites(favorites);
                pendingRequests.favorites = false;
            }
			updateFavoriteButton();
            if (currentListType === 'search results' || currentListType === 'channel') {
                updateAllListStars();
            }
            if (currentListType === 'channel') {
                updateChannelHeaderStar();
            }
			break;
		case 'playlist':
			if (pendingRequests.playlist || (currentListType === 'playlist' && resultsContainer.style.display !== 'none')) {
				showPlaylist(message.value);
				pendingRequests.playlist = false;
			}
			break;
		case 'channelVideos':
			if (pendingRequests.channel || (currentListType === 'channel' && resultsContainer.style.display !== 'none')) {
                if (message.channelThumbnail) currentChannelThumbnail = message.channelThumbnail;
				showChannelVideos(message.channelName, message.results);
				pendingRequests.channel = false;
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

function renderList(title, items, type, onClearAll, append = false, extraElements = []) {
	if (!append) {
        resultsContainer.innerHTML = '';
        resultsContainer.scrollTop = 0;
    }
	currentListType = type;
	
    // Show integrated close button ONLY for search results
    closeListBtn.style.display = (type === 'search results' ? 'flex' : 'none');
    document.body.classList.add('list-open');
 
	// Header for history/favorites with Clear All
	if (!append && (onClearAll || title)) {
		const header = document.createElement('div');
		header.className = 'list-header';
		
		const titleEl = document.createElement('div');
		titleEl.className = 'list-title';
		titleEl.textContent = title;
		header.appendChild(titleEl);

        if (extraElements && extraElements.length > 0) {
            extraElements.forEach(el => header.appendChild(el));
        }

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

	if (!append && items.length === 0) {
		const noResults = document.createElement('div');
		noResults.className = 'no-results-msg';
		noResults.textContent = `No ${type} found`;
		resultsContainer.appendChild(noResults);
	} else {
		items.forEach(item => {
			let videoId, thumbnailUrl, linkUrl, itemTitle;
			
			if (type === 'search results' || type === 'channel') {
				videoId = item.id;
				thumbnailUrl = item.thumbnail;
                if (!thumbnailUrl && item.type === 'video' && videoId) {
                    thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
                }
				linkUrl = item.type === 'channel' ? (item.url || videoId) : `https://www.youtube.com/watch?v=${item.id}`;
				itemTitle = item.title;
			} else {
				videoId = extractVideoId(item.url);
				thumbnailUrl = item.thumbnail || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');
				linkUrl = item.url;
				itemTitle = item.title || item.url;
			}

			const div = document.createElement('div');
			div.className = 'list-item';
            div.dataset.url = linkUrl;
            if (item.type === 'channel') div.classList.add('channel-item');
            
			const isCurrent = linkUrl === lastLoadedOriginalUrl;
			if (isCurrent) div.classList.add('current');

            const isFav = isFavorited(linkUrl);

			div.innerHTML = `
				<div class="item-thumb ${item.type === 'channel' ? 'channel' : ''}" style="background-image: url('${thumbnailUrl}')"></div>
				<div class="item-info">
					<div class="item-title ${isCurrent ? 'current' : ''}">${itemTitle}</div>
                    ${item.type === 'channel' ? `<div class="item-stats">${item.subscriberCount || ''} ${item.subscriberCount && item.videoCount ? '•' : ''} ${item.videoCount || ''}</div>` : ''}
                    ${item.type === 'video' && item.author ? `<div class="item-author">${item.author}</div>` : ''}
				</div>
                <div class="item-actions">
				    ${(type === 'search results' && item.type === 'channel') ? `
                        <button class="item-fav-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
                            ${isFav ? '★' : '☆'}
                        </button>
                    ` : ''}
				    ${(type !== 'search results' && type !== 'playlist' && type !== 'channel') ? `<button class="item-remove-btn" title="Remove">✕</button>` : ''}
                </div>
			`;
			
			div.addEventListener('click', (e) => {
				if (e.target.closest('.item-remove-btn') || e.target.closest('.item-fav-btn')) return;
                if (item.type === 'channel') {
                    pendingChannelRequest = true;
                    currentChannelThumbnail = item.thumbnail;
                    vscode.postMessage({ type: 'requestChannelVideos', url: linkUrl, name: itemTitle, thumbnail: item.thumbnail });
                } else {
				    loadVideo(linkUrl);
                }
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
			} else if (type === 'search results' && item.type === 'channel') {
                const favBtn = div.querySelector('.item-fav-btn');
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const currentlyFav = isFavorited(linkUrl);
                    if (currentlyFav) {
                        vscode.postMessage({ type: 'removeFavorite', url: linkUrl });
                    } else {
                        vscode.postMessage({ 
                            type: 'addFavorite', 
                            url: linkUrl, 
                            title: itemTitle,
                            itemType: item.type,
                            thumbnail: item.thumbnail
                        });
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

function showSearchResults(results, continuation, query) {
    currentSearchQuery = query;
    currentSearchContinuation = continuation;
	renderList('Search results', results, 'search results');
    updateLoadMoreButton();
}

function showMoreSearchResults(results, continuation) {
    currentSearchContinuation = continuation;
    renderList('Search results', results, 'search results', null, true);
    updateLoadMoreButton();
}

function updateLoadMoreButton() {
    const existingBtn = document.getElementById('load-more-btn');
    if (existingBtn) existingBtn.remove();

    if (currentSearchContinuation && currentListType === 'search results') {
        const btn = document.createElement('button');
        btn.id = 'load-more-btn';
        btn.className = 'load-more-btn';
        btn.textContent = 'Load More Results';
        btn.onclick = () => {
            btn.textContent = 'Loading...';
            btn.disabled = true;
            vscode.postMessage({ 
                type: 'requestMoreSearchResults', 
                query: currentSearchQuery, 
                continuation: currentSearchContinuation 
            });
        };
        resultsContainer.appendChild(btn);
    }
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
    const items = currentFavoriteFilter === 'all' 
        ? urls 
        : urls.filter(u => {
            if (currentFavoriteFilter === 'video') return u.type !== 'channel';
            if (currentFavoriteFilter === 'channel') return u.type === 'channel';
            return true;
        });

    const filterEl = document.createElement('div');
    filterEl.className = 'favorite-filters';
    ['all', 'video', 'channel'].forEach(f => {
        const btn = document.createElement('button');
        btn.className = `filter-btn ${currentFavoriteFilter === f ? 'active' : ''}`;
        btn.textContent = f.charAt(0).toUpperCase() + f.slice(1) + 's';
        if (f === 'all') btn.textContent = 'All';
        btn.onclick = (e) => {
            e.stopPropagation();
            currentFavoriteFilter = f;
            showFavorites(urls);
        };
        filterEl.appendChild(btn);
    });

	renderList('Favorites', items, 'favorites', null, false, [filterEl]);
}

function showPlaylist(urls) {
	renderList('Playlist Videos', urls, 'playlist');
}

function showChannelVideos(channelName, results) {
    const isFav = isFavorited(currentChannelUrl);
    const favBtn = document.createElement('button');
    favBtn.id = 'channel-header-fav-btn';
    favBtn.className = `header-fav-btn ${isFav ? 'active' : ''}`;
    favBtn.textContent = isFav ? '★' : '☆';
    favBtn.title = isFav ? 'Remove Channel' : 'Add Channel to Favorites';
    favBtn.onclick = (e) => {
        e.stopPropagation();
        if (isFav) {
            vscode.postMessage({ type: 'removeFavorite', url: currentChannelUrl });
        } else {
            vscode.postMessage({ 
                type: 'addFavorite', 
                url: currentChannelUrl, 
                title: channelName,
                itemType: 'channel',
                thumbnail: currentChannelThumbnail
            });
        }
    };
	renderList(channelName ? `Videos from ${channelName}` : 'Channel Videos', results, 'channel', null, false, [favBtn]);
}

function isFavorited(url) {
    if (!url) return false;
    return favorites.some(f => f.url === url);
}



function updateFavoriteButton() {
    // Current Video Button
    if (!currentVideoId) {
        favCurrentBtn.style.display = 'none';
    } else {
        favCurrentBtn.style.display = 'flex';
        const isFav = isFavorited(lastLoadedOriginalUrl);
        favCurrentBtn.classList.toggle('active', isFav);
    }
}

function updateAllListStars() {
    const items = resultsContainer.querySelectorAll('.list-item');
    items.forEach(div => {
        const url = div.dataset.url;
        if (url) {
            const isFav = isFavorited(url);
            const favBtn = div.querySelector('.item-fav-btn');
            if (favBtn) {
                favBtn.classList.toggle('active', isFav);
                favBtn.textContent = isFav ? '★' : '☆';
            }
        }
    });
}

function updateChannelHeaderStar() {
    const btn = document.getElementById('channel-header-fav-btn');
    if (!btn || !currentChannelUrl) return;
    
    const isFav = isFavorited(currentChannelUrl);
    btn.classList.toggle('active', isFav);
    btn.textContent = isFav ? '★' : '☆';
    btn.title = isFav ? 'Remove Channel' : 'Add Channel to Favorites';
    
    // Also update current favorited state if we just re-rendered this without rebinding the click
    // But since the onclick uses isFav which is closure-captured from the original function call,
    // it's better to just re-trigger the view or define onclick in a way that doesn't capture the old isFav.
    
    // Better: update the onclick to re-calculate isFav internally
    btn.onclick = (e) => {
        e.stopPropagation();
        const freshFav = isFavorited(currentChannelUrl);
        if (freshFav) {
            vscode.postMessage({ type: 'removeFavorite', url: currentChannelUrl });
        } else {
            vscode.postMessage({ 
                type: 'addFavorite', 
                url: currentChannelUrl, 
                title: currentChannelName,
                itemType: 'channel',
                thumbnail: currentChannelThumbnail
            });
        }
    };
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
