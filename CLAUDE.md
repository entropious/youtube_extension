# YouTube Panel

A VS Code extension that plays YouTube inside the editor — a sidebar view and an
editor tab — with no YouTube player and no API key. Video is resolved by
`yt-dlp`, remuxed by `ffmpeg` and served to a plain `<video>` from a local HTTP
server; everything around it (search, playlists, channels, chapters, history) is
scraped from YouTube's own pages. README.md lists the features for users; this
file is what to know before changing the code.

## Layout

| file | lines | what lives there |
| --- | --- | --- |
| `src/extension.ts` | ~260 | activation, HTTP server and routes, commands, settings, `vscode://` handler, tab serializer |
| `src/provider.ts` | ~1400 | both views, all state, all YouTube scraping, Claude sync |
| `src/ytproxy.ts` | ~1700 | tool probing, stream resolution, ffmpeg, HLS trimming, warm-ups, handover, **the player page** |
| `src/webview/script.js` | ~1420 | the panel UI: search, lists, chapters, playback intent |
| `src/webview/index.html`, `style.css` | | markup and the glass UI, `%%PLACEHOLDER%%` slots |
| `src/claudeHooks.ts` | ~130 | Claude Code hooks and the state file |
| `src/utils.ts` | ~120 | URL parsing, history entry parsing |

Three JS worlds, and the boundary matters:

```
extension host (TS)          panel webview (script.js)      player page (ES5)
provider.ts  ──postMessage──▶  script.js  ──postMessage──▶  <iframe> /embed
             ◀──────────────              ◀──────────────
                                  vscode.postMessage           window.parent
```

The panel never touches video: it sends `load` and `command` into the player
frame and hears `playerReady`, `timeUpdate`, `infoDelivery` back — the subset of
the YouTube IFrame API the UI was written against, so the UI does not know the
player was replaced. The extension host talks only to the panel.

## The HTTP server (`extension.ts`)

Bound to 127.0.0.1 on a random port, which is stamped into the webview HTML and
into ffmpeg's playlist URLs. Routes, all one call into `ytproxy`:

| route | who calls it | what it does |
| --- | --- | --- |
| `/embed?v&start&autoplay&take&takeAt` | the panel's iframe | the player page |
| `/info?v` | the player | duration and title; JSON error plus a `fix` command |
| `/media?v&t` or `?take=<id>` | `<video src>` | fragmented MP4 from ffmpeg, or a handed-over stream (409 if gone) |
| `/playlist?v&i&from` | **ffmpeg** | an HLS playlist cut at the seek point |
| `/tools?refresh` | the panel's setup gate | is yt-dlp/ffmpeg installed, with install recipes |
| `/streams` | `.probe` only | what is streaming and cached |

Commands: `loadUrl`, `togglePlay`, `nextVideo`, `prevVideo`, `openInPanel`,
`clearAll`, `toggleClaudeSync`. Keys `cmd+alt+p/o/i` are bound only while the
view is visible. `vscode://entro.youtube-panel/load?url=…&t=…` focuses the view
and loads. A `WebviewPanelSerializer` restores the tab across restarts from the
webview's own state.

## Playback (`ytproxy.ts`)

**Resolution.** `yt-dlp -J` with a format selector that prefers a combined HLS
rendition, then an HLS video+audio pair, then progressive. Cached an hour;
refusals cached 15 seconds. HLS matters because only yt-dlp's `web_safari`
client offers it — every other client gives progressive `https` (usually itag
18, 360p) or wants a GVS PO Token — and `web_safari` is exactly the client
YouTube challenges, which is where bot checks come from. Direct googlevideo URLs
answer 403 to ffmpeg's open byte range and accept only small closed ranges, so
progressive sits last as a fallback ffmpeg can barely use.

**Serving.** ffmpeg copies H.264 through, re-encodes audio to MP3, wraps it in
fragmented MP4 (`frag_keyframe+empty_moov+default_base_moof`) and writes to the
response. Seeking does not use `-ss` on YouTube's playlist — that fetches the
opening segments and throws them away — so playlists are fetched here, cut at
the segment covering the seek, and served from `/playlist` with only the
remainder inside that segment left for `-ss`.

**Warm-ups.** `prewarmStream` starts resolution *and* ffmpeg while the player
page is still loading, buffering up to 12 MB for 60 seconds; the request that
follows takes it over instead of starting a second one. `prefetchStream`
resolves the next playlist video without fetching anything.

**One stream, and it outlives its reader.** Only ffmpeg processes are registered
(`runTool(..., track)`) — a yt-dlp caught in that net was being killed by the
next video's ffmpeg, and the page saw a tool that had simply died. Losing the
response does not end a stream: pausing a video is enough for a browser to drop
the connection, so the stream is held 15 seconds with its pipe paused. That is
also what makes moving a video cheap — see below. `shutdownStreams` on
deactivate; timers are `unref`'d (one 60 s timer once kept `npm test` alive a
minute past the last test).

