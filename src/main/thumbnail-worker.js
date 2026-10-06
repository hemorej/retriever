// Runs in a worker_thread, not Electron's main process — spawning `sips`
// from the main process fails with "spawn EBADF" (a quirk of its run loop),
// and a synchronous spawn there would block all IPC. Here execFileSync works
// and only blocks this dedicated worker.
//
// Message in:  { id, src, dest, maxDimension, quality?, format? }
//   format is 'jpeg' (default; grid thumbnails and contact-sheet images, with
//   `quality` passed to sips' formatOptions) or 'png' (TIFF previews).
// Message out: { id, ok: true } or { id, ok: false, error }
// Output goes to a temp file and is renamed onto `dest`, so a half-written
// file is never visible at the cache path.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

parentPort.on('message', ({ id, src, dest, maxDimension, quality, format = 'jpeg' }) => {
  const tmpDest = path.join(os.tmpdir(), `retriever-thumb-${process.pid}-${id}.${format === 'png' ? 'png' : 'jpg'}`);
  try {
    const args = ['-s', 'format', format];
    if (format === 'jpeg') args.push('-s', 'formatOptions', quality || 'normal');
    args.push('-Z', String(maxDimension), src, '--out', tmpDest);
    execFileSync('sips', args, { stdio: 'ignore' });
    fs.renameSync(tmpDest, dest);
    parentPort.postMessage({ id, ok: true });
  } catch (err) {
    fs.promises.unlink(tmpDest).catch(() => {});
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
