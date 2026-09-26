# YouTube Player for VS Code 📺

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Release](https://img.shields.io/github/v/release/entropious/youtube_extension)](https://github.com/entropious/youtube_extension/releases/latest)

![YouTube Player Screenshot](media/description.jpg)

Watch YouTube videos inside VS Code — in the bottom panel or in a full editor tab. Search YouTube, open playlists, follow tutorials, listen to music or keep a live stream running, without ever leaving the editor. 🚀

## ✨ Features

- 🚀 **Dual-View Support**: Watch videos in the **YouTube** view of the bottom panel, or open them in a large **Editor Tab** for better visibility. Like any VS Code view, it can be dragged into the sidebar or the secondary sidebar.
- 🔍 **Integrated Search**: Find and browse videos directly within the extension UI — no more switching windows to find the right tutorial.
- 🔗 **Smart Link Support**: Paste any YouTube link into the search bar to play it instantly.
- 🎶 **Playlists Support**: Seamlessly manage YouTube playlists with intuitive navigation controls and full state recovery across restarts.
- 🕒 **Smart Resume (Timestamps)**: Remembers your playback position for every video and picks up where you left off, even after restarting VS Code. Playback resumes from the start of the few-second stream segment your position falls in, a moment before where you stopped.
- ⭐ **Favorites & History**: Save your go-to tutorials or lofi playlists in **Favorites**, and easily re-watch anything from your **History** (up to 50 items).
- 📑 **Video Chapters & Sections**: Support for video chapters. Jump to any part of the video using a sleek, interactive bottom panel that slides up on hover. Fully scrollable and draggable for quick navigation.
- 📺 **Channel Navigation**: Explore the videos of the current video's channel, newest first, with a single click.
- 🔄 **Continuous Play & Related Videos**: Discover and autoplay related content when a video ends — perfect for keeping the flow in your workspace.
- ⚡ **Global Media Controls**: Play, pause, or skip to the next video using global commands and customizable keyboard shortcuts (`cmd+alt+p`, `cmd+alt+o`).
- 🤖 **Claude Sync**: Flip the switch in the top right and playback follows Claude Code — video plays while Claude works and pauses the moment it needs you. A pause you set by hand always wins; Claude never restarts a video you stopped.
- 🛠️ **Seamless Syncing**: Switch between the panel and editor tab; your video and playback position sync automatically.
- 🧬 **Deeplink Support**: Open videos from your browser or other apps using \`vscode://\` (e.g., \`vscode://entro.youtube-panel/load?url=URL&t=120\`).
- 🎨 **Modern Glassmorphism UI**: 
  - **Sleek Interface**: Translucent, modern design that integrates perfectly with your VS Code theme.
  - **Hover-to-Reveal Controls**: Keep your workspace clean—controls stay hidden until you need them.


## 📦 Requirements

Playback goes through [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org), so both have to be installed and reachable:

| | |
| --- | --- |
| macOS | `brew install yt-dlp ffmpeg` |
| Windows | `winget install yt-dlp.yt-dlp Gyan.FFmpeg` |
| Debian, Ubuntu | `sudo apt install yt-dlp ffmpeg` |
| Arch | `sudo pacman -S yt-dlp ffmpeg` |

Until both are found, the panel shows nothing but these commands for your own system, ready to copy, with a button to check again. If the tools live somewhere unusual, point `youtube-panel.ytDlpPath` and `youtube-panel.ffmpegPath` at them instead.

YouTube tightens its bot checks from time to time and can refuse a video to an anonymous session. The player then shows the command that updates yt-dlp the way it was installed, with a copy button. A newer yt-dlp often gets past the check, though not every time — YouTube also lifts and reimposes it on its own.

## 🚀 Getting Started

1.  **Open** the **YouTube** tab in the bottom panel (or run **View: Open View…** and pick **YouTube Video**).
2.  **Search or Paste**: Enter a YouTube URL, search for a video, or just type a query like "lofi" into the search bar.
3.  **Watch Anywhere**: Use the **Open in VS Code Tab** button to move the player to a main editor column.
4.  **Save for Later**: Click the **Star** icon to add a video to your **Favorites**.
5.  **Control with Keys**: Use the shortcuts `cmd+alt+p` (Play/Pause), `cmd+alt+o` (Next) and `cmd+alt+i` (Previous) while coding.

> [!IMPORTANT]
> **Where are the controls?**
> To stay out of your way while coding, everything (search bar, buttons) is hidden by default. **Simply hover your mouse over the top edge** of the view at any time to reveal the controls; the Claude Sync switch sits in the top-right corner. The player's own bar — play, seek, volume, fullscreen — appears when you move the pointer over the picture.

### In the player

| Key | Action |
| --- | --- |
| `space`, `k` | Play / pause |
| `←`, `→` | Back / forward 5 s |
| `j`, `l` | Back / forward 10 s |
| `m` | Mute |
| `f` | Fullscreen |

Clicking the picture toggles playback too. A seek lands on the start of the nearest stream segment in the direction you moved — every few seconds, depending on the video — since that is where a stream can begin with sound and picture in step.

## ⌨️ Commands

| Command | Description | Shortcut |
| --- | --- | --- |
| `YouTube: Load URL` | Search for videos or play a specific URL. | - |
| `YouTube: Play/Pause` | Toggle playback of the active player. | `cmd+alt+p` |
| `YouTube: Next Video` | Skip to the next video in the playlist, or a related one. | `cmd+alt+o` |
| `YouTube: Prev Video` | Go back to the previous video in your playlist. | `cmd+alt+i` |
| `YouTube: Toggle Claude Sync` | Follow Claude Code: play while it works, pause when it waits. | - |
| `YouTube Panel: Clear All` | Forget history, favorites, saved positions and the current playlist. | - |

Shortcuts use `ctrl+alt` instead of `cmd+alt` on Windows and Linux, and work while the YouTube view is visible.

## 🛠️ Configuration

History, favorites and playback positions are kept in VS Code's own storage on this machine; nothing is sent anywhere but YouTube.

| Setting | Description | Default |
| --- | --- | --- |
| `youtube-panel.ytDlpPath` | Path to the yt-dlp executable. | `yt-dlp` |
| `youtube-panel.ffmpegPath` | Path to the ffmpeg executable. | `ffmpeg` |
| `youtube-panel.maxHeight` | Maximum video height, in pixels. | `1080` |

## 📝 License

This project is licensed under the [MIT License](LICENSE).
