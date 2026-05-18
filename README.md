# Audex

A minimal desktop music player for local audio libraries. Built with Electron, vanilla JS, and a charcoal-and-amber Mono theme.

## Features

- Local library scanning for `.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`, `.aac` (recursive directory import)
- ID3 / cover-art reading via `music-metadata`; tag editing for MP3 via `node-id3`
- Playlists, Favorites, Recents, filters and sort, command palette (search)
- Fullscreen "now playing" view with rotating vinyl and dynamic playback-bar color
- Shuffle, Repeat (off / all / one), volume, seek
- Dark / light / system theme, optional auto-rescan of a default folder on startup

## Tech stack

- **Electron 42** — desktop shell (main + preload + renderer)
- **Vanilla HTML / CSS / JS** — no UI frameworks
- **music-metadata** — read tags and embedded artwork
- **node-id3** — write ID3v2 tags back to MP3 files

## Getting started

```bash
npm install
npm start
```

`npm start` runs `electron . --no-sandbox` (the flag avoids sandbox permission issues on some Linux setups).

## Project layout

| File | Role |
| --- | --- |
| `main.js` | Electron main process: window, file dialogs, recursive directory scan, IPC handlers for metadata read/write and reveal-in-folder |
| `preload.js` | `contextBridge` exposing the IPC API as `window.electronAPI` |
| `renderer.js` | All UI logic: state, rendering, playback, playlists, favorites, settings, command palette |
| `index.html` | Markup and inline SVG icon symbols |
| `style.css` | Mono theme (charcoal + amber accent), grain overlay, animations |

## Data & persistence

Library metadata, favorites, playlists, settings and recents are persisted in `localStorage`. Cover art is *not* stored in `localStorage` (size limits) — it is re-extracted from files on startup via `restoreCovers()` in `renderer.js`. Library and favorites keys still use the legacy `ambevor-*` prefix for backwards compatibility with existing users; new keys use `audex-*`.

## IPC surface

Exposed on `window.electronAPI` (see `preload.js`):

- `openFiles()` — open files-or-folder dialog, returns flat list of audio paths
- `chooseFolder()` — pick a single directory
- `scanFolder(path)` — recursive scan for audio files
- `parseMetadata(path)` — returns `{ title, artist, album, …, cover, duration, path }`
- `writeMetadata(path, tags)` — MP3 only; writes ID3v2 tags
- `revealInFolder(path)` — open the OS file manager at the file
