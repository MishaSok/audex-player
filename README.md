<div align="center">

<img src="build/icon.png" width="128" alt="Audex icon" />

# Audex

**A minimal desktop music player for your local audio library.**

Built with Electron and vanilla JS — no frameworks, no bloat, just a clean charcoal-and-amber player that scans your files, downloads new tracks, and stays out of your way.

[![Version](https://img.shields.io/badge/version-1.1.5-e8a33d)](https://github.com/MishaSok/audex-player/releases/latest)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-2b2b2b)](https://github.com/MishaSok/audex-player/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-42-47848f)](https://www.electronjs.org/)

[Download](#-download) · [Features](#-features) · [Build from source](#%EF%B8%8F-building-from-source) · [Contact](#-contact)

</div>

---

## 📸 Screenshots

<div align="center">

<!-- Hero: the main Library view with the track table populated -->
![Library](docs/screenshots/library.png)

</div>

<table>
  <tr>
    <td width="50%"><!-- Fullscreen "now playing" view (desktop layout) -->
      <img src="docs/screenshots/now-playing.png" alt="Now playing" /></td>
    <td width="50%"><!-- Mobile / portrait "mobile player" mode -->
      <img src="docs/screenshots/mobile.png" alt="Mobile mode" /></td>
  </tr>
  <tr>
    <td colspan="2"><!-- Downloads tab with a YouTube search or Yandex parse in progress -->
      <img src="docs/screenshots/downloads.png" alt="Downloads" /></td>
  </tr>
</table>

---

## ✨ Features

### 🎵 Library & playback

- **Local library scanning** — recursive import of `.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`, `.aac` files.
- **Tag & cover art reading** via `music-metadata`; **MP3 tag editing** (title, artist, album, year, genre, track/disc number, comment, cover) written back with `node-id3`.
- **Playlists, Favorites, Recents** — organize your music however you like.
- **Artists view** — automatically grouped from your library.
- **Search & command palette** (`Ctrl/⌘ + K`) — jump to any track or view instantly.
- **Filters & sorting** — sort the library by title, artist, album, and more.
- **Playback controls** — shuffle, repeat (off / all / one), seek, volume.
- **Fullscreen "now playing"** view with cover art, full transport controls, volume slider, and an upcoming-queue panel.
- **Real-waveform progress bar** — the seek bar renders the track's actual audio peaks, in both the bottom playbar and the fullscreen player.
- **Resume on launch** — the last track is restored when you reopen the app.
- **Library health-check** *(optional)* — a **Health** tab that scans your collection for quality problems such as suspected transcodes, alongside a per-track **quality badge** column showing real bitrate/sample-rate. Off by default; enable it in **Settings → Music** (it hides the badge column and tab completely when off).

### 📊 Listening Report

- A dedicated **Report** tab that turns your listening history into stats — **computed entirely on your device**, nothing leaves your machine.
- *(Optional)* Off by default — enable it in **Settings → Music**. Listening statistics are always recorded regardless, so your history is already there the moment you turn the tab on.
- Switch between **Day / Month / Year / All-time** periods, each with **listening time** and a comparison against the previous period.
- At-a-glance stats: **tracks played**, **artists**, **additions to your collection**, and your current **listening streak**.
- A **"when you listen"** clock visualizing your activity across the 24 hours of the day.
- **Top Artists** and **Top Tracks** cards with play counts and album art.

### ⬇️ Download from the internet

- **YouTube** — search and download tracks by query straight from the app (`yt-dlp`), with automatic import into your library, embedded cover art and metadata. **ffmpeg is bundled**, so audio extraction and cover embedding work out of the box on every platform.
- **YouTube Music** — paste an **album, single, or artist** link and parse its full track list (`yt-dlp`, no browser or login needed). Download any track individually or queue the whole release at once; cover art and tags are embedded automatically.
- **Yandex Music** — parse playlists and albums via a bundled headless Chromium. Your login session persists between runs; the browser window can be shown for sign-in / captcha or hidden for silent background parsing.
- **Download queue** with live progress, pause and resume. Queue state survives restarts.
- **Configurable download folder** — choose where new tracks land, or fall back to a dedicated `Audex Downloads` folder.

### 📱 Mobile listening mode

- A dedicated **portrait "mobile player"** layout for the fullscreen view.
- Fully **adaptive** — cover, titles and spacing scale smoothly from a phone-sized window up to a full screen.
- **Fullscreen-aware** — if the OS window is already fullscreen, mobile mode reflows in place instead of shrinking the window.

### 🎨 Interface

- **Five UI languages** — Russian, English, German, French, Ukrainian.
- **Themes** — dark / light / system, plus **6 hand-tuned designer color themes**, all selectable from a theme picker in Settings.
- **Customizable accent color** — choose any accent from a set of presets or a custom color picker; it recolors now-playing highlights, progress bars and primary controls across the app.
- **UI scale** setting — make the whole interface larger or smaller, applied instantly.
- **Responsive layout** — adapts gracefully to narrow desktop windows.
- Polished **animations** for now-playing transitions and UI controls (respecting `prefers-reduced-motion`).

### 🖥️ System integration

- **System tray** — controls playback (play / pause, previous / next) right from the tray menu, and closing the window keeps the app running in the background so music never stops.
- **MPRIS / Media Session** — now-playing metadata and transport controls appear in the GNOME top bar (and other OS media widgets).
- **Discord Rich Presence** — show what you're listening to on your Discord profile, with track, artist and **album cover** (resolved via the iTunes Search API, so even tracks without embedded art get a picture), an optional elapsed/remaining **timer**, and up to two custom **buttons**. Cover, timer and buttons are each toggleable in **Settings → Discord**.
- **Update notifications** — on launch the app checks GitHub for a newer release and shows a dismissible in-app banner when one is available, with a one-click link to the download page.
- **Mini-player navigation** — click the cover to open fullscreen, click the title/artist to jump to the library or artist page.

---

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd> | Open / close the search command palette |
| <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>E</kbd> | Edit tags of the current track |
| <kbd>Space</kbd> | Play / pause |
| <kbd>Esc</kbd> | Close the fullscreen view or any open dialog |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Move between results in the command palette |
| <kbd>Enter</kbd> | Run the highlighted command-palette result |

---

## 📦 Download

Grab the latest build for your platform from the [**Releases page**](https://github.com/MishaSok/audex-player/releases/latest):

| Platform | File |
| --- | --- |
| **Linux** | `Audex-1.1.5.AppImage` (portable) or `audex-player_1.1.5_amd64.deb` |
| **macOS** (Apple Silicon) | `Audex-1.1.5-arm64.dmg` |
| **Windows** | `Audex.Setup.1.1.5.exe` |

> **Note:** builds are unsigned.
> - **macOS** — right-click the app → **Open**, or run `xattr -d com.apple.quarantine /Applications/Audex.app`.
> - **Windows** — SmartScreen may warn; click **More info → Run anyway**.

### Runtime dependencies

None — the release builds bundle everything they need:

- The YouTube / YouTube Music downloader and parser ship a standalone [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) binary, so no `pip install` is required.
- The Yandex Music parser uses a Chromium build bundled with the app.
- `ffmpeg` ships with the app (via `ffmpeg-static`), so YouTube audio extraction works without a system install.

If a bundled `yt-dlp` is somehow missing, the app falls back to a system-installed one (`pip install -U yt-dlp`).

---

## 🛠️ Building from source

```bash
git clone https://github.com/MishaSok/audex-player.git
cd audex-player
npm install
npm start
```

`npm start` runs `electron . --no-sandbox` (the flag avoids sandbox permission issues on some Linux setups).

To produce distributable packages:

```bash
npm run dist
```

This builds a Linux AppImage and `.deb` into `release/`. macOS and Windows builds are produced by GitHub Actions on tag push.

---

## 🧰 Tech stack

- **[Electron 42](https://www.electronjs.org/)** — desktop shell (main + preload + renderer processes).
- **Vanilla HTML / CSS / JS** — no UI framework, no bundler.
- **[music-metadata](https://github.com/borewit/music-metadata)** — read tags and embedded artwork.
- **[node-id3](https://github.com/Zazama/node-id3)** — write ID3v2 tags back to MP3 files.
- **[Puppeteer](https://pptr.dev/)** — drives the bundled Chromium for the Yandex Music parser.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — YouTube / YouTube Music search, parsing and download backend.
- **[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)** — bundled ffmpeg binary for audio extraction and cover embedding.

---

## 📬 Contact

Made by **Mikhail Sokov**.

- 💬 **Telegram:** [@JuicexNet](https://t.me/JuicexNet) — *found a bug or have a suggestion? Message me here.*
- 🐙 **GitHub:** [MishaSok/audex-player](https://github.com/MishaSok/audex-player)
- ✉️ **Email:** mikhail.sokov2006@gmail.com

---

## 📄 License

Released under the [MIT License](LICENSE).
