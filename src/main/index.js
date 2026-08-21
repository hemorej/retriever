// Must be set before any fs/hash work touches libuv's thread pool — the
// default of 4 threads bottlenecks concurrent hashing/thumbnailing well
// before CPU is actually the limit on modern machines.
process.env.UV_THREADPOOL_SIZE = String(Math.max(4, require('os').cpus().length));

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const db = require('./db');
const { createWatcher, ensureTracked } = require('./watcher');
const { stripBuffer } = require('./metadata');

// We're a local file-browsing app, not a web app — no need for Chromium's
// HTTP disk cache to grow unbounded on disk.
app.commandLine.appendSwitch('disk-cache-size', String(50 * 1024 * 1024));

// electron-builder's productName ("Retriever") only applies to packaged
// builds; `electron .` in dev otherwise shows "Electron" in the menu bar.
app.setName('Retriever');

let mainWindow;
let database;
let watcher;
let watchedRoot;
let sessionPath;

const EXTERNAL_EDITOR_APP = '/Applications/Affinity Photo 2.app';
const PREVIEW_MAX_DIMENSION = 2000;

// child_process.execFile's async spawn reliably throws a synchronous
// "spawn EBADF" here — a posix_spawn/libuv fd issue specific to spawning
// from an Electron 43 main process on macOS, reproducible on every call,
// not just under load. execFileSync doesn't hit it (different underlying
// spawn path), so that's what get-image-preview uses; the tradeoff is
// blocking the main process for the call's duration (a couple hundred ms),
// which is what would otherwise have been spent awaiting it anyway.
function runSips(filePath) {
  const tmpPath = path.join(os.tmpdir(), `retriever-preview-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    execFileSync('sips', ['-s', 'format', 'png', '-Z', String(PREVIEW_MAX_DIMENSION), filePath, '--out', tmpPath], { stdio: 'ignore' });
    const buf = fs.readFileSync(tmpPath);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

// Same "-2, -3, …" collision scheme as duplicate-file, generalized to an
// arbitrary destination directory (move/copy land files there, possibly
// alongside a file of the same name that's unrelated to the one being moved).
function uniqueDestPath(destDir, filePath) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let candidate = path.join(destDir, path.basename(filePath));
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(destDir, `${base}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

// Slightly transparent variant of the mark (src/renderer/icon.png, used
// fully opaque by AppMark's CSS mask in the renderer) for the window/dock
// icon.
const dockIconPath = path.join(__dirname, '../renderer/icon-dock.png');

function createWindow() {
  // In dev (`electron .`), the Dock/app-switcher icon otherwise defaults to
  // Electron's own icon — packaged builds get this from electron-builder's
  // `mac.icon` instead, but that config has no effect on unpackaged runs.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(dockIconPath);
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#131314',
    icon: dockIconPath,
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
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(dockIconPath);
  }
  database = db.openDb(app.getPath('userData'));
  sessionPath = path.join(app.getPath('userData'), 'session.json');
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

  ipcMain.handle('choose-destination-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Moves that land back in the currently watched root are picked up by the
  // watcher as an unlink/add pair and re-identified by content hash (see
  // watcher.js) — this handler just performs the fs operation.
  ipcMain.handle('move-files', async (_event, { filePaths, destDir }) => {
    const moved = [];
    for (const filePath of filePaths) {
      if (path.dirname(filePath) === destDir) continue; // already there
      const dest = uniqueDestPath(destDir, filePath);
      try {
        await fs.promises.rename(filePath, dest);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err; // cross-device: rename() can't do it, fall back to copy+delete
        await fs.promises.copyFile(filePath, dest);
        await fs.promises.unlink(filePath);
      }
      moved.push(dest);
    }
    return moved;
  });

  ipcMain.handle('copy-files', async (_event, { filePaths, destDir }) => {
    const copied = [];
    for (const filePath of filePaths) {
      const dest = uniqueDestPath(destDir, filePath);
      await fs.promises.copyFile(filePath, dest);
      copied.push(dest);
    }
    return copied;
  });

  ipcMain.handle('strip-metadata', async (_event, { filePaths, options }) => {
    const results = [];
    for (const filePath of filePaths) {
      const ext = path.extname(filePath);
      const buf = await fs.promises.readFile(filePath);
      const stripped = stripBuffer(buf, ext, options);
      if (stripped === null) {
        results.push({ filePath, skipped: true });
        continue;
      }
      if (options.keepCopy) {
        const originalsDir = path.join(path.dirname(filePath), '_originals');
        await fs.promises.mkdir(originalsDir, { recursive: true });
        const backupPath = path.join(originalsDir, path.basename(filePath));
        if (!fs.existsSync(backupPath)) await fs.promises.copyFile(filePath, backupPath);
      }
      await fs.promises.writeFile(filePath, stripped);
      results.push({ filePath, skipped: false });
    }
    return results;
  });

  // Opens the file in Affinity Photo if it's installed; otherwise falls
  // back to the OS-default handler for the file type. There's no in-app
  // preferences store yet to pin a different specific app.
  ipcMain.handle('open-in-external-editor', async (_event, filePath) => {
    if (fs.existsSync(EXTERNAL_EDITOR_APP)) {
      try {
        await new Promise((resolve, reject) => {
          execFile('open', ['-a', EXTERNAL_EDITOR_APP, filePath], (err) => (err ? reject(err) : resolve()));
        });
        return;
      } catch {
        // Fall through to the OS default handler below.
      }
    }
    const err = await shell.openPath(filePath);
    if (err) throw new Error(err);
  });

  // Lists a directory's immediate subdirectories, independent of the
  // image-only fs watcher — used to drive the folder tree's expand
  // affordance and the grid's subfolder tiles, which need to reflect real
  // filesystem structure even where there are no (tracked) images.
  ipcMain.handle('list-subfolders', async (_event, dir) => {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  });

  // Chromium's <img> can't decode TIFF at all, and neither can Electron's
  // nativeImage (verified: it returns an empty image even for a
  // sips-produced, well-formed TIFF) — so those files need a pre-rendered
  // preview. Shelling out to macOS's built-in `sips` converts (and, via
  // -Z, downsamples) to PNG in one call, with no new dependency. Everything
  // else still loads straight from disk via file:// (see fileUrl in app.js).
  // See runSips above for why this is a sync spawn.
  ipcMain.handle('get-image-preview', (_event, filePath) => runSips(filePath));

  // Remembers open tabs (root folder + current subfolder) across relaunches
  // and, since only one folder is ever actually watched at a time (see
  // startWatching), is also what a live tab switch reads back from to
  // restore where that tab was browsing.
  ipcMain.handle('load-session', async () => {
    try {
      return JSON.parse(await fs.promises.readFile(sessionPath, 'utf8'));
    } catch {
      return null;
    }
  });
  ipcMain.handle('save-session', async (_event, session) => {
    try {
      await fs.promises.writeFile(sessionPath, JSON.stringify(session));
    } catch {
      // Non-critical — worst case is losing tab restore on next launch.
    }
  });
});

app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  if (process.platform !== 'darwin') app.quit();
});
