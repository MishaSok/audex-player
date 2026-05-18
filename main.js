const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const musicMetadata = require('music-metadata');
const NodeID3 = require('node-id3');

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