**Handover.** `handoffStream(videoId)` offers the running stream and holds it;
`takeOverStream(id, res)` ends the old response, replays the fMP4 header kept
from the first bytes and points the pipe at the new one. The arriving player
seeks to the first buffered second, because fragments keep the timestamps of
their stream — and if the stream has run ahead of the viewer (paused video,
stream fetching on), it is let go and that view fetches the second it wants. A
missing stream answers 409 and the player starts its own, silently.

**The player page** is a template literal near the bottom of `ytproxy.ts`: ES5,
**no backticks inside it**. It owns its control bar, spinner, unmute offer,
chapter pointer zone, and its own recovery — a broken stream is retried three
times from where playback stood before anything is shown, and the only failure
worth a message is one the viewer can act on: a bot check comes with the exact
command that updates yt-dlp, chosen from where the binary was found (brew, pipx,
pip, scoop, choco, winget, or `-U`), with a copy button.

## The panel (`provider.ts` + `script.js`)

**Two views, one video.** `_isTabActive` decides who is "current"; the sidebar
keeps its context when hidden (`retainContextWhenHidden`), so returning to it
resumes rather than reloads. Hiding the sidebar pauses and pushes the video to
the tab; closing the tab pushes it back. `_sidebarUrl`/`_tabUrl` record what each
view was last told, so a return with the same video does not reload it.

**Playback intent** lives in `script.js`: `pausedByHand` outranks every automatic
pause, and automatic pauses are a *set of reasons* (`hidden`, `claude`) — playback
resumes only when the set empties and the viewer has not stopped it by hand.

**Scraping** (all in `provider.ts`, all from `ytInitialData` in fetched pages,
with regex fallbacks when the JSON moves):

- *search* — `/results`, videos plus up to five channels, paged through
  `youtubei/v1/search` with the `INNERTUBE_API_KEY` scraped from the page;
- *playlists* — `/playlist`, followed through up to ten continuations, titles
  and a thumbnail kept;
- *channel videos* — `/@channel/videos`, avatar included;
- *related* — video ids off the watch page, one of the first five at random;
- *details* — title, channel, avatar and chapters (manual chapters preferred
  over auto-generated, `engagementPanels` as fallback), cached 30 minutes:
  every load asked for them, including a video merely moved to a tab.

**State** in `globalState`: history (50, deduped, titles filled in as they
resolve), favorites (videos, playlists, channels, with thumbnails), timestamps
(per video id, `{time, lastUsed}`, LRU-capped at 500), autoplay, the current
playlist and its titles, the Claude switch. `_timestampCache` answers in memory;
the webview also keeps `vscode.getState()` so a rebuilt view knows where it was.

**UI details worth knowing.** A setup gate covers everything until `/tools` says
both binaries exist, showing install commands for the actual platform with copy
buttons. The chapter strip slides up when the *player* reports the pointer near
the bottom edge — the panel cannot see pointer events inside the frame — and
sits above the player's control bar, whose height the player reports. Lists
(history, favorites, playlist, channel, search) share one renderer and one
container; stars are re-synced after every favorites update.

## Claude sync (`claudeHooks.ts`)

Claude Code cannot be asked what it is doing, but it can run a command on its
own events, so the extension writes hooks into `~/.claude/settings.json` that
put `busy`/`idle` into `~/.claude/youtube-panel/state`. The **directory** is
watched, not the file: the hook replaces it by rename and a watch on the old
inode goes deaf. Every window watches the same file, so only a window with a
visible view starts playback, while pausing is unconditional — the hidden window
may be the one making noise. Turning the switch off uninstalls the hooks.

## Checking it

`bash .probe/devhost.sh` drives a real Extension Development Host over CDP —
use it rather than building a browser harness.

```
start | restart | stop        window on the debug profile
load <videoId> | ready        open a video, wait for the stream
state | players | streams     one player, both players, the server's own view
play | pause | seek <s> | click | tap | space
totab                         move the video to an editor tab
panel <expr> | webview | messages
chapters | setup | claude | errorfix | recover
timing | seektiming | procs | battery
smoke <videoId> | verify | package | install-check
```

`npm test` runs ~255 mocha tests through ts-node (`test/bootstrap.ts` stubs the
`vscode` module); `npm run lint` warns and does not fail. Tests with clocks use
sinon fake timers — start them *after* the fixture, or the fixture's own awaits
never resolve.

## Releasing

Bump `package.json`, add a `CHANGELOG.md` entry, commit as `Release x.y.z: <what
changed>`, tag `vx.y.z`, push both, `gh release create` with the `.vsix`
attached. The Marketplace is **not** published to unless asked — `vsce publish`
is a separate, deliberate step.

## Style

Comments describe the code as it stands: never what it replaced, never the task
that produced it. Commit messages say what was wrong and why the fix is what it
is, in plain prose.
