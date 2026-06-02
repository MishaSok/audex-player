const { app, BrowserWindow, ipcMain, dialog, shell, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const https = require('https');
const musicMetadata = require('music-metadata');
const NodeID3 = require('node-id3');

app.setName('Audex');

// ── GPU / hardware-acceleration fallback ──
// Some Windows 10 GPU drivers make Electron hang on launch ("not responding").
// We disable hardware acceleration when either:
//   • the AUDEX_DISABLE_GPU env var or the --disable-gpu CLI flag is present, or
//   • a `disable-gpu` marker file exists in userData. The marker is written
//     automatically the first time the window goes unresponsive (see
//     createWindow), so the *next* launch comes up without GPU and works.
// Must run at module load, before app is ready, for disableHardwareAcceleration
// to take effect.
const gpuMarkerPath = path.join(app.getPath('userData'), 'disable-gpu');
function isGpuDisabled() {
  if (process.env.AUDEX_DISABLE_GPU) return true;
  if (process.argv.includes('--disable-gpu')) return true;
  try { return fs.existsSync(gpuMarkerPath); } catch (_) { return false; }
}
if (isGpuDisabled()) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let trayState = {
  hasTrack: false,
  isPlaying: false,
  isFavorite: false,
  title: '',
  artist: '',
};

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function sendTrayCommand(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('tray:command', { action }); } catch (_) {}
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);

function scanDir(dirPath) {
  let results = [];
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        results = results.concat(scanDir(fullPath));
      } else if (AUDIO_EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  } catch (e) { /* skip unreadable dirs */ }
  return results;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0a0b',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.autoHideMenuBar = true;

  // Show only once the renderer has painted its first frame — avoids the blank
  // white window that otherwise flashes (and looks like a freeze) on slow boots.
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  // If the renderer hangs (common with broken GPU drivers on Windows 10), drop a
  // marker so the next launch disables hardware acceleration, and offer an
  // immediate restart. No-op once we're already running without GPU.
  mainWindow.on('unresponsive', () => {
    if (isGpuDisabled()) return;
    try { fs.writeFileSync(gpuMarkerPath, '1'); } catch (_) { /* ignore */ }
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Перезапустить', 'Подождать'],
      defaultId: 0,
      cancelId: 1,
      title: 'Audex не отвечает',
      message: 'Похоже, приложение зависло из-за графического ускорения.',
      detail: 'Перезапустить с отключённым аппаратным ускорением? Это часто помогает на Windows.',
    });
    if (choice === 0) {
      isQuitting = true;
      app.relaunch();
      app.exit(0);
    }
  });

  mainWindow.loadFile('index.html');

  // Close to tray instead of quitting — only an explicit Quit (menu / app.quit)
  // sets isQuitting and lets the window actually close.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === 'darwin') {
        try { app.dock && app.dock.hide(); } catch (_) {}
      }
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; refreshTray(); });
  mainWindow.on('show', () => refreshTray());
  mainWindow.on('hide', () => refreshTray());
}

// Cross-platform tray icon. Windows prefers .ico (multi-size); macOS and
// Linux load the full-color 1024×1024 source and let nativeImage resize it
// to the menu-bar / AppIndicator size — the small pre-rendered indexed-color
// PNGs in build/icons render blank under some Linux indicators.
function resolveTrayIconPath() {
  const base = path.join(__dirname, 'build');
  if (process.platform === 'win32') {
    const ico = path.join(base, 'icon.ico');
    if (fs.existsSync(ico)) return ico;
  }
  return path.join(base, 'icon.png');
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin') {
    try { app.dock && app.dock.show(); } catch (_) {}
  }
}

