const vscode = acquireVsCodeApi();

const initialUrl = %%INITIAL_URL_JSON%%;
const initialOriginalUrl = %%INITIAL_ORIGINAL_URL_JSON%%;
const input = document.getElementById('url-input');
const clearBtn = document.getElementById('clear-btn');
const nextBtn = document.getElementById('next-btn');
const openBtn = document.getElementById('open-btn');
const historyBtn = document.getElementById('history-btn');
const historyDropdown = document.getElementById('history-dropdown');
const favoritesBtn = document.getElementById('favorites-btn');
const favoritesDropdown = document.getElementById('favorites-dropdown');
const favCurrentBtn = document.getElementById('fav-current-btn');
const iframe = document.getElementById('video-frame');
const emptyState = document.getElementById('empty-state');
const resultsContainer = document.getElementById('results-container');
const autoplayCheck = document.getElementById('autoplay-check');
const statusText = document.getElementById('status-text');

let favorites = [];

let currentVideoId = extractVideoId(initialUrl);
let isPaused = false;
let isIframeReady = false;
let pendingIframeLoad = null;

// Load saved settings
const savedState = vscode.getState() || { autoplay: true };
autoplayCheck.checked = !!savedState.autoplay;
let lastCurrentTime = 0;
let lastGlobalSaveTime = 0;

autoplayCheck.addEventListener('change', () => {
	saveState();
});

let lastLoadedUrl = initialUrl;
let lastLoadedOriginalUrl = initialOriginalUrl;

function saveState() {
	vscode.setState({ 
		autoplay: autoplayCheck.checked,
		currentUrl: lastLoadedUrl,
		currentOriginalUrl: input.value,
		currentTime: lastCurrentTime
	});
}


// Priority: 1. vscode.getState(), 2. initialUrl from extension
let effectiveUrl = (savedState && savedState.currentUrl && savedState.currentUrl !== 'about:blank') 
	? savedState.currentUrl 
	: initialUrl;
const effectiveOriginalUrl = (savedState && savedState.currentOriginalUrl) 
	? savedState.currentOriginalUrl 
	: initialOriginalUrl;

// If we are loading the same URL that was in state, restore its time
if (savedState && savedState.currentUrl === effectiveUrl && typeof savedState.currentTime === 'number' && savedState.currentTime > 0) {
	lastCurrentTime = savedState.currentTime;
	// Update effectiveUrl to include the latest saved time
	if (effectiveUrl.includes('start=')) {
		effectiveUrl = effectiveUrl.replace(/start=\d+/, 'start=' + Math.floor(lastCurrentTime));
	} else if (effectiveUrl.includes('?')) {
		effectiveUrl += '&start=' + Math.floor(lastCurrentTime);
	} else {
		effectiveUrl += '?start=' + Math.floor(lastCurrentTime);
	}
}

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
	clearBtn.style.display = 'block';
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
vscode.postMessage({ type: 'requestFavorites' });

input.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		const url = input.value;
		if (url) { loadVideo(url); }
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


nextBtn.addEventListener('click', () => {
	requestNext(true);
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
	favoritesDropdown.classList.remove('visible');
	if (historyDropdown.classList.contains('visible')) {
		historyDropdown.classList.remove('visible');
	} else {
		vscode.postMessage({ type: 'requestHistory' });
	}
});

