import * as vscode from 'vscode';
import * as http from 'http';
import { YouTubeViewProvider } from './provider';

let proxyServer: http.Server | null = null;
let proxyPort = 0;

// кнопка очистки истории
// при клике на урлбар выделять весть урл

function getProxyEmbedHtml(videoId: string, startTime = 0, autoplay = true): string {
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
        let ready = false;

        function proxyLog(level, msg, ...args) {
            if (level !== 'error') return; // ONLY ERRORS
            console[level](msg, ...args);
            window.parent.postMessage({ type: 'proxyLog', level, message: msg, args }, '*');
        }

        
        window.onYouTubeIframeAPIReady = function() {
            let initialV = v;
            try {
                p = new YT.Player('p', {
                    height: '100%', width: '100%', videoId: v,
                    playerVars: { autoplay: a, rel: 0, modestbranding: 1, playsinline: 1, enablejsapi: 1, start: s },
                    events: {
                        onReady: e => { 
                            ready = true;
                            window.parent.postMessage({type:'playerReady', videoId: v}, '*');
                            
                            if (v !== initialV) {
                                if (a) e.target.loadVideoById({ videoId: v, startSeconds: s });
                                else e.target.cueVideoById({ videoId: v, startSeconds: s });
                            } else if (v && a) {
                                e.target.playVideo(); 
                            }
                            
                            // Report time and ACTUAL video ID every second
                            setInterval(() => {
                                if (p && p.getCurrentTime && p.getVideoData) {
                                    const time = p.getCurrentTime();
                                    const actualId = p.getVideoData().video_id;
                                    window.parent.postMessage({event:'timeUpdate', time: Math.floor(time), videoId: v, actualVideoId: actualId}, '*');
                                }
                            }, 1000);
                        },

                        onStateChange: e => { 
                            window.parent.postMessage({event:'infoDelivery',info:{playerState:e.data}, videoId: v}, '*'); 
                        },


                        onError: e => {
                            proxyLog('error', '[YOUTUBE_EXT][PROXY] Player Error:', e.data);
                        }
                    }
                });
            } catch (err) {
                proxyLog('error', '[YOUTUBE_EXT][PROXY] Error initializing YT.Player:', err);
            }
        };

        if (window.YT && window.YT.Player) {
            window.onYouTubeIframeAPIReady();
        }

        window.addEventListener('message', e => {
            let data = e.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch(err) { return; }
            }
            if (data.type === 'load') {
                const nextId = data.id;
                const nextStartTime = data.startTime || 0;
                const nextAutoplay = data.autoplay !== false;
                
                v = nextId;
                s = nextStartTime;
                a = nextAutoplay;

                if (p && p.loadVideoById) {
                    try {
                        if (a) {
                            p.loadVideoById({ videoId: v, startSeconds: s });
                            p.playVideo();
                        } else {
                            p.cueVideoById({ videoId: v, startSeconds: s });
                        }
                    } catch (err) {
                        proxyLog('error', '[YOUTUBE_EXT][PROXY] Error during loadVideoById:', err);
                    }
                }
            } else if (data.event === 'command' && p && p[data.func]) {
                if (ready) p[data.func]();
            }
        });




    </script>
    <script src="https://www.youtube.com/iframe_api"></script>
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

let provider: YouTubeViewProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
	await startProxyServer();
 
	provider = new YouTubeViewProvider(context.extensionUri, context.globalState, () => proxyPort);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(YouTubeViewProvider.viewType, provider)
	);

	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer('youtube-player', {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: unknown) {
				if (provider) {
					const s = state as any;
					provider.activePanel = webviewPanel;
					const url = s?.currentOriginalUrl || '';
					const time = s?.currentTime || 0;
					provider.openInPanel(url, webviewPanel.title, time);
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
