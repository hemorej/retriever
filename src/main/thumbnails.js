const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const THUMB_MAX_DIMENSION = 440; // covers the 220px tile-size slider max at 2x for retina
const PRUNE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const POOL_SIZE = Math.min(4, Math.max(1, os.cpus().length));

let cacheDir = null;

// Cache key is path+size+mtime, not the xxhash content hash used for tag
// identity in hash.js — hashing full file contents just to serve a thumbnail
// would defeat the point of never touching untagged files' bytes. A file
// edited in place gets a new key (new mtime/size); stale entries are swept
// by prunePastAge() below rather than tracked/deleted precisely.
function cacheKeyFor(filePath, size, mtimeMs) {
  return crypto.createHash('sha1').update(`${filePath}:${size}:${mtimeMs}`).digest('hex');
}

function prunePastAge() {
  fs.promises.readdir(cacheDir).then(async (names) => {
    const now = Date.now();
    await Promise.all(names.map(async (name) => {
      const p = path.join(cacheDir, name);
      try {
        const st = await fs.promises.stat(p);
        if (now - st.mtimeMs > PRUNE_MAX_AGE_MS) await fs.promises.unlink(p);
      } catch {
        // Already gone or racing another prune — fine either way.
      }
    }));
  }).catch(() => {});
}

function initThumbnailCache(userDataDir) {
  cacheDir = path.join(userDataDir, 'thumbnails');
  fs.mkdirSync(cacheDir, { recursive: true });
  prunePastAge();
}

// --- worker pool ---------------------------------------------------------
// Generation runs in worker_threads, not on this (main) process: the
// execFileSync-blocks-main-process constraint documented in index.js's
// runSips() is specific to spawning from Electron's main-process run loop —
// plain Node worker threads don't hit that bug and, being dedicated threads,
// blocking them doesn't block the UI either way.

const pool = []; // { worker, busy, currentJobId }
const jobQueue = []; // { id, src, dest, maxDimension }
const jobCallbacks = new Map(); // id -> { resolve, reject }
const pending = new Map(); // cacheKey -> in-flight/queued Promise<string|null>
let jobIdCounter = 0;

function spawnWorker() {
  const worker = new Worker(path.join(__dirname, 'thumbnail-worker.js'));
  const entry = { worker, busy: false, currentJobId: null };
  worker.on('message', ({ id, ok, error }) => {
    const cb = jobCallbacks.get(id);
    jobCallbacks.delete(id);
    entry.busy = false;
    entry.currentJobId = null;
    if (cb) { if (ok) cb.resolve(); else cb.reject(new Error(error)); }
    pump();
  });
  worker.on('error', () => {
    if (entry.currentJobId != null) {
      const cb = jobCallbacks.get(entry.currentJobId);
      jobCallbacks.delete(entry.currentJobId);
      if (cb) cb.reject(new Error('thumbnail worker crashed'));
    }
    pool.splice(pool.indexOf(entry), 1);
    pump();
  });
  return entry;
}

function pump() {
  if (jobQueue.length === 0) return;
  let entry = pool.find((e) => !e.busy);
  if (!entry) {
    if (pool.length >= POOL_SIZE) return;
    entry = spawnWorker();
    pool.push(entry);
  }
  const job = jobQueue.shift();
  entry.busy = true;
  entry.currentJobId = job.id;
  entry.worker.postMessage(job);
}

function shutdownThumbnailWorkers() {
  for (const { worker } of pool) worker.terminate().catch(() => {});
  pool.length = 0;
}

// Returns a path to a cached, downscaled thumbnail for filePath — from disk
// immediately if already generated, otherwise once the worker pool finishes
// generating it. Resolves to null (not a rejection) on generation failure,
// so callers can treat "no thumbnail" uniformly without a catch.
function getThumbnailPath(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return Promise.resolve(null);
  }
  const key = cacheKeyFor(filePath, st.size, Math.round(st.mtimeMs));
  const dest = path.join(cacheDir, `${key}.jpg`);

  if (fs.existsSync(dest)) return Promise.resolve(dest);
  if (pending.has(key)) return pending.get(key);

  const id = ++jobIdCounter;
  const promise = new Promise((resolve) => {
    jobCallbacks.set(id, {
      resolve: () => resolve(dest),
      reject: () => resolve(null),
    });
  }).finally(() => pending.delete(key));

  pending.set(key, promise);
  jobQueue.push({ id, src: filePath, dest, maxDimension: THUMB_MAX_DIMENSION });
  pump();

  return promise;
}

module.exports = { initThumbnailCache, getThumbnailPath, shutdownThumbnailWorkers };
