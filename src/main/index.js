// Must be set before any fs/hash work touches libuv's thread pool — the
// default of 4 threads bottlenecks concurrent hashing/thumbnailing well
// before CPU is actually the limit on modern machines.
process.env.UV_THREADPOOL_SIZE = String(Math.max(4, require('os').cpus().length));

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('./db');
const { createWatcher, ensureTracked } = require('./watcher');

// We're a local file-browsing app, not a web app — no need for Chromium's
// HTTP disk cache to grow unbounded on disk.
app.commandLine.appendSwitch('disk-cache-size', String(50 * 1024 * 1024));

let mainWindow;
let database;
let watcher;
let watchedRoot;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#131314',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Throttle timers/rAF in tabs that aren't visible/focused — this is a
      // multi-tab browsing tool, not something that needs background tabs
      // doing full-rate work.
      backgroundThrottling: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function startWatching(rootDir) {
  if (watcher) watcher.close();
  watchedRoot = rootDir;
  watcher = createWatcher({
    rootDir,
    database,
    onEvent: (event) => {
      mainWindow.webContents.send('fs-event', event);
    },
  });
}

app.whenReady().then(() => {
  database = db.openDb(app.getPath('userData'));
  createWindow();

  ipcMain.handle('choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const rootDir = result.filePaths[0];
    startWatching(rootDir);
    return rootDir;
  });

  ipcMain.handle('watch-folder', (_event, rootDir) => {
    startWatching(rootDir);
    return rootDir;
  });

  ipcMain.handle('tag-file', async (_event, { filePath, tagName }) => {
    const row = await ensureTracked(database, filePath);
    db.addTag(database, row.id, tagName);
    return { fileId: row.id, hash: row.hash, tags: db.getTagsForFile(database, row.id) };
  });

  ipcMain.handle('get-tags', (_event, filePath) => {
    const row = db.getByPath(database, filePath);
    if (!row) return [];
    return db.getTagsForFile(database, row.id);
  });

  ipcMain.handle('get-lost-files', () => db.getLost(database));

  // Preload runs sandboxed and can't require('os')/require('path') itself,
  // so the renderer asks main for these instead of reading them locally.
  ipcMain.handle('get-home-dir', () => os.homedir());

  ipcMain.handle('get-file-info', (_event, filePath) => {
    try {
      const st = fs.statSync(filePath);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  });

  ipcMain.handle('clear-tags', (_event, filePath) => {
    const row = db.getByPath(database, filePath);
    if (!row) return [];
    db.clearTags(database, row.id);
    return db.getTagsForFile(database, row.id);
  });

  ipcMain.handle('reveal-in-finder', (_event, filePath) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('open-privacy-settings', () => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Files');
  });

  ipcMain.handle('open-folder', (_event, filePath) => {
    shell.openPath(path.dirname(filePath));
  });

  ipcMain.handle('duplicate-file', async (_event, filePath) => {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    let n = 2;
    let candidate = path.join(dir, `${base}-${n}${ext}`);
    while (fs.existsSync(candidate)) {
      n += 1;
      candidate = path.join(dir, `${base}-${n}${ext}`);
    }
    await fs.promises.copyFile(filePath, candidate);
    return candidate;
  });

  // Plain on-disk rename. The watcher's own unlink/add pair (matched by
  // content hash) is what keeps a tracked file's tags/group attached — this
  // handler just performs the fs operation the user asked for.
  ipcMain.handle('rename-file', async (_event, { filePath, newName }) => {
    const newPath = path.join(path.dirname(filePath), newName);
    if (fs.existsSync(newPath)) {
      throw new Error(`${newName} already exists in this folder`);
    }
    await fs.promises.rename(filePath, newPath);
    return newPath;
  });
});

app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  if (process.platform !== 'darwin') app.quit();
});
