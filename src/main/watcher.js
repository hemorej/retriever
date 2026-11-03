const fs = require('fs');
const chokidar = require('chokidar');
const db = require('./db');
const { hashFile, statAsync } = require('./hash');

const DOTFILE = /(^|[/\\])\../;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']);

// Case-insensitive extension check against IMAGE_EXTENSIONS. Keep in sync with
// NON_IMAGE_NOTE_EXCLUDE in main/index.js, which must list the same set.
function isImage(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Watches rootDir for image files and reconciles the on-disk state against
 * the hash-identity DB.
 *
 * Emits normalized events through `onEvent`:
 *   { type: 'added',   filePath, size, mtimeMs, tracked: false }
 *   { type: 'changed', filePath, size, mtimeMs }
 *   { type: 'removed', filePath, tracked: false }   — untracked file deleted
 *   { type: 'lost',    filePath, fileId }           — tracked file deleted
 *   { type: 'moved',   filePath, from, fileId }     — new file matched a lost row
 *   { type: 'ready' }                               — initial scan finished
 *   { type: 'error',   message, code }
 *
 * Identity model:
 * - Untagged files are never hashed or written to the DB — they're just
 *   reported to the UI as plain filesystem entries.
 * - A file only gets a DB row once the user tags/groups it (see
 *   ensureTracked below), at which point it gets hashed and inserted.
 * - When a *tracked* file disappears (external move/rename/delete), its row
 *   is kept with path = NULL ("lost") rather than deleted, so tags survive.
 * - When any file appears, if its size matches a currently-lost row, we hash
 *   it and compare; a match re-points that row's path (a "recovered" move).
 *   No match means it's an unrelated new file — left untracked until tagged.
 */
// Max concurrent full-file hashes. When a lost row exists, every same-size
// file the scan sees is hashed; unbounded, that is hundreds of simultaneous
// read streams (EMFILE) racing 'ready'.
const MAX_CONCURRENT_HASHES = 4;

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

function createWatcher({ rootDir, database, onEvent: emit }) {
  // Once closed (tab switch / rescan), in-flight async handlers must not leak
  // events from the old root into the new one.
  let closed = false;
  const onEvent = (evt) => { if (!closed) emit(evt); };
  const limitHash = createLimiter(MAX_CONCURRENT_HASHES);
  const pending = new Set(); // in-flight handleAdd promises; 'ready' waits on them

  const watcher = chokidar.watch(rootDir, {
    ignoreInitial: false,
    depth: undefined,
    // Dotfiles/.DS_Store churn constantly and are never images; skip them to
    // cut needless CPU/event overhead. (The thumbnail cache lives in
    // userData, outside any normally-watched root, so it needs no exclusion
    // here — but watching a root that contains userData would pick up its
    // own cache writes.)
    // Non-image files (raw/video/documents) are skipped here so they never
    // become events at all; `stats` is undefined on chokidar's first probe of
    // a path, in which case it's left alone (it may be a directory).
    ignored: (p, stats) => DOTFILE.test(p) || !!(stats && stats.isFile() && !isImage(p)),
    // Hand 'add'/'change' the stats chokidar already collected instead of
    // stat-ing every file a second time during the initial scan.
    alwaysStat: true,
    // useFsEvents (macOS) / native backends stay on by default — polling
    // would burn CPU continuously and is only a fallback for filesystems
    // that don't support native watch events (e.g. some network mounts).
    // awaitWriteFinish is deliberately off: it stat-polls every file (the
    // initial scan included) and delays each 'add' by its stability window.
    // Nothing here reads file contents on add, and a file still being written
    // is corrected by the 'change' handler below.
  });

  // db.markLost() nulls out a row's path column (that's what "lost" means
  // in the schema), so by the time handleAdd re-queries db.getLost() the
  // row's own `path` field can no longer say where it used to be. Track the
  // pre-lost path here, keyed by row id, so a matching 'add' can report a
  // real `from` in its 'moved' event instead of null.
  const lastKnownPath = new Map();

  // A rename of a tracked file can reach us as add(new) BEFORE unlink(old).
  // At add time nothing is lost yet, so the new path is reported as a plain
  // untracked file; remember such adds briefly so handleUnlink can pair them.
  const RECENT_ADD_MS = 30000;
  const recentAdds = new Map(); // filePath -> { size, mtimeMs, at }

  const origClose = watcher.close.bind(watcher);
  watcher.close = () => { closed = true; return origClose(); };

  watcher.on('add', (filePath, stats) => {
    const p = handleAdd(filePath, stats)
      .catch((err) => console.error('[watcher] handleAdd failed for', filePath, err))
      .finally(() => pending.delete(p));
    pending.add(p);
  });
  watcher.on('change', (filePath, stats) => handleChange(filePath, stats));
  watcher.on('unlink', (filePath) => handleUnlink(filePath));
  watcher.on('error', (err) => onEvent({ type: 'error', message: err.message, code: err.code }));
  watcher.on('ready', async () => {
    // Hash-matching adds finish after chokidar's scan does; hold 'ready' until
    // they've reported so the renderer doesn't prune seeded tiles whose
    // 'added' is merely late.
    while (pending.size && !closed) await Promise.allSettled([...pending]);
    if (closed) return;
    try { reconcileMissing(); } catch (err) { console.error('[watcher] reconcile failed', err); }
    onEvent({ type: 'ready' });
  });

  // Tracked rows under rootDir whose file is gone but whose unlink we never
  // saw (missed/coalesced fs event): mark them lost so they stop shadowing.
  function reconcileMissing() {
    const prefix = rootDir.endsWith('/') ? rootDir : rootDir + '/';
    for (const row of db.getTrackedUnder(database, prefix)) {
      if (!fs.existsSync(row.path)) {
        lastKnownPath.set(row.id, row.path);
        db.markLost(database, row.path);
        onEvent({ type: 'lost', filePath: row.path, fileId: row.id });
      }
    }
  }

  async function handleAdd(filePath, stats) {
    if (!isImage(filePath)) return;

    let size, mtimeMs;
    try {
      ({ size, mtimeMs } = stats ? { size: stats.size, mtimeMs: Math.round(stats.mtimeMs) } : await statAsync(filePath));
    } catch {
      return; // vanished between the event and the stat; unlink will follow
    }
    const candidates = db.getLostBySize(database, size);

    // A hash failure (file mid-write, EMFILE, vanished) must never swallow the
    // file: fall through and report it as a plain added file.
    let hash = null;
    if (candidates.length) {
      try { hash = await limitHash(() => hashFile(filePath)); } catch { hash = null; }
    }
    if (closed) return;
    for (const candidate of candidates) {
      if (hash !== null && hash === candidate.hash) {
        const from = lastKnownPath.get(candidate.id) ?? candidate.path;
        lastKnownPath.delete(candidate.id);
        db.reattachPath(database, hash, filePath, mtimeMs);
        onEvent({ type: 'moved', filePath, from, fileId: candidate.id, tags: db.getTagsForFile(database, candidate.id) });
        return;
      }
    }

    const now = Date.now();
    for (const [p, r] of recentAdds) if (now - r.at > RECENT_ADD_MS) recentAdds.delete(p);
    recentAdds.set(filePath, { size, mtimeMs, at: now });
    onEvent({ type: 'added', filePath, size, mtimeMs, tracked: false });
  }

  // Unlink-after-add half of a rename: find a just-reported untracked file with
  // the same content and re-attach the lost row (and its tags) to it.
  async function rematchRecentAdd(row, oldPath) {
    for (const [newPath, r] of recentAdds) {
      if (r.size !== row.size || newPath === oldPath) continue;
      let hash;
      try { hash = await limitHash(() => hashFile(newPath)); } catch { continue; }
      if (closed) return;
      if (hash !== row.hash || db.getByPath(database, newPath)) continue;
      recentAdds.delete(newPath);
      lastKnownPath.delete(row.id);
      db.reattachPath(database, row.hash, newPath, r.mtimeMs);
      onEvent({ type: 'moved', filePath: newPath, from: oldPath, fileId: row.id, tags: db.getTagsForFile(database, row.id) });
      return;
    }
  }

  async function handleChange(filePath, stats) {
    if (!isImage(filePath)) return;
    try {
      const { size, mtimeMs } = stats ? { size: stats.size, mtimeMs: Math.round(stats.mtimeMs) } : await statAsync(filePath);
      onEvent({ type: 'changed', filePath, size, mtimeMs });
    } catch {
      // Gone again; the unlink event covers it.
    }
  }

  function handleUnlink(filePath) {
    if (!isImage(filePath)) return;

    recentAdds.delete(filePath);
    const row = db.getByPath(database, filePath);
    if (row) {
      lastKnownPath.set(row.id, filePath);
      db.markLost(database, filePath);
      onEvent({ type: 'lost', filePath, fileId: row.id });
      rematchRecentAdd(row, filePath).catch((err) => console.error('[watcher] rematch failed', err));
    } else {
      onEvent({ type: 'removed', filePath, tracked: false });
    }
  }

  return watcher;
}

// Called when the user tags/groups a file that doesn't have a DB row yet.
// This is the only place a file gets hashed proactively.
async function ensureTracked(database, filePath) {
  const existing = db.getByPath(database, filePath);
  if (existing) return existing;

  const { size, mtimeMs } = await statAsync(filePath);
  const hash = await hashFile(filePath);

  const byHash = db.getByHash(database, hash);
  if (byHash) {
    // Same content already tracked under another (lost) path — re-point it.
    db.reattachPath(database, hash, filePath, mtimeMs);
    return db.getByHash(database, hash);
  }

  return db.insertFile(database, { hash, filePath, size, mtimeMs });
}

module.exports = { createWatcher, ensureTracked, isImage };
