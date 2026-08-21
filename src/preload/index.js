const { contextBridge, ipcRenderer } = require('electron');

// The preload script runs sandboxed — it can't require('os') or
// require('path') itself, so anything like that goes through main via IPC.
contextBridge.exposeInMainWorld('retriever', {
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  watchFolder: (dir) => ipcRenderer.invoke('watch-folder', dir),
  tagFile: (filePath, tagName) => ipcRenderer.invoke('tag-file', { filePath, tagName }),
  getTags: (filePath) => ipcRenderer.invoke('get-tags', filePath),
  getLostFiles: () => ipcRenderer.invoke('get-lost-files'),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  clearTags: (filePath) => ipcRenderer.invoke('clear-tags', filePath),
  revealInFinder: (filePath) => ipcRenderer.invoke('reveal-in-finder', filePath),
  openPrivacySettings: () => ipcRenderer.invoke('open-privacy-settings'),
  openFolder: (filePath) => ipcRenderer.invoke('open-folder', filePath),
  renameFile: (filePath, newName) => ipcRenderer.invoke('rename-file', { filePath, newName }),
  duplicateFile: (filePath) => ipcRenderer.invoke('duplicate-file', filePath),
  onFsEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('fs-event', listener);
    return () => ipcRenderer.removeListener('fs-event', listener);
  },
});
