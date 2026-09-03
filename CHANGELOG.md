# Changelog

## 0.4.2

- Playback starts about twice as fast. The two slow steps — yt-dlp resolving the
  video and ffmpeg fetching the first HLS segments — now run while the player
  page is still loading, instead of one after the other once it asks. What
  ffmpeg produces meanwhile is held and handed over when the page arrives. The
  next video in a playlist is resolved while the current one plays.
- Seeking is quicker and no longer stalls for eight seconds at a time. Playlists
  are kept here and handed to ffmpeg starting at the segment being seeked to, so
  a seek neither fetches the opening segments it would throw away nor waits on a
  round trip to YouTube for the playlist.
- Switching videos no longer leaves the previous stream fetching in the
  background, where it competed for the connection and made the new video take
  seconds longer to start.

## 0.4.1

### Added

- **Claude Sync**: a switch in the top right ties playback to Claude Code —
  video plays while Claude works and pauses the moment it waits for you. A
  pause set by hand outranks it: Claude never restarts a video you stopped.
  Also available as the `YouTube: Toggle Claude Sync` command.

  Claude Code exposes no way to ask what it is doing, so switching this on
  registers hooks in `~/.claude/settings.json` that write `busy` or `idle` into
  `~/.claude/youtube-panel/state`, which the panel watches. Hooks you wrote
  yourself are left alone, and switching it off removes only the ones the
  extension added.

## 0.4.0

Playback no longer goes through YouTube's embedded player. Streams are resolved
with **yt-dlp** and served by **ffmpeg** to a plain `<video>` element, which is
what makes video play in a VS Code webview at all: the shipped ffmpeg build
decodes H.264 and MP3 but neither WebM nor AAC, so the video track is copied
through untouched and only the audio is re-encoded.

### Added

- Setup screen: while yt-dlp or ffmpeg are missing, the panel shows nothing but
  the install commands for your own system — copy button, and a check that
  clears the screen once both are found.
- Player controls built into the panel: play/pause, seek, volume, fullscreen,
  and the keys `space`/`k`, `←`/`→` (5 s), `j`/`l` (10 s), `m`, `f`. Clicking
  the picture toggles playback.
- Settings: `youtube-panel.ytDlpPath`, `youtube-panel.ffmpegPath` and
  `youtube-panel.maxHeight` (360p to 1080p).

### Changed

- Format selection prefers HLS, whose segments ffmpeg can both stream and seek,
  and falls back to a progressive stream — direct googlevideo links refuse the
  open byte range ffmpeg asks for.
- Seeking restarts the stream at the requested offset, so it works on a
  fragmented stream that carries no duration of its own.
- The chapter strip now sits above the player's control bar instead of covering
  it, and opens once on entering the bottom of the frame rather than flickering
  along the way.

### Fixed

- Windows: a yt-dlp installed by pip as a `.cmd` wrapper is now found and run
  (`spawn` alone cannot start one).
- A failed lookup no longer leaves the previous video playing and reporting
  progress under the new video's id.
- The loading spinner no longer spins forever on a video that is cued paused.

## 0.3.2 and earlier

Not recorded here; see the git history.
