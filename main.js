const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const musicMetadata = require('music-metadata');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    }
  });

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
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac'] }]
  });
  if (canceled) {
    return [];
  } else {
    return filePaths;
  }
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
      duration: 0,
      cover: null,
      path: filePath
    };
  }
});
