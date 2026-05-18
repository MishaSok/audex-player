const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const musicMetadata = require('music-metadata');
const NodeID3 = require('node-id3');

app.setName('Audex');

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
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.autoHideMenuBar = true;

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
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

function ytDlpPath() {
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

ipcMain.handle('downloads:ytDownload', async (event, payload) => {
  const { videoId, url, suggestedName } = payload || {};
  if (!videoId && !url) return { success: false, error: 'No video id' };

  const downloadsDir = path.join(app.getPath('music'), 'Audex Downloads');
  try { fs.mkdirSync(downloadsDir, { recursive: true }); } catch (_) {}

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

  const sendProgress = (data) => {
    try {
      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('downloads:ytProgress', { videoId, url, ...data });
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

ipcMain.handle('downloads:getDir', async () => {
  const downloadsDir = path.join(app.getPath('music'), 'Audex Downloads');
  try { fs.mkdirSync(downloadsDir, { recursive: true }); } catch (_) {}
  return downloadsDir;
});
