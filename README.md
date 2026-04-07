# YouTube Player for VS Code 📺

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/entro.youtube-panel.svg)](https://marketplace.visualstudio.com/items?itemName=entro.youtube-panel)

![YouTube Player Screenshot](media/description.png)

Experience YouTube like never before, right from your editor! Watch tutorials, listen to music, or follow live streams without ever breaking your focus. 🚀

## ✨ Features

- 🚀 **Dual-View Support**: Watch videos in a dedicated **Sidebar Panel** or open them in a large **Editor Tab** for better visibility.
- 🔍 **Integrated Search**: Find and browse videos directly within the extension UI — no more switching windows to find the right tutorial.
- 🔗 **Smart Link Support**: Paste any YouTube link into the search bar to play it instantly.
- 🎶 **Playlists Support**: Seamlessly manage YouTube playlists with intuitive navigation controls and full state recovery across restarts.
- 🕒 **Smart Resume (Timestamps)**: Remembers your playback position for every video. Resume exactly where you left off, even after restarting VS Code.
- ⭐ **Favorites & History**: Save your go-to tutorials or lofi playlists in **Favorites**, and easily re-watch anything from your **History** (up to 50 items).
- 📑 **Video Chapters & Sections**: Support for video chapters. Jump to any part of the video using a sleek, interactive bottom panel that slides up on hover. Fully scrollable and draggable for quick navigation.
- 📺 **Channel Navigation**: Explore all videos from the current video's channel in chronological order with a single click.
- 🔄 **Continuous Play & Related Videos**: Discover and autoplay related content when a video ends — perfect for keeping the flow in your workspace.
- ⚡ **Global Media Controls**: Play, pause, or skip to the next video using global commands and customizable keyboard shortcuts (`cmd+alt+p`, `cmd+alt+o`).
- 🛠️ **Seamless Syncing**: Switch between the sidebar and editor tab; your video and playback position sync automatically.
- 🧬 **Deeplink Support**: Open videos from your browser or other apps using \`vscode://\` (e.g., \`vscode://entro.youtube-panel/load?url=URL&t=120\`).
- 🎨 **Modern Glassmorphism UI**: 
  - **Sleek Interface**: Translucent, modern design that integrates perfectly with your VS Code theme.
  - **Hover-to-Reveal Controls**: Keep your workspace clean—controls stay hidden until you need them.


## 🚀 Getting Started

1.  **Open** the **YouTube** view from the Activity Bar (Sidebar).
2.  **Search or Paste**: Enter a YouTube URL, search for a video, or just type a query like "lofi" into the search bar.
3.  **Watch Anywhere**: Use the "Open in Tab" button to move the player to a main editor column.
4.  **Save for Later**: Click the **Star** icon to add a video to your **Favorites**.
5.  **Control with Keys**: Use the shortcuts `cmd+alt+p` (Play/Pause) and `cmd+alt+o` (Next) while coding.

> [!IMPORTANT]
> **Where are the controls?**
> To stay out of your way while coding, everything (search bar, buttons) is hidden by default. **Simply hover your mouse over the top-left corner** of the player at any time to instantly reveal the controls.

## ⌨️ Commands

| Command | Description | Shortcut |
| --- | --- | --- |
| `YouTube: Load URL` | Search for videos or play a specific URL. | - |
| `YouTube: Play/Pause` | Toggle playback of the active player. | `cmd+alt+p` |
| `YouTube: Next Video` | Skip to the next related video. | `cmd+alt+o` |
| `YouTube: Prev Video` | Go back to the previous video in your playlist. | - |
| `YouTube: Open in Panel`| Move sidebar player to an editor tab. | - |

## 🛠️ Configuration

The extension uses VS Code's global state to securely store your history and settings locally.

## 📝 License

This project is licensed under the [MIT License](LICENSE).
