const chokidar = require('chokidar');
const db = require('./db');
const { hashFile, statSync } = require('./hash');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']);

function isImage(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Watches rootDir for image files and reconciles the on-disk state against
 * the hash-identity DB.
 *
 * Identity model:
 * - Untagged files are never hashed or written to the DB — they're just
 *   reported to the UI as plain filesystem entries.
 * - A file only gets a DB row once the user tags/groups it (see attachTag
 *   below), at which point it gets hashed and inserted.
 * - When a *tracked* file disappears (external move/rename/delete), its row
 *   is kept with path = NULL ("lost") rather than deleted, so tags survive.
 * - When any file appears, if its size matches a currently-lost row, we hash
 *   it and compare; a match re-points that row's path (a "recovered" move).
 *   No match means it's an unrelated new file — left untracked until tagged.
 */
function createWatcher({ rootDir, database, onEvent }) {
  const watcher = chokidar.watch(rootDir, {
    ignoreInitial: false,
    depth: undefined,
    // Dotfiles/.DS_Store churn constantly and are never images; skip them to
    // cut needless CPU/event overhead. Once a thumbnail cache directory
    // exists it must be excluded here too, or the app ends up watching its
    // own cache writes.
    ignored: /(^|[/\\])\../,
    // useFsEvents (macOS) / native backends stay on by default — polling
    // would burn CPU continuously and is only a fallback for filesystems
    // that don't support native watch events (e.g. some network mounts).
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  // db.markLost() nulls out a row's path column (that's what "lost" means
  // in the schema), so by the time handleAdd re-queries db.getLost() the
  // row's own `path` field can no longer say where it used to be. Track the
  // pre-lost path here, keyed by row id, so a matching 'add' can report a
  // real `from` in its 'moved' event instead of null.
  const lastKnownPath = new Map();

  watcher.on('add', (filePath) => handleAdd(filePath));
  watcher.on('unlink', (filePath) => handleUnlink(filePath));
  watcher.on('error', (err) => onEvent({ type: 'error', message: err.message, code: err.code }));
  watcher.on('ready', () => onEvent({ type: 'ready' }));

  async function handleAdd(filePath) {
    if (!isImage(filePath)) return;

    const { size, mtimeMs } = statSync(filePath);
    const candidates = db.getLost(database).filter((row) => row.size === size);

    for (const candidate of candidates) {
      const hash = await hashFile(filePath);
      if (hash === candidate.hash) {
        const from = lastKnownPath.get(candidate.id) ?? candidate.path;
        lastKnownPath.delete(candidate.id);
        db.reattachPath(database, hash, filePath, mtimeMs);
        onEvent({ type: 'moved', filePath, from, fileId: candidate.id });
        return;
      }
    }

    onEvent({ type: 'added', filePath, size, mtimeMs, tracked: false });
  }

  function handleUnlink(filePath) {
    if (!isImage(filePath)) return;

    const row = db.getByPath(database, filePath);
    if (row) {
      lastKnownPath.set(row.id, filePath);
      db.markLost(database, filePath);
      onEvent({ type: 'lost', filePath, fileId: row.id });
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

  const { size, mtimeMs } = statSync(filePath);
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