favoritesBtn.addEventListener('click', (e) => {
	e.stopPropagation();
	historyDropdown.classList.remove('visible');
	if (favoritesDropdown.classList.contains('visible')) {
		favoritesDropdown.classList.remove('visible');
	} else {
		vscode.postMessage({ type: 'requestFavorites' });
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

document.addEventListener('click', () => {
	historyDropdown.classList.remove('visible');
	favoritesDropdown.classList.remove('visible');
});

function loadVideo(url) {
	let normalized = url.trim();
	if (!normalized) {
		statusText.textContent = 'Invalid Input';
		return;
	}

	const isSearch = normalized.includes(' ') || (!normalized.includes('.') && !normalized.startsWith('http') && !/^[a-zA-Z0-9_-]{11}$/.test(normalized));
	
	if (isSearch) {
		statusText.textContent = 'Searching...';
	} else {
		normalized = normalizeInput(normalized);
		statusText.textContent = 'Loading...';
	}

	currentVideoId = extractVideoId(normalized);
	vscode.postMessage({ type: 'requestLoad', value: normalized });
	
	resultsContainer.style.display = 'none';
	iframe.style.display = 'block';
	emptyState.style.display = 'none';
	historyDropdown.classList.remove('visible');
	favoritesDropdown.classList.remove('visible');
	
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

	if (data && data.event === 'timeUpdate' && typeof data.time === 'number') {
		lastCurrentTime = data.time;
		
		// Inform extension host (memory only, for visibility change triggers)
		vscode.postMessage({ type: 'timeUpdate', time: lastCurrentTime });
		
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
		if (data.info.playerState === 0) { // ENDED
			requestNext();
			// Reset time on end
			vscode.postMessage({ type: 'saveTimestamp', url: lastLoadedOriginalUrl, time: 0 });
		} else if (data.info.playerState === 1) { // PLAYING
			isPaused = false;
			statusText.textContent = 'Playing';
		} else if (data.info.playerState === 2) { // PAUSED
			isPaused = true;
			statusText.textContent = 'Paused';
			// Save immediately on pause
			vscode.postMessage({ 
				type: 'saveTimestamp', 
				url: lastLoadedOriginalUrl, 
				time: Math.floor(lastCurrentTime) 
			});
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
			
			if (iframe.src.startsWith(proxyUrlPrefix)) {
				const loadData = { type: 'load', id: nextId, startTime: startTime, autoplay: startAutoplay };
				if (isIframeReady) {
					iframe.contentWindow.postMessage(loadData, '*');
				} else {
					pendingIframeLoad = loadData;
				}
			} else {
				isIframeReady = false;
				pendingIframeLoad = null;
				iframe.src = message.value;
			}
			
			input.value = message.originalUrl || message.value;
			clearBtn.style.display = input.value ? 'block' : 'none';
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
			isPaused = !startAutoplay;
			statusText.textContent = isPaused ? 'Paused' : 'Playing';
			
			updateFavoriteButton();
			break;
		case 'searchResults':
			showSearchResults(message.results);
			break;
		case 'history':
			showHistory(message.value);
			break;
		case 'favorites':
			favorites = message.value;
			showFavorites(favorites);
			updateFavoriteButton();
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

function showSearchResults(results) {
	resultsContainer.innerHTML = '';
	if (results.length === 0) {
		resultsContainer.innerHTML = '<div style="color:#777; text-align:center; padding-top:40px;">No results found</div>';
	} else {
		results.forEach(res => {
			const div = document.createElement('div');
			div.className = 'search-result';
			div.innerHTML = `
				<div class="result-thumb" style="background-image: url('${res.thumbnail}')"></div>
				<div class="result-info">
					<div class="result-title">${res.title}</div>
				</div>
			`;
			div.addEventListener('click', () => {
				loadVideo(`https://www.youtube.com/watch?v=${res.id}`);
			});
			resultsContainer.appendChild(div);
		});
	}
	resultsContainer.style.display = 'flex';
	iframe.style.display = 'none';
	emptyState.style.display = 'none';
	statusText.textContent = 'Search results';
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
			
			const text = document.createElement('div');
			text.className = 'item-text';
			text.textContent = entry.title || entry.url;
			text.title = entry.url;
			text.addEventListener('click', () => {
				loadVideo(entry.url);
			});
			
			item.appendChild(text);
			historyDropdown.appendChild(item);
		});
	}
	historyDropdown.classList.add('visible');
}

function showFavorites(urls) {
	favoritesDropdown.innerHTML = '';
	if (urls.length === 0) {
		const item = document.createElement('div');
		item.className = 'favorite-item';
		item.textContent = 'No favorites yet';
		favoritesDropdown.appendChild(item);
	} else {
		urls.forEach(entry => {
			const item = document.createElement('div');
			item.className = 'favorite-item';
			
			const text = document.createElement('div');
			text.className = 'item-text';
			text.textContent = entry.title || entry.url;
			text.title = entry.url;
			text.addEventListener('click', () => {
				loadVideo(entry.url);
			});

			const remove = document.createElement('button');
			remove.className = 'remove-btn';
			remove.textContent = 'Remove';
			remove.addEventListener('click', (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'removeFavorite', url: entry.url });
			});
			
			item.appendChild(text);
			item.appendChild(remove);
			favoritesDropdown.appendChild(item);
		});
	}
	favoritesDropdown.classList.add('visible');
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
    favCurrentBtn.style.display = 'block';
    if (isFavorited(lastLoadedOriginalUrl)) {
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
