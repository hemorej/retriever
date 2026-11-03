// Runs in a worker_thread (see rotate.js) — same reason as thumbnail-worker.js:
// spawning child processes from Electron's main process is unreliable
// ("spawn EBADF") and a sync spawn there would block all IPC.
//
// Rotates image files on disk without lossy re-encoding:
//   - JPEG       -> `jpegtran -rotate` (lossless DCT-block transform, EXIF kept)
//   - PNG / TIFF -> `sips -r` (pixel data is re-written, never re-quantised)
// Where no exact pixel rotation exists — JPEGs whose size isn't a multiple of
// the block size, multi-page or JPEG-compressed TIFFs — the EXIF Orientation
// tag is edited instead (exif-orientation.js; result `method: 'tag'`).
// Anything else (WebP, BigTIFF) is refused rather than silently degraded.
//
// Message in:  { items: [{ filePath, degrees }] }   degrees: clockwise 90/180/270
// Message out: { results: [{ filePath, ok, method?: 'pixels'|'tag', error? }] }
const { parentPort } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { composeOrientation, readJpegOrientation, setJpegOrientation, rotateTiffByTag } = require('./exif-orientation');

const JPEGTRAN_CANDIDATES = ['/opt/homebrew/bin/jpegtran', '/usr/local/bin/jpegtran', '/opt/homebrew/opt/jpeg-turbo/bin/jpegtran', '/usr/local/opt/jpeg-turbo/bin/jpegtran'];

function findJpegtran() {
  return JPEGTRAN_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function readHead(filePath, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Inspects a classic TIFF: page count and first-page compression. Returns
// { pages, compression } or null if the structure isn't understood
// (e.g. BigTIFF), which callers treat as "don't touch".
function inspectTiff(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const read = (pos, len) => {
        const b = Buffer.alloc(len);
        if (fs.readSync(fd, b, 0, len, pos) !== len) throw new Error('short read');
        return b;
      };
      const head = read(0, 8);
      const le = head.toString('latin1', 0, 2) === 'II';
      const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
      const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
      if (u16(head, 2) !== 42) return null;
      let ifd = u32(head, 4);
      let pages = 0;
      let compression = 1;
      while (ifd && pages < 64) {
        const count = u16(read(ifd, 2), 0);
        const body = read(ifd + 2, count * 12 + 4);
        if (pages === 0) {
          for (let i = 0; i < count; i++) if (u16(body, i * 12) === 259) compression = u16(body, i * 12 + 8);
        }
        pages += 1;
        ifd = u32(body, count * 12);
      }
      return { pages, compression };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

let tmpCounter = 0;

function rotateOne(filePath, degrees) {
  if (![90, 180, 270].includes(degrees)) throw new Error('Rotation must be 90, 180 or 270°');
  const ext = path.extname(filePath).toLowerCase();
  const tmp = path.join(os.tmpdir(), `retriever-rotate-${process.pid}-${++tmpCounter}${ext}`);
  let method = 'pixels';
  try {
    if (ext === '.jpg' || ext === '.jpeg') {
      const bin = findJpegtran();
      if (!bin) throw new Error('jpegtran not found — install it with: brew install jpeg-turbo');
      // The CSS preview rotates the *displayed* image (EXIF orientation already
      // applied). jpegtran rotates the raw pixels and leaves the Orientation
      // tag alone, so for mirrored orientations the raw rotation is inverted.
      const orientation = readJpegOrientation(readHead(filePath, 70000)); // EXIF lives in the first 64KB
      const mirrored = [2, 4, 5, 7].includes(orientation);
      const raw = mirrored ? (360 - degrees) % 360 : degrees;
      try {
        execFileSync(bin, ['-rotate', String(raw), '-perfect', '-copy', 'all', '-outfile', tmp, filePath], { stdio: 'ignore' });
      } catch {
        // Dimensions aren't a multiple of the block size, so no perfect pixel
        // rotation exists. Flip the EXIF Orientation tag instead — exact, and
        // every pixel is kept.
        fs.writeFileSync(filePath, setJpegOrientation(fs.readFileSync(filePath), composeOrientation(orientation, degrees)));
        return { method: 'tag' };
      }
    } else if (ext === '.png' || ext === '.tif' || ext === '.tiff') {
      if (ext !== '.png') {
        const info = inspectTiff(filePath);
        if (!info) throw new Error('Unsupported TIFF layout — not rotated');
        // sips would drop extra pages / re-encode JPEG-in-TIFF: use the tag.
        if (info.pages > 1 || info.compression === 6 || info.compression === 7) {
          rotateTiffByTag(filePath, degrees);
          return { method: 'tag' };
        }
      }
      execFileSync('sips', ['-r', String(degrees), filePath, '--out', tmp], { stdio: 'ignore' });
    } else {
      throw new Error(`${ext || 'This format'} can't be rotated losslessly — not rotated`);
    }

    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error('Rotation produced no output');
    // Overwrite in place (not rename) so the inode, Finder tags/xattrs and
    // creation date of the original survive.
    fs.writeFileSync(filePath, fs.readFileSync(tmp));
    return { method };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

parentPort.on('message', ({ items }) => {
  const results = items.map(({ filePath, degrees }) => {
    try {
      return { filePath, ok: true, ...rotateOne(filePath, degrees) };
    } catch (err) {
      return { filePath, ok: false, error: err.message.split('\n')[0] };
    }
  });
  parentPort.postMessage({ results });
});
