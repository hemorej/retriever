const { contextBridge, ipcRenderer } = require('electron');

// The preload script runs sandboxed — it can't require('os') or
// require('path') itself, so anything like that goes through main via IPC.
contextBridge.exposeInMainWorld('retriever', {
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  watchFolder: (dir) => ipcRenderer.invoke('watch-folder', dir),
  tagFile: (filePath, tagName) => ipcRenderer.invoke('tag-file', { filePath, tagName }),
  getTags: (filePath) => ipcRenderer.invoke('get-tags', filePath),
  getAllTags: () => ipcRenderer.invoke('get-all-tags'),
  getLostFiles: () => ipcRenderer.invoke('get-lost-files'),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  clearTags: (filePath) => ipcRenderer.invoke('clear-tags', filePath),
  revealInFinder: (filePath) => ipcRenderer.invoke('reveal-in-finder', filePath),
  openPrivacySettings: () => ipcRenderer.invoke('open-privacy-settings'),
  openFolder: (filePath) => ipcRenderer.invoke('open-folder', filePath),
  renameFile: (filePath, newName) => ipcRenderer.invoke('rename-file', { filePath, newName }),
  trashPath: (targetPath) => ipcRenderer.invoke('trash-path', targetPath),
  duplicateFile: (filePath) => ipcRenderer.invoke('duplicate-file', filePath),
  chooseDestinationFolder: () => ipcRenderer.invoke('choose-destination-folder'),
  moveFiles: (filePaths, destDir) => ipcRenderer.invoke('move-files', { filePaths, destDir }),
  copyFiles: (filePaths, destDir) => ipcRenderer.invoke('copy-files', { filePaths, destDir }),
  stripMetadata: (filePaths, options) => ipcRenderer.invoke('strip-metadata', { filePaths, options }),
  openInExternalEditor: (filePath) => ipcRenderer.invoke('open-in-external-editor', filePath),
  listSubfolders: (dir) => ipcRenderer.invoke('list-subfolders', dir),
  getImagePreview: (filePath) => ipcRenderer.invoke('get-image-preview', filePath),
  getThumbnail: (filePath) => ipcRenderer.invoke('get-thumbnail', filePath),
  loadSession: () => ipcRenderer.invoke('load-session'),
  saveSession: (session) => ipcRenderer.invoke('save-session', session),
  onFsEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('fs-event', listener);
    return () => ipcRenderer.removeListener('fs-event', listener);
  },
});
