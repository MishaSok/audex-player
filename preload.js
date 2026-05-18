const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('music:scanFolder', folderPath),
  parseMetadata: (filePath) => ipcRenderer.invoke('music:parseMetadata', filePath),
  writeMetadata: (filePath, tags) => ipcRenderer.invoke('music:writeMetadata', { filePath, tags }),
  revealInFolder: (filePath) => ipcRenderer.invoke('shell:revealInFolder', filePath),
  deleteFile: (filePath) => ipcRenderer.invoke('shell:deleteFile', filePath),
});