function buildTrayMenu() {
  const { hasTrack, isPlaying, isFavorite, title, artist } = trayState;

  const nowPlayingLabel = hasTrack
    ? truncate(`${title}${artist ? ' — ' + artist : ''}`, 60)
    : 'Сейчас ничего не играет';

  return Menu.buildFromTemplate([
    { label: nowPlayingLabel, enabled: false },
    { type: 'separator' },
    {
      label: !hasTrack ? 'Воспроизвести' : (isPlaying ? 'Пауза' : 'Воспроизвести'),
      enabled: hasTrack || true, // even with no track, triggers "play first track"
      click: () => sendTrayCommand('playPause'),
    },
    {
      label: 'Предыдущий трек',
      enabled: hasTrack,
      click: () => sendTrayCommand('prev'),
    },
    {
      label: 'Следующий трек',
      enabled: hasTrack,
      click: () => sendTrayCommand('next'),
    },
    {
      label: isFavorite ? 'Убрать из избранного' : 'В избранное',
      enabled: hasTrack,
      click: () => sendTrayCommand('toggleFavorite'),
    },
    { type: 'separator' },
    { label: 'Открыть Audex', click: () => showMainWindow() },
    {
      label: 'Скрыть окно',
      enabled: !!(mainWindow && mainWindow.isVisible()),
      click: () => { if (mainWindow && mainWindow.isVisible()) mainWindow.hide(); },
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => { isQuitting = true; app.quit(); },
    },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  const tip = trayState.hasTrack
    ? truncate(`Audex — ${trayState.isPlaying ? '▶' : '❚❚'} ${trayState.title}${trayState.artist ? ' — ' + trayState.artist : ''}`, 120)
    : 'Audex';
  tray.setToolTip(tip);
}

function createTray() {
  if (tray) return;
  const iconPath = resolveTrayIconPath();
  let image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    if (process.platform === 'darwin') {
      image = image.resize({ width: 16, height: 16 });
    } else if (process.platform === 'linux') {
      // GNOME AppIndicator and KDE StatusNotifier both render best around
      // 22–24px; full-color RGBA scales cleanly from the 1024px source.
      image = image.resize({ width: 22, height: 22 });
    }
    // Windows uses .ico (already multi-size) — no resize needed.
  }
  tray = new Tray(image);
  refreshTray();

  // Single click toggles the window on Windows/Linux. macOS opens the menu by
  // default; users can double-click to open the window.
  const onActivate = () => {
    if (!mainWindow || !mainWindow.isVisible()) {
      showMainWindow();
    } else {
      mainWindow.hide();
    }
  };
  tray.on('click', onActivate);
  tray.on('double-click', () => showMainWindow());
}

ipcMain.handle('tray:updateState', (event, state) => {
  trayState = {
    hasTrack: !!(state && state.hasTrack),
    isPlaying: !!(state && state.isPlaying),
    isFavorite: !!(state && state.isFavorite),
    title: (state && state.title) || '',
    artist: (state && state.artist) || '',
  };
  refreshTray();
  return { success: true };
});

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on('before-quit', () => { isQuitting = true; });

// Tray keeps the app alive when all windows are closed — don't quit on
// window-all-closed (mac already kept the app alive; we now do the same
// on Linux/Windows so the tray icon persists).

// Portrait ("mobile player") mode: shrinks the window to a tall narrow size and
// remembers the previous bounds + minimum size so we can restore them on exit.
// We resize synchronously here rather than interpolating frame-by-frame because
// the renderer drives a FLIP-based cover animation that needs the *final*
// layout to be in effect at measurement time. A staggered window resize would
// give the renderer a moving target and the cover would snap at the end.
let portraitSavedBounds = null;
let portraitSavedMinSize = null;
ipcMain.handle('window:setPortrait', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false };
  const on = !!(payload && payload.on);
  const portraitW = 420;
  const portraitH = 780;

  // If the OS window is in fullscreen, don't resize — that would forcibly exit
  // fullscreen. The CSS in `.is-portrait` already adapts the layout to any width,
  // so a centered mobile column will render inside the fullscreen viewport.
  if (win.isFullScreen()) {
    return { success: true, fullscreen: true };
  }

  if (on) {
    if (!portraitSavedBounds) {
      portraitSavedBounds = win.getBounds();
      portraitSavedMinSize = win.getMinimumSize();
    }
    win.setMinimumSize(320, 560);
    const display = screen.getDisplayMatching(win.getBounds());
    win.setBounds({
      width: portraitW,
      height: portraitH,
      x: Math.round(display.workArea.x + (display.workArea.width - portraitW) / 2),
      y: Math.round(display.workArea.y + (display.workArea.height - portraitH) / 2),
    }, false);
  } else {
    if (portraitSavedMinSize) win.setMinimumSize(portraitSavedMinSize[0], portraitSavedMinSize[1]);
    if (portraitSavedBounds) win.setBounds(portraitSavedBounds, false);
    portraitSavedBounds = null;
    portraitSavedMinSize = null;
  }
  return { success: true };
});

ipcMain.handle('dialog:openFiles', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections', 'openDirectory'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }]
  });
  if (canceled) return [];

  let allFiles = [];
  for (const p of filePaths) {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      allFiles = allFiles.concat(scanDir(p));
    } else {
      allFiles.push(p);
    }
  }
  return allFiles;
});

