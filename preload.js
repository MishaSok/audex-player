const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  parseMetadata: (filePath) => ipcRenderer.invoke('music:parseMetadata', filePath)
});
