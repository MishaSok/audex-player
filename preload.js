const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setZoomFactor: (factor) => {
    try { webFrame.setZoomFactor(Number(factor) || 1); } catch (_) {}
  },
  getZoomFactor: () => {
    try { return webFrame.getZoomFactor(); } catch (_) { return 1; }
  },
  setPortrait: (on) => ipcRenderer.invoke('window:setPortrait', { on: !!on }),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('music:scanFolder', folderPath),
  parseMetadata: (filePath) => ipcRenderer.invoke('music:parseMetadata', filePath),
  writeMetadata: (filePath, tags) => ipcRenderer.invoke('music:writeMetadata', { filePath, tags }),
  revealInFolder: (filePath) => ipcRenderer.invoke('shell:revealInFolder', filePath),
  deleteFile: (filePath) => ipcRenderer.invoke('shell:deleteFile', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  ytSearch: (query, count) => ipcRenderer.invoke('downloads:ytSearch', query, count),
  ytDownload: (payload) => ipcRenderer.invoke('downloads:ytDownload', payload),
  ytDownloadByQuery: (payload) => ipcRenderer.invoke('downloads:ytDownloadByQuery', payload),
  onYtDownloadProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('downloads:ytProgress', listener);
    return () => ipcRenderer.removeListener('downloads:ytProgress', listener);
  },
  getDownloadsDir: (targetDir) => ipcRenderer.invoke('downloads:getDir', { targetDir }),
  yandexParse: (payload) => ipcRenderer.invoke('yandex:parsePlaylist', payload),
  onYandexParseProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('yandex:parseProgress', listener);
    return () => ipcRenderer.removeListener('yandex:parseProgress', listener);
  },
  updateTrayState: (state) => ipcRenderer.invoke('tray:updateState', state),
  onTrayCommand: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('tray:command', listener);
    return () => ipcRenderer.removeListener('tray:command', listener);
  },
});