ipcMain.handle('dialog:chooseFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (canceled || filePaths.length === 0) return null;
  return filePaths[0];
});

ipcMain.handle('music:scanFolder', async (event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  return scanDir(folderPath);
});

ipcMain.handle('music:parseMetadata', async (event, filePath) => {
  try {
    const metadata = await musicMetadata.parseFile(filePath);
    let coverBase64 = null;
    let coverFormat = null;

    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const picture = metadata.common.picture[0];
      coverBase64 = Buffer.from(picture.data).toString('base64');
      coverFormat = picture.format;
    }

    return {
      title: metadata.common.title || path.basename(filePath, path.extname(filePath)),
      artist: metadata.common.artist || 'Unknown Artist',
      album: metadata.common.album || 'Unknown Album',
      albumArtist: metadata.common.albumartist || '',
      year: metadata.common.year || '',
      genre: (metadata.common.genre || []).join(', '),
      trackNo: metadata.common.track && metadata.common.track.no ? String(metadata.common.track.no) : '',
      discNo: metadata.common.disk && metadata.common.disk.no ? String(metadata.common.disk.no) : '',
      comment: (metadata.common.comment && metadata.common.comment[0]) || '',
      duration: metadata.format.duration || 0,
      cover: coverBase64 ? `data:${coverFormat};base64,${coverBase64}` : null,
      path: filePath
    };
  } catch (error) {
    console.error('Error parsing metadata for', filePath, error);
    return {
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      albumArtist: '',
      year: '',
      genre: '',
      trackNo: '',
      discNo: '',
      comment: '',
      duration: 0,
      cover: null,
      path: filePath
    };
  }
});

// Read raw audio bytes so the renderer can decode the track and extract real
// amplitude peaks for the waveform progress bar (Web Audio decode runs in the
// renderer). Returns a Buffer; IPC serializes it to a Uint8Array on the other side.
ipcMain.handle('audio:readFile', async (event, filePath) => {
  return await fs.promises.readFile(filePath);
});

