// Runs in a worker_thread, not Electron's main process — so, unlike
// runSips() in index.js, execFileSync here doesn't hit the "spawn EBADF"
// bug (that's specific to spawning from the main process's run loop) and
// doesn't block the UI thread either way, since it's a dedicated worker.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

parentPort.on('message', ({ id, src, dest, maxDimension }) => {
  const tmpDest = path.join(os.tmpdir(), `retriever-thumb-${process.pid}-${id}.jpg`);
  try {
    execFileSync('sips', [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', 'normal',
      '-Z', String(maxDimension),
      src, '--out', tmpDest,
    ], { stdio: 'ignore' });
    fs.renameSync(tmpDest, dest);
    parentPort.postMessage({ id, ok: true });
  } catch (err) {
    fs.promises.unlink(tmpDest).catch(() => {});
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
