const vscode = acquireVsCodeApi();

const initialUrl = %%INITIAL_URL_JSON%%;
const initialOriginalUrl = %%INITIAL_ORIGINAL_URL_JSON%%;
const input = document.getElementById('url-input');
const clearBtn = document.getElementById('clear-btn');
const loadBtn = document.getElementById('load-btn');
const nextBtn = document.getElementById('next-btn');
const openBtn = document.getElementById('open-btn');
const historyBtn = document.getElementById('history-btn');
const historyDropdown = document.getElementById('history-dropdown');
const iframe = document.getElementById('video-frame');
const emptyState = document.getElementById('empty-state');
const resultsContainer = document.getElementById('results-container');
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

let lastCurrentTime = 0;

window.addEventListener('message', event => {
	const message = event.data;
	
	// Handle YouTube IFrame API messages
	let data = message;
	if (typeof data === 'string') {
		try { data = JSON.parse(data); } catch(e) { return; }
	}

	if (data && data.event === 'timeUpdate' && typeof data.time === 'number') {
		lastCurrentTime = data.time;
		vscode.postMessage({ type: 'timeUpdate', time: lastCurrentTime });
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
			const startTime = message.startTime || 0;
			const startAutoplay = message.autoplay !== false;
			const proxyUrlPrefix = message.value.split('/embed')[0] + '/embed';
			
			if (iframe.src.startsWith(proxyUrlPrefix)) {
				iframe.contentWindow.postMessage({ type: 'load', id: nextId, startTime: startTime, autoplay: startAutoplay }, '*');
			} else {
				iframe.src = message.value;
			}
			
			input.value = message.originalUrl || message.value;
			clearBtn.style.display = input.value ? 'block' : 'none';
			currentVideoId = nextId;
			lastLoadedUrl = message.value;
			
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
			break;
		case 'searchResults':
			showSearchResults(message.results);
			break;
		case 'history':
			showHistory(message.value);
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
