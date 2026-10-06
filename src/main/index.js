// Must be set before any fs/hash work touches libuv's thread pool — the
// default of 4 threads bottlenecks concurrent hashing/thumbnailing well
// before CPU is actually the limit on modern machines.
process.env.UV_THREADPOOL_SIZE = String(Math.max(4, require('os').cpus().length));

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const db = require('./db');
const { createWatcher, ensureTracked } = require('./watcher');
const { stripBuffer } = require('./metadata');
const thumbnails = require('./thumbnails');
const PDFDocument = require('pdfkit');

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
  // Electron's auto-generated default menu hardcodes the "Electron" label
  // for the first (bold) item on unpackaged dev runs, ignoring
  // app.setName() — building our own template with the real name is the
  // only way to fix that outside a packaged build.
  if (process.platform === 'darwin') {
    const template = [
      {
        label: 'Retriever',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
  database = db.openDb(app.getPath('userData'));
  sessionPath = path.join(app.getPath('userData'), 'session.json');
  thumbnails.initThumbnailCache(app.getPath('userData'));
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

  ipcMain.handle('untag-file', (_event, { filePath, tagName }) => {
    const row = db.getByPath(database, filePath);
    if (!row) return { tags: [] };
    db.removeTag(database, row.id, tagName);
    return { tags: db.getTagsForFile(database, row.id) };
  });

  ipcMain.handle('get-tags', (_event, filePath) => {
    const row = db.getByPath(database, filePath);
    if (!row) return [];
    return db.getTagsForFile(database, row.id);
  });

  ipcMain.handle('get-lost-files', () => db.getLost(database));

  // Bulk tag lookup for renderer startup hydration — { path: [tagNames] }.
  ipcMain.handle('get-all-tags', () => db.getAllFileTags(database));

  ipcMain.handle('create-group', async (_event, { name, filePaths }) => {
    const ids = [];
    for (const p of filePaths) ids.push((await ensureTracked(database, p)).id);
    return db.createGroup(database, name, ids);
  });

  ipcMain.handle('delete-group', (_event, groupId) => db.deleteGroup(database, groupId));

  ipcMain.handle('add-to-group', async (_event, { groupId, filePaths }) => {
    const ids = [];
    for (const p of filePaths) ids.push((await ensureTracked(database, p)).id);
    db.addGroupMembers(database, groupId, ids);
  });

  ipcMain.handle('remove-from-group', (_event, { groupId, filePaths }) => {
    const ids = filePaths.map((p) => db.getByPath(database, p)).filter(Boolean).map((r) => r.id);
    db.removeGroupMembers(database, groupId, ids);
  });

  ipcMain.handle('get-all-groups', () => db.getAllGroups(database));

  // Preload runs sandboxed and can't require('os')/require('path') itself,
  // so the renderer asks main for these instead of reading them locally.
  ipcMain.handle('get-home-dir', () => os.homedir());

  ipcMain.handle('get-file-info', async (_event, filePath) => {
    try {
      const st = await fs.promises.stat(filePath);
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

  // Moves to the OS trash rather than unlinking outright, so a folder (or
  // file) deleted from the tree view is recoverable the same way Finder's
  // delete is.
  ipcMain.handle('trash-path', async (_event, targetPath) => {
    await shell.trashItem(targetPath);
  });

  ipcMain.handle('choose-destination-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Which of these files would collide with something already in destDir.
  // A move onto a file's own folder is a no-op, not a conflict; a copy there
  // just makes a numbered duplicate (see transferFiles), so neither is listed.
  ipcMain.handle('find-transfer-conflicts', (_event, { filePaths, destDir }) =>
    filePaths.filter((p) => path.dirname(p) !== destDir && fs.existsSync(path.join(destDir, path.basename(p)))));

  // `resolutions` maps a source path to 'replace' | 'skip' | 'keep' for files
  // that collide at the destination (see find-transfer-conflicts); anything
  // unlisted is kept alongside under a unique name. 'replace' sends the
  // existing file to the Trash rather than overwriting, so it's recoverable.
  // One file failing doesn't abort the rest — failures are reported back.
  async function transferFiles(mode, filePaths, destDir, resolutions = {}) {
    const result = { done: [], replaced: 0, renamed: 0, skipped: 0, failed: [] };
    for (const filePath of filePaths) {
      const sameDir = path.dirname(filePath) === destDir;
      if (sameDir && mode === 'move') continue; // already there
      const target = path.join(destDir, path.basename(filePath));
      const action = sameDir ? undefined : resolutions[filePath];
      try {
        if (action === 'skip' && fs.existsSync(target)) { result.skipped += 1; continue; }
        // Never trash a directory that merely shares the file's name.
        const replacing = action === 'replace' && fs.existsSync(target) && fs.statSync(target).isFile();
        if (replacing) await shell.trashItem(target);
        const dest = replacing ? target : uniqueDestPath(destDir, filePath);
        if (mode === 'copy') {
          await fs.promises.copyFile(filePath, dest);
        } else {
          try {
            await fs.promises.rename(filePath, dest);
          } catch (err) {
            if (err.code !== 'EXDEV') throw err; // cross-device: rename() can't do it, fall back to copy+delete
            await fs.promises.copyFile(filePath, dest);
            await fs.promises.unlink(filePath);
          }
        }
        result.done.push(dest);
        if (replacing) result.replaced += 1;
        else if (dest !== target) result.renamed += 1;
      } catch (err) {
        result.failed.push({ filePath, error: err.message });
      }
    }
    return result;
  }

  // Moves that land back in the currently watched root are picked up by the
  // watcher as an unlink/add pair and re-identified by content hash (see
  // watcher.js) — this handler just performs the fs operation.
  ipcMain.handle('move-files', (_event, { filePaths, destDir, resolutions }) => transferFiles('move', filePaths, destDir, resolutions));
  ipcMain.handle('copy-files', (_event, { filePaths, destDir, resolutions }) => transferFiles('copy', filePaths, destDir, resolutions));

  // Rewrites JPEG/PNG files in place with the selected metadata categories
  // removed (see metadata.js). Other formats come back `skipped: true`. With
  // `options.keepCopy`, the original is first copied to an `_originals/`
  // folder beside the file (never overwriting an existing backup).
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

  // Backs the "folder has no photos" empty state's note about files
  // Retriever doesn't read (raw/video/document siblings) — a plain
  // extension count over the folder's direct, non-image files, independent
  // of the image-only fs watcher. The exclude set mirrors the watcher's
  // IMAGE_EXTENSIONS (watcher.js).
  const NON_IMAGE_NOTE_EXCLUDE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']);
  ipcMain.handle('list-other-files', async (_event, dir) => {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const counts = {};
      for (const e of entries) {
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!ext || NON_IMAGE_NOTE_EXCLUDE.has(ext)) continue;
        counts[ext] = (counts[ext] || 0) + 1;
      }
      return Object.entries(counts).map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count);
    } catch {
      return [];
    }
  });

  // Lists a directory's immediate (non-hidden) subdirectories, independent of
  // the image-only fs watcher — used to drive the folder tree's expand
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
  // Runs on the thumbnail worker pool (spawning `sips` from Electron's main
  // process fails with EBADF, and a sync spawn here would block all IPC).
  ipcMain.handle('get-image-preview', (_event, filePath) => thumbnails.getPreviewDataUrl(filePath, PREVIEW_MAX_DIMENSION));

  // Small, downscaled, disk-cached thumbnail for grid tiles — see
  // thumbnails.js. Distinct from get-image-preview above, which produces a
  // much larger (2000px) fit-to-width preview for the full viewer/TIFFs.
  ipcMain.handle('get-thumbnail', (_event, filePath) => thumbnails.getThumbnailPath(filePath));

  // Contact sheet export: draws the selected files directly onto PDF pages
  // with pdfkit, rather than laying them out as HTML and printing that
  // through a hidden BrowserWindow's printToPDF. That approach hung
  // indefinitely on real hardware even with just 3 images and no amount of
  // window-visibility tweaking (show/opacity/off-screen positioning) fixed
  // it — see git history — which points at a Chromium/macOS-level issue
  // with printToPDF on invisible windows, not anything specific to this
  // app's content. A contact sheet's layout (a fixed grid of images plus a
  // one-line caption per cell) has no real need for a browser layout
  // engine, so this sidesteps that whole failure class.
  ipcMain.handle('export-contact-sheet', async (_event, payload) => {
    const { pages, pageWidthIn, pageHeightIn, bg, cols, rows, caption, destDir, filenameStem } = payload;
    const marginPt = 0.4 * 72;
    const gapPt = 0.08 * 72;
    const pageWidthPt = pageWidthIn * 72;
    const pageHeightPt = pageHeightIn * 72;

    const sendProgress = (progress) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('export-contact-sheet-progress', progress);
    };

    const capGapPt = 2;
    const capLineHeightPt = caption.on ? caption.size * 1.2 : 0;
    const cellWPt = (pageWidthPt - 2 * marginPt - (cols - 1) * gapPt) / cols;
    const cellHPt = (pageHeightPt - 2 * marginPt - (rows - 1) * gapPt) / rows;
    const thumbHPt = cellHPt - (caption.on ? capLineHeightPt + capGapPt : 0);

    // Reuse the grid's disk-cached thumbnail pipeline (thumbnails.js) rather
    // than decoding every full-resolution original, but at a resolution
    // sized for this sheet's actual print size instead of the grid's fixed
    // 440px tile cap — that cap was tuned for on-screen browsing, and now
    // that export doesn't need to stay fast at all costs there's no reason
    // to print, say, a 2in cell from a 440px source. Target 300ppi at the
    // cell's longer edge (whichever the image ends up bound by after
    // fit-to-box), capped at 2400px so a huge custom page size can't demand
    // an unreasonable decode. Below the grid's own cap this just reuses the
    // existing 440px cache entry — no extra work for small/dense grids.
    // Falls back to the original path if a thumbnail can't be generated
    // (getThumbnailPath resolves null rather than rejecting) so a file that
    // can't be thumbnailed still shows up instead of silently vanishing.
    const exportMaxDimension = Math.min(2400, Math.max(
      thumbnails.THUMB_MAX_DIMENSION,
      Math.round((Math.max(cellWPt, thumbHPt) / 72) * 300),
    ));
    const exportQuality = exportMaxDimension > thumbnails.THUMB_MAX_DIMENSION ? 'best' : 'normal';
    const uniquePaths = [...new Set(pages.flat().map((it) => it.path))];
    const thumbByPath = new Map();
    let resolved = 0;
    sendProgress({ stage: 'images', loaded: 0, total: uniquePaths.length });
    await Promise.all(uniquePaths.map(async (p) => {
      const thumb = await thumbnails.getThumbnailPath(p, { maxDimension: exportMaxDimension, quality: exportQuality });
      thumbByPath.set(p, thumb || p);
      resolved += 1;
      sendProgress({ stage: 'images', loaded: resolved, total: uniquePaths.length });
    }));

    const defaultName = (filenameStem || 'contact_sheet').replace(/[/\\]/g, '_') + '.pdf';
    const { canceled, filePath: chosenPath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export contact sheet',
      defaultPath: path.join(destDir, defaultName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !chosenPath) return { canceled: true };

    try {
      sendProgress({ stage: 'rendering' });

      // pdfkit has no built-in text-overflow ellipsis (the CSS version this
      // replaces relied on `text-overflow: ellipsis`) — binary-search the
      // longest prefix that still fits cellWPt, matching that clipped look.
      const truncateToWidth = (doc, text, maxWidth) => {
        if (doc.widthOfString(text) <= maxWidth) return text;
        let lo = 0, hi = text.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (doc.widthOfString(text.slice(0, mid) + '…') <= maxWidth) lo = mid; else hi = mid - 1;
        }
        return lo > 0 ? text.slice(0, lo) + '…' : '…';
      };

      await new Promise((resolvePdf, rejectPdf) => {
        const doc = new PDFDocument({ size: [pageWidthPt, pageHeightPt], margin: 0, autoFirstPage: false });
        const stream = fs.createWriteStream(chosenPath);
        stream.on('finish', resolvePdf);
        stream.on('error', rejectPdf);
        doc.on('error', rejectPdf);
        doc.pipe(stream);
        if (caption.on) doc.font('Courier');

        for (const items of pages) {
          doc.addPage({ size: [pageWidthPt, pageHeightPt], margin: 0 });
          try { doc.rect(0, 0, pageWidthPt, pageHeightPt).fill(bg); } catch { /* unparseable custom bg color — leave page white */ }
          items.forEach((it, i) => {
            const cellX = marginPt + (i % cols) * (cellWPt + gapPt);
            const cellY = marginPt + Math.floor(i / cols) * (cellHPt + gapPt);
            const src = thumbByPath.get(it.path);
            try {
              doc.image(src, cellX, cellY, { fit: [cellWPt, thumbHPt], align: 'center', valign: 'center' });
            } catch {
              // Unreadable/unsupported image for pdfkit — leave the cell blank rather than aborting the whole export.
            }
            if (caption.on) {
              const name = path.basename(it.path, path.extname(it.path));
              doc.fontSize(caption.size);
              try { doc.fillColor(caption.color); } catch { doc.fillColor('#888'); }
              doc.text(truncateToWidth(doc, name, cellWPt), cellX, cellY + thumbHPt + capGapPt, { width: cellWPt, align: 'center', lineBreak: false });
            }
          });
        }
        doc.end();
      });

      sendProgress({ stage: 'writing' });
      sendProgress({ stage: 'done' });
      return { path: chosenPath, pages: pages.length };
    } catch (err) {
      console.error('[export-contact-sheet] failed', err);
      sendProgress({ stage: 'error' });
      throw err;
    }
  });

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
  thumbnails.shutdownThumbnailWorkers();
  if (process.platform !== 'darwin') app.quit();
});
