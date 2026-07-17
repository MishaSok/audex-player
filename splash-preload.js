const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashAPI', {
  onStatus: (cb) => ipcRenderer.on('splash:status', (_e, text) => cb(text)),
});
