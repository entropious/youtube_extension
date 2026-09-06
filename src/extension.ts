import * as vscode from 'vscode';
import * as http from 'http';
import { YouTubeViewProvider } from './provider';
import { checkTools, handleInfo, handleMedia, handlePlayerPage, handlePlaylist, handleTools, setServerPort, setToolConfig, shutdownStreams, streamReport, takeOverStream } from './ytproxy';

let proxyServer: http.Server | null = null;
let proxyPort = 0;

/** Picks up the yt-dlp and ffmpeg settings the media server runs with. */
function applyToolConfig(): void {
	const config = vscode.workspace.getConfiguration('youtube-panel');
	setToolConfig({
		ytDlpPath: config.get<string>('ytDlpPath') || 'yt-dlp',
		ffmpegPath: config.get<string>('ffmpegPath') || 'ffmpeg',
		maxHeight: config.get<number>('maxHeight') || 1080
	});
}

async function startProxyServer(): Promise<void> {
	if (proxyServer && proxyPort) {
		return;
	}

	proxyServer = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');

		// Read by the probe harness, not by any page: what is streaming and what
		// is cached, so a handover that did not happen can be explained.
		if (url.pathname === '/streams') {
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify(streamReport()));
			return;
		}

		if (url.pathname === '/tools') {
			void handleTools(res, url.searchParams.get('refresh') === '1');
			return;
		}

		// Read by ffmpeg, not by the page: a playlist that starts where playback
		// does, so a seek fetches nothing before it.
		if (url.pathname === '/playlist') {
			void handlePlaylist(
				res,
				url.searchParams.get('v') ?? '',
				parseInt(url.searchParams.get('i') ?? '0', 10),
				parseInt(url.searchParams.get('from') ?? '0', 10)
			);
			return;
		}

		if (url.pathname !== '/embed' && url.pathname !== '/info' && url.pathname !== '/media') {
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

		if (url.pathname === '/info') {
			void handleInfo(res, videoId);
			return;
		}

		if (url.pathname === '/media') {
			// A video moved between the panel and a tab asks for the stream the
			// other view was watching, which carries on where it stood. Should it
			// be gone by now, the video id and offset beside it start a new one.
			// Refused rather than started afresh: the page has already set its clock
			// by where that stream stood, and only it knows what to ask for instead.
			const take = url.searchParams.get('take');
			if (take) {
				if (!takeOverStream(res, take)) { res.writeHead(409); res.end('Stream is gone'); }
				return;
			}

			void handleMedia(res, videoId, parseInt(url.searchParams.get('t') ?? '0', 10));
			return;
		}

		const take = url.searchParams.get('take');
		handlePlayerPage(res, videoId, startTime, autoplay, take
			? { id: take, startAt: parseInt(url.searchParams.get('takeAt') ?? '0', 10) }
			: null);
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
			// ffmpeg reads its playlists back from this server.
			setServerPort(proxyPort);
			resolve();
		});
	});
}

export async function deactivate() {
	if (provider) {
		await provider.saveCurrentState();
	}

	// ffmpeg outlives the extension unless it is ended here, and a stray one
	// keeps its memory and its share of the battery.
	shutdownStreams();

	if (proxyServer) {
		proxyServer.close();
		proxyServer = null;
		proxyPort = 0;
	}
}

let provider: YouTubeViewProvider | null = null;

class YouTubeUriHandler implements vscode.UriHandler {
	constructor(private getProvider: () => YouTubeViewProvider | null) {}

	async handleUri(uri: vscode.Uri) {
		try {
			if (uri.path === '/load' || uri.path === 'load') {
				const query = new URLSearchParams(uri.query);
				const url = query.get('url');
				if (!url) {
					vscode.window.showErrorMessage('YouTube Panel: Missing "url" parameter in URI');
					return;
				}

				const startTime = parseInt(query.get('startTime') || query.get('t') || '0', 10);
				
				// Reveal the sidebar view
				await vscode.commands.executeCommand('youtube-panel.view.focus');
				
				const provider = this.getProvider();
				if (provider) {
					const resolvedUrl = await provider.resolveUrl(url);
					provider.loadUrl(resolvedUrl, startTime);
				} else {
					throw new Error('YouTubeViewProvider not initialized');
				}
			} else {
				vscode.window.showErrorMessage(`YouTube Panel: Unknown URI path "${uri.path}"`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`YouTube Panel URI Error: ${message}`);
		}
	}
}

export async function activate(context: vscode.ExtensionContext) {
	applyToolConfig();
	await startProxyServer();

	provider = new YouTubeViewProvider(context.extensionUri, context.globalState, () => proxyPort);

	context.subscriptions.push(
		// Keeps the player alive while the view is hidden — moving it to another
		// place in the workbench, or switching to a neighbouring view, would
		// otherwise reload the page and start the video over.
		vscode.window.registerWebviewViewProvider(YouTubeViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('youtube-panel')) applyToolConfig();
		})
	);

	// Probed at startup so the panel has the answer before its first video; the
	// panel itself blocks on the result.
	void checkTools();

	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer('youtube-player', {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: unknown) {
				if (provider) {
					const s = state as Record<string, any>;
					const url = s?.currentOriginalUrl || '';
					const time = s?.currentTime || 0;
					provider._setupTabPanel(webviewPanel, url, webviewPanel.title, time);
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.loadUrl', async () => {
			const url = await vscode.window.showInputBox({
				prompt: "Enter YouTube Video URL or Search query",
				placeHolder: "https://www.youtube.com/watch?v=... or 'lofi hip hop'"
			});
			if (url && provider) {
				const resolvedUrl = await provider.resolveUrl(url);
				provider.loadUrl(resolvedUrl, undefined, undefined, true);
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
		vscode.commands.registerCommand('youtube-panel.prevVideo', () => {
			provider?.prevVideo();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.openInPanel', (url: string, title?: string, startTime?: number) => {
			provider?.openInPanel(url, title, startTime);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.clearAll', async () => {
			if (provider) {
				await provider.clearAll();
			} else {
				await context.globalState.update(YouTubeViewProvider.historyKey, []);
				await context.globalState.update(YouTubeViewProvider.favoritesKey, []);
				await context.globalState.update(YouTubeViewProvider.timestampsKey, {});
			}
			vscode.window.showInformationMessage('YouTube Panel: All state cleared.');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('youtube-panel.toggleClaudeSync', () => {
			provider?.toggleClaudeSync();
		})
	);

	context.subscriptions.push(
		vscode.window.registerUriHandler(new YouTubeUriHandler(() => provider))
	);

	// The watcher on Claude's state file outlives the panel otherwise.
	context.subscriptions.push({ dispose: () => provider?.dispose() });
}