ipcMain.handle('music:writeMetadata', async (event, { filePath, tags }) => {
  if (path.extname(filePath).toLowerCase() !== '.mp3') {
    return { success: false, error: 'Запись тегов поддерживается только для MP3' };
  }
  try {
    const id3Tags = {
      title: tags.title,
      artist: tags.artist,
      album: tags.album,
      performerInfo: tags.albumArtist || undefined,
      year: tags.year ? String(tags.year) : undefined,
      genre: tags.genre || undefined,
      trackNumber: tags.trackNo || undefined,
      partOfSet: tags.discNo || undefined,
      comment: tags.comment ? { language: 'eng', text: tags.comment } : undefined,
    };
    Object.keys(id3Tags).forEach(k => id3Tags[k] === undefined && delete id3Tags[k]);
    const ok = NodeID3.update(id3Tags, filePath);
    return { success: !!ok };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('shell:revealInFolder', async (event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('shell:openExternal', async (event, url) => {
  if (typeof url !== 'string') return { success: false, error: 'No url' };
  if (!/^https?:\/\//i.test(url)) return { success: false, error: 'Only http(s) URLs are allowed' };
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// ── Hardware acceleration toggle ──
// Reflects/controls the `disable-gpu` marker file used by the GPU fallback at
// the top of this file. Returns whether hardware acceleration is currently
// effective. Toggling writes or removes the marker; the change needs a restart
// to take hold (disableHardwareAcceleration only works before app is ready), so
// we offer one via a native dialog.
ipcMain.handle('app:getHardwareAcceleration', () => {
  return { enabled: !isGpuDisabled() };
});

ipcMain.handle('app:setHardwareAcceleration', async (event, enabled) => {
  try {
    if (enabled) {
      try { fs.rmSync(gpuMarkerPath, { force: true }); } catch (_) { /* ignore */ }
    } else {
      fs.writeFileSync(gpuMarkerPath, '1');
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    buttons: ['Перезапустить', 'Позже'],
    defaultId: 0,
    cancelId: 1,
    title: 'Требуется перезапуск',
    message: 'Изменение применится после перезапуска приложения.',
    detail: 'Перезапустить Audex сейчас?',
  });
  if (choice === 0) {
    isQuitting = true;
    app.relaunch();
    app.exit(0);
  }
  return { success: true, restarted: choice === 0 };
});

// ── Update check ──
// Polls the GitHub Releases API for the latest published release and compares
// it to the running version. No auto-install — the renderer shows an in-app
// banner whose "Download" button opens the release page via shell:openExternal.
const GITHUB_REPO = 'MishaSok/audex-player';

function parseVersion(v) {
  // "v1.1.2" / "1.1.2" / "1.1.2-beta" -> [1, 1, 2]
  const core = String(v).trim().replace(/^v/i, '').split(/[-+]/)[0];
  return core.split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/releases/latest`,
        headers: {
          'User-Agent': 'Audex-Player',
          Accept: 'application/vnd.github+json',
        },
        timeout: 10000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub API status ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (err) { reject(err); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('GitHub API timeout')));
    req.on('error', reject);
  });
}

ipcMain.handle('update:check', async () => {
  const currentVersion = app.getVersion();
  try {
    const release = await fetchLatestRelease();
    if (!release || release.draft || release.prerelease || !release.tag_name) {
      return { success: true, hasUpdate: false, currentVersion };
    }
    const latestVersion = String(release.tag_name).replace(/^v/i, '');
    return {
      success: true,
      currentVersion,
      latestVersion,
      hasUpdate: isNewerVersion(latestVersion, currentVersion),
      url: release.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
    };
  } catch (err) {
    return { success: false, error: String(err), currentVersion };
  }
});

ipcMain.handle('shell:deleteFile', async (event, filePath) => {
  if (!filePath) return { success: false, error: 'No path' };
  if (!fs.existsSync(filePath)) return { success: true, missing: true };
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

// ── Downloads: YouTube via yt-dlp ─────────────────────────────────────────────

// The standalone yt-dlp binary shipped inside the app (see scripts/fetch-ytdlp.js
// and build.asarUnpack in package.json). Returns null when not packed.
function resolveBundledYtDlp() {
  const bundleRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'yt-dlp-bundle')
    : path.join(__dirname, 'yt-dlp-bundle');
  const name = process.platform === 'linux' ? 'yt-dlp_linux'
    : process.platform === 'darwin' ? 'yt-dlp_macos'
    : process.platform === 'win32' ? 'yt-dlp.exe'
    : null;
  if (!name) return null;
  const candidate = path.join(bundleRoot, name);
  try {
    if (fs.existsSync(candidate)) {
      // AppImage/asar-unpacked files can lose the exec bit on some setups.
      if (process.platform !== 'win32') {
        try { fs.chmodSync(candidate, 0o755); } catch (_) {}
      }
      return candidate;
    }
  } catch (_) {}
  return null;
}

function ytDlpPath() {
  // Prefer the bundled binary so the downloader works without a system install.
  const bundled = resolveBundledYtDlp();
  if (bundled) return bundled;
  // Fall back to a system-installed yt-dlp (dev runs, or if the bundle is missing).
  const candidates = [
    'yt-dlp',
    path.join(process.env.HOME || '', '.local', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
  ];
  for (const c of candidates.slice(1)) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return candidates[0];
}

// ffmpeg is required by yt-dlp for audio extraction (mp3) and thumbnail embedding.
// We ship the static binary via the ffmpeg-static npm package (asarUnpack'd in
// package.json). require() resolves the path inside the asar; rewrite it to the
// unpacked copy so the binary is actually runnable. Returns null if unavailable
// (then yt-dlp falls back to a system ffmpeg on PATH, if any).
let _ffmpegPath;
function resolveBundledFfmpeg() {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  _ffmpegPath = null;
  try {
    let p = require('ffmpeg-static');
    if (p) {
      if (app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(p)) {
        if (process.platform !== 'win32') {
          try { fs.chmodSync(p, 0o755); } catch (_) {}
        }
        _ffmpegPath = p;
      }
    }
  } catch (_) {}
  return _ffmpegPath;
}

function runYtDlp(args, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const proc = spawn(ytDlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    }
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || String(err), spawnError: String(err) });
    });
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

function fmtDuration(sec) {
  if (!sec || sec < 0) return '';
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

ipcMain.handle('downloads:ytSearch', async (event, query, count) => {
  const q = String(query || '').trim();
  if (!q) return { success: true, results: [] };
  const n = Math.max(1, Math.min(20, parseInt(count, 10) || 8));
  const args = [
    `ytsearch${n}:${q}`,
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout', '15',
  ];
  const { code, stdout, stderr, spawnError } = await runYtDlp(args, { timeoutMs: 30000 });
  if (spawnError) {
    return { success: false, error: 'yt-dlp not found. Install it: pip install -U yt-dlp' };
  }
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      if (!j.id) continue;
      const thumbs = Array.isArray(j.thumbnails) ? j.thumbnails : [];
      const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${j.id}/mqdefault.jpg`;
      results.push({
        id: j.id,
        title: j.title || '',
        channel: j.channel || j.uploader || j.uploader_id || '',
        duration: j.duration || 0,
        durationStr: fmtDuration(j.duration || 0),
        thumbnail: thumb,
        url: j.url || j.webpage_url || `https://www.youtube.com/watch?v=${j.id}`,
      });
    } catch (_) { /* skip malformed lines */ }
  }
  if (results.length === 0 && code !== 0) {
    return { success: false, error: (stderr.trim().split('\n').pop() || 'yt-dlp error').slice(0, 300) };
  }
  return { success: true, results };
});

function sanitizeFsName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 180);
}

function streamYtDlp(args, { onProgress, onPhase, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBuf = '';
    const proc = spawn(ytDlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    }
    proc.stdout.on('data', d => {
      const text = d.toString();
      stdout += text;
      stdoutBuf += text;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.startsWith('[dlprog]')) {
          const parts = line.slice(8).trim().split('|');
          const rawPct = (parts[0] || '').trim().replace('%', '');
          const pct = parseFloat(rawPct);
          if (!isNaN(pct) && onProgress) {
            onProgress({
              phase: 'download',
              percent: Math.max(0, Math.min(100, pct)),
              speed: (parts[1] || '').trim(),
              eta: (parts[2] || '').trim(),
            });
          }
        } else if (line.startsWith('[ExtractAudio]') || line.startsWith('[EmbedThumbnail]') || line.startsWith('[Metadata]') || line.startsWith('[FixupM3u8]')) {
          if (onPhase) onPhase('postprocess');
        }
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || String(err), spawnError: String(err) });
    });
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function resolveDownloadsDir(requested) {
  const fallback = path.join(app.getPath('music'), 'Audex Downloads');
  const candidate = (requested && String(requested).trim()) || '';
  if (candidate) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch (_) { /* fall through to fallback */ }
  }
  try { fs.mkdirSync(fallback, { recursive: true }); } catch (_) {}
  return fallback;
}

ipcMain.handle('downloads:ytDownload', async (event, payload) => {
  const { videoId, url, suggestedName, targetDir } = payload || {};
  if (!videoId && !url) return { success: false, error: 'No video id' };

  const downloadsDir = resolveDownloadsDir(targetDir);

  const target = url || `https://www.youtube.com/watch?v=${videoId}`;
  const outPattern = path.join(downloadsDir, '%(title)s [%(id)s].%(ext)s');

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-quiet',
    '--newline',
    '--progress-template', '[dlprog] %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--embed-thumbnail',
    '--add-metadata',
    '--output', outPattern,
    '--print', 'after_move:filepath',
    target,
  ];
  const ffmpeg = resolveBundledFfmpeg();
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);

  const sendProgress = (data) => {
    try {
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('downloads:ytProgress', { videoId, url, requestId: payload && payload.requestId, ...data });
      }
    } catch (_) {}
  };

  const { code, stdout, stderr, spawnError } = await streamYtDlp(args, {
    timeoutMs: 5 * 60 * 1000,
    onProgress: (p) => sendProgress(p),
    onPhase: (phase) => sendProgress({ phase }),
  });

  if (spawnError) {
    return { success: false, error: 'yt-dlp not found. Install it: pip install -U yt-dlp' };
  }
  if (code !== 0) {
    const errLine = (stderr.trim().split('\n').pop() || stdout.trim().split('\n').pop() || 'yt-dlp failed').slice(0, 300);
    return { success: false, error: errLine };
  }

  let filePath = stdout.split('\n')
    .map(l => l.trim())
    .filter(l => l && (l.startsWith('/') || /^[A-Za-z]:\\/.test(l)))
    .pop() || '';
  if (!filePath || !fs.existsSync(filePath)) {
    try {
      const files = fs.readdirSync(downloadsDir)
        .filter(f => f.toLowerCase().endsWith('.mp3') && (videoId ? f.includes(`[${videoId}]`) : true))
        .map(f => ({ f, m: fs.statSync(path.join(downloadsDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (files.length) filePath = path.join(downloadsDir, files[0].f);
    } catch (_) {}
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'Downloaded file not found' };
  }

  if (suggestedName) {
    try {
      const safe = sanitizeFsName(suggestedName) + '.mp3';
      const targetPath = path.join(downloadsDir, safe);
      if (targetPath !== filePath && !fs.existsSync(targetPath)) {
        fs.renameSync(filePath, targetPath);
        filePath = targetPath;
      }
    } catch (_) { /* keep original name */ }
  }

  return { success: true, filePath, downloadsDir };
});

ipcMain.handle('downloads:getDir', async (event, payload) => {
  return resolveDownloadsDir(payload && payload.targetDir);
});

ipcMain.handle('downloads:ytDownloadByQuery', async (event, payload) => {
  const { query, suggestedName, requestId, targetDir } = payload || {};
  if (!query || !String(query).trim()) return { success: false, error: 'Empty query' };

  const downloadsDir = resolveDownloadsDir(targetDir);

  const target = `ytsearch1:${String(query).trim()}`;
  const outPattern = path.join(downloadsDir, '%(title)s [%(id)s].%(ext)s');

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-quiet',
    '--newline',
    '--progress-template', '[dlprog] %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--embed-thumbnail',
    '--add-metadata',
    '--output', outPattern,
    '--print', 'after_move:filepath',
    target,
  ];
  const ffmpeg = resolveBundledFfmpeg();
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);

  const sendProgress = (data) => {
    try {
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('downloads:ytProgress', { requestId, ...data });
      }
    } catch (_) {}
  };

  const { code, stdout, stderr, spawnError } = await streamYtDlp(args, {
    timeoutMs: 5 * 60 * 1000,
    onProgress: (p) => sendProgress(p),
    onPhase: (phase) => sendProgress({ phase }),
  });

  if (spawnError) {
    return { success: false, error: 'yt-dlp not found. Install it: pip install -U yt-dlp' };
  }
  if (code !== 0) {
    const errLine = (stderr.trim().split('\n').pop() || stdout.trim().split('\n').pop() || 'yt-dlp failed').slice(0, 300);
    return { success: false, error: errLine };
  }

  let filePath = stdout.split('\n')
    .map(l => l.trim())
    .filter(l => l && (l.startsWith('/') || /^[A-Za-z]:\\/.test(l)))
    .pop() || '';
  if (!filePath || !fs.existsSync(filePath)) {
    try {
      const files = fs.readdirSync(downloadsDir)
        .filter(f => f.toLowerCase().endsWith('.mp3'))
        .map(f => ({ f, m: fs.statSync(path.join(downloadsDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (files.length) filePath = path.join(downloadsDir, files[0].f);
    } catch (_) {}
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'Downloaded file not found' };
  }

  if (suggestedName) {
    try {
      const safe = sanitizeFsName(suggestedName) + '.mp3';
      const targetPath = path.join(downloadsDir, safe);
      if (targetPath !== filePath && !fs.existsSync(targetPath)) {
        fs.renameSync(filePath, targetPath);
        filePath = targetPath;
      }
    } catch (_) { /* keep original name */ }
  }

  return { success: true, filePath, downloadsDir };
});

// ── Yandex Music playlist parser (Puppeteer) ──────────────────────────────────

let yandexBrowser = null;

function resolveBundledChromium() {
  const bundleRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'chromium-bundle')
    : path.join(__dirname, 'chromium-bundle');

  let dirPrefix;
  let relExe;
  if (process.platform === 'linux') {
    dirPrefix = 'linux';
    relExe = path.join('chrome-linux64', 'chrome');
  } else if (process.platform === 'win32') {
    dirPrefix = 'win64';
    relExe = path.join('chrome-win64', 'chrome.exe');
  } else if (process.platform === 'darwin') {
    dirPrefix = process.arch === 'arm64' ? 'mac_arm' : 'mac';
    const inner = process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64';
    relExe = path.join(inner, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  } else {
    return null;
  }

  try {
    const chromeRoot = path.join(bundleRoot, 'chrome');
    const subdirs = fs.readdirSync(chromeRoot).filter(d => d.startsWith(dirPrefix + '-'));
    if (subdirs.length) {
      subdirs.sort();
      const versionDir = subdirs[subdirs.length - 1];
      const candidate = path.join(chromeRoot, versionDir, relExe);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (_) { /* fall through */ }

  try { return require('puppeteer').executablePath(); } catch (_) { return null; }
}

const AD_SELECTORS = [
  "[class*='ads-banner__close']",
  "[class*='ad-close']",
  "[class*='AdClose']",
  "[class*='popup__close']",
  "[class*='Modal__close']",
  "[class*='modal__close']",
  "button[aria-label='Закрыть']",
  "button[aria-label='Close']",
  "[class*='notification__close']",
  "[class*='PromoMobile'] button",
  "[class*='promo-mobile__close']",
  "[class*='banner__close']",
  "[class*='advert'] button",
];

const TITLE_SELECTORS = [
  "[class*='d-track__title']",
  "[class*='TrackTitle']",
  "[class*='track__name']",
  "[class*='Track__name']",
  "[class*='trackName']",
  "[class*='title_']",
  "a[class*='d-track']",
];
const ARTIST_SELECTORS = [
  "[class*='d-track__artists']",
  "a[href*='/artist/']",
  "[class*='TrackArtists']",
  "[class*='track__artists']",
  "[class*='artists_']",
];
const DURATION_SELECTORS = [
  "[class*='TrackDuration']",
  "[class*='track__duration']",
  "[class*='duration_']",
  "[class*='d-track__duration']",
  "time",
];
const COVER_SELECTORS = [
  "[class*='Album_cover'] img",
  "[class*='album-art'] img",
  "[class*='CoverImage'] img",
  "[class*='cover'] img",
  "[class*='Cover'] img",
  "[class*='artwork'] img",
  "img[src*='avatars.yandex.net']",
  "img[src*='music-content']",
];
const TRACK_SEL = "[class*='CommonTrack_root']";

function durationToSeconds(dur) {
  if (!dur) return 0;
  const parts = String(dur).trim().split(/[:.]/);
  try {
    if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    if (parts.length === 3) return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  } catch (_) {}
  return 0;
}

async function closeAds(page) {
  for (const sel of AD_SELECTORS) {
    try {
      const handles = await page.$$(sel);
      for (const h of handles) {
        try {
          await h.click({ delay: 30 }).catch(async () => {
            await page.evaluate((el) => el.click(), h);
          });
          await new Promise(r => setTimeout(r, 200));
        } catch (_) {}
      }
    } catch (_) {}
  }
  try { await page.keyboard.press('Escape'); } catch (_) {}
}

async function extractTracksFromDom(page) {
  return await page.evaluate(({ TRACK_SEL, TITLE_SELECTORS, ARTIST_SELECTORS, DURATION_SELECTORS, COVER_SELECTORS }) => {
    function findText(el, selectors) {
      for (const sel of selectors) {
        const nodes = el.querySelectorAll(sel);
        const texts = [];
        nodes.forEach(n => { const t = (n.textContent || '').trim(); if (t) texts.push(t); });
        if (texts.length) return texts.join(' & ');
      }
      return '';
    }
    function findCover(el) {
      for (const sel of COVER_SELECTORS) {
        const imgs = el.querySelectorAll(sel);
        for (const img of imgs) {
          const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
          if (src && src.includes('avatars')) {
            return src.replace(/\/\d+x\d+$/, '/1000x1000').replace(/\/%%$/, '/1000x1000');
          }
        }
      }
      return '';
    }
    function viaAria(el) {
      const btn = el.querySelector("[class*='playButtonCell'] [aria-label]");
      const label = btn ? (btn.getAttribute('aria-label') || '') : '';
      const m = label.match(/\.\s*(.+?)\s*[–—]\s*(.+)$/);
      if (m) return { title: m[2].trim(), artist: m[1].trim() };
      return { title: label.trim(), artist: '' };
    }
    // On album pages, Yandex hides the artist column for tracks by the album's main
    // artist. Collect artist links that live OUTSIDE any track row — those belong to
    // the album/playlist header and serve as a fallback.
    function getAlbumArtist() {
      const trackRoots = Array.from(document.querySelectorAll(TRACK_SEL));
      const links = Array.from(document.querySelectorAll("a[href*='/artist/']"));
      const names = [];
      for (const a of links) {
        if (trackRoots.some(root => root.contains(a))) continue;
        const t = (a.textContent || '').trim();
        if (t && !names.includes(t)) names.push(t);
      }
      return names.join(' & ');
    }
    const albumArtist = getAlbumArtist();
    const out = [];
    const els = document.querySelectorAll(TRACK_SEL);
    els.forEach(el => {
      let title = findText(el, TITLE_SELECTORS);
      let artist = findText(el, ARTIST_SELECTORS);
      let dur = findText(el, DURATION_SELECTORS);
      if (!title) {
        const a = viaAria(el);
        title = a.title;
        if (!artist) artist = a.artist;
      }
      if (!title) title = (el.getAttribute('data-title') || '').trim();
      if (dur && !/\d:\d/.test(dur)) dur = '';
      if (!title) return;
      if (!artist && albumArtist) artist = albumArtist;
      out.push({
        title,
        artist: artist || '—',
        duration: dur || '—',
        cover_url: findCover(el),
      });
    });
    return out;
  }, { TRACK_SEL, TITLE_SELECTORS, ARTIST_SELECTORS, DURATION_SELECTORS, COVER_SELECTORS });
}

ipcMain.handle('yandex:parsePlaylist', async (event, payload) => {
  const url = (payload && payload.url) ? String(payload.url).trim() : '';
  const showBrowser = !payload || payload.showBrowser !== false;
  if (!url || !/^https?:\/\/music\.yandex\./i.test(url)) {
    return { success: false, error: 'Invalid Yandex Music URL' };
  }

  const send = (data) => {
    try {
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('yandex:parseProgress', data);
      }
    } catch (_) {}
  };

  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (err) {
    return { success: false, error: 'puppeteer not installed' };
  }

  const executablePath = resolveBundledChromium();
  if (!executablePath || !fs.existsSync(executablePath)) {
    return { success: false, error: 'Bundled Chromium not found. Run "npm install puppeteer" before packaging.' };
  }

  const userDataDir = path.join(app.getPath('userData'), 'yandex-profile');
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (_) {}

  send({ phase: 'launching', message: showBrowser ? 'Запуск браузера…' : 'Запускаем парсер…' });

  try {
    yandexBrowser = await puppeteer.launch({
      executablePath,
      headless: !showBrowser,
      userDataDir,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-notifications',
        ...(showBrowser ? ['--window-size=1440,900'] : []),
      ],
      defaultViewport: showBrowser ? null : { width: 1440, height: 900 },
    });
  } catch (err) {
    return { success: false, error: 'Failed to launch Chromium: ' + String(err).slice(0, 200) };
  }

  const collected = new Map();

  try {
    const pages = await yandexBrowser.pages();
    const page = pages[0] || await yandexBrowser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    send({ phase: 'loading', message: 'Открываем плейлист…' });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (navErr) {
      // Heavy SPAs (Yandex Music) sometimes never fully fire DOMContentLoaded —
      // continue anyway, the later "wait for tracks" loop is the real gate.
      send({ phase: 'loading', message: 'Страница грузится дольше обычного, продолжаем…' });
    }
    await new Promise(r => setTimeout(r, 2500));

    send({ phase: 'loading', message: 'Закрываем рекламу…' });
    for (let i = 0; i < 3; i++) {
      await closeAds(page);
      await new Promise(r => setTimeout(r, 600));
    }

    send({
      phase: 'loading',
      message: showBrowser
        ? 'Ждём загрузку треков (вход в Яндекс — в окне браузера, если нужно)…'
        : 'Ждём загрузку треков…',
    });
    const deadline = Date.now() + 90_000;
    let appeared = false;
    while (Date.now() < deadline) {
      await closeAds(page);
      const count = await page.$$eval(TRACK_SEL, els => els.length).catch(() => 0);
      if (count > 0) { appeared = true; break; }
      await new Promise(r => setTimeout(r, 1500));
    }
    if (!appeared) throw new Error('Tracks did not appear (login or wrong URL?)');

    send({ phase: 'scrolling', message: 'Собираем треки…', total: 0 });

    let noNew = 0;
    const SCROLL_RETRIES = 6;
    while (noNew < SCROLL_RETRIES) {
      await closeAds(page);
      const tracks = await extractTracksFromDom(page);
      let added = 0;
      for (const t of tracks) {
        const key = `${t.title}|${t.artist}`;
        if (!collected.has(key)) {
          collected.set(key, { ...t, index: collected.size + 1, duration_sec: durationToSeconds(t.duration) });
          added++;
        }
      }
      if (added === 0) noNew++; else noNew = 0;
      send({
        phase: 'scrolling',
        message: 'Собираем треки…',
        total: collected.size,
        added,
        tracks: Array.from(collected.values()),
      });
      try {
        await page.evaluate((sel) => {
          const els = document.querySelectorAll(sel);
          if (els.length) els[els.length - 1].scrollIntoView({ block: 'center' });
        }, TRACK_SEL);
      } catch (_) {
        await page.evaluate(() => window.scrollBy(0, 600));
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    const tracks = Array.from(collected.values());
    send({ phase: 'done', message: `Готово — ${tracks.length} треков`, total: tracks.length, tracks });
    return { success: true, tracks };
  } catch (err) {
    const msg = String(err && err.message || err).slice(0, 300);
    send({ phase: 'error', message: msg });
    return { success: false, error: msg, tracks: Array.from(collected.values()) };
  } finally {
    try { if (yandexBrowser) await yandexBrowser.close(); } catch (_) {}
    yandexBrowser = null;
  }
});
