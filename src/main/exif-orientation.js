// Lossless "rotation" by editing the EXIF Orientation tag (0x0112) instead of
// touching pixels — used when a pixel rotation can't be exact (JPEGs whose
// size isn't a multiple of the 16px block, multi-page or JPEG-compressed
// TIFFs). Pure JS, no dependencies; only the few bytes of the tag change
// (plus, if the file has no Orientation tag yet, a re-written copy of IFD0).
const fs = require('fs');

// Each Orientation value as the 2x2 matrix [a, b, c, d] mapping stored pixel
// coordinates to displayed ones (y down). Rotating the displayed image by θ
// is a left-multiplication, so the new tag is whichever value has the matrix
// R(θ) · M(current).
const MATS = {
  1: [1, 0, 0, 1], 2: [-1, 0, 0, 1], 3: [-1, 0, 0, -1], 4: [1, 0, 0, -1],
  5: [0, 1, 1, 0], 6: [0, -1, 1, 0], 7: [0, -1, -1, 0], 8: [0, 1, -1, 0],
};
const ROT = { 90: [0, -1, 1, 0], 180: [-1, 0, 0, -1], 270: [0, 1, -1, 0] };

// New Orientation value after rotating the displayed image `degrees` clockwise.
function composeOrientation(current, degrees) {
  const [a, b, c, d] = MATS[current] || MATS[1];
  const [r0, r1, r2, r3] = ROT[degrees];
  const m = [r0 * a + r1 * c, r0 * b + r1 * d, r2 * a + r3 * c, r2 * b + r3 * d];
  return Number(Object.keys(MATS).find((k) => MATS[k].every((v, i) => v === m[i])));
}

function byteOrder(buf, t) {
  const le = buf.toString('latin1', t, t + 2) === 'II';
  return {
    le,
    r16: (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)),
    r32: (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)),
    w16: (b, o, v) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o)),
    w32: (b, o, v) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o)),
  };
}

// A 12-byte IFD entry: Orientation, SHORT, count 1.
function orientationEntry(bo, value) {
  const e = Buffer.alloc(12);
  bo.w16(e, 0, 0x0112);
  bo.w16(e, 2, 3);
  bo.w32(e, 4, 1);
  bo.w16(e, 8, value);
  return e;
}

// ---------- JPEG ----------

// Orientation (1-8) stored in a JPEG's EXIF, or 1 when absent/unparseable.
function readJpegOrientation(buf) {
  try {
    if (buf.readUInt16BE(0) !== 0xffd8) return 1;
    let off = 2;
    while (off + 4 < buf.length && buf[off] === 0xff) {
      const marker = buf[off + 1];
      if (marker === 0xda) break;
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
        const t = off + 10;
        const bo = byteOrder(buf, t);
        const ifd = t + bo.r32(t + 4);
        const count = bo.r16(ifd);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (bo.r16(e) === 0x0112) return bo.r16(e + 8) || 1;
        }
        return 1;
      }
      off += 2 + len;
    }
  } catch { /* fall through */ }
  return 1;
}

// Returns a new TIFF block (the part of APP1 after "Exif\0\0") with
// Orientation set to `value`.
function patchExifTiff(tiff, value) {
  const bo = byteOrder(tiff, 0);
  const t = Buffer.from(tiff);
  const ifd = bo.r32(4);
  const count = bo.r16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (bo.r16(e) === 0x0112) {
      orientationEntry(bo, value).copy(t, e);
      return t;
    }
  }
  // No Orientation tag: append a copy of IFD0 with the new entry (kept in tag
  // order). Existing entries only hold absolute TIFF offsets, so they stay valid.
  const entries = [];
  for (let i = 0; i < count; i++) entries.push(t.subarray(ifd + 2 + i * 12, ifd + 14 + i * 12));
  const at = entries.findIndex((e) => (bo.le ? e.readUInt16LE(0) : e.readUInt16BE(0)) > 0x0112);
  entries.splice(at === -1 ? entries.length : at, 0, orientationEntry(bo, value));
  const pad = t.length % 2;
  const nb = Buffer.alloc(pad + 2 + entries.length * 12 + 4);
  bo.w16(nb, pad, entries.length);
  entries.forEach((e, i) => e.copy(nb, pad + 2 + i * 12));
  bo.w32(nb, pad + 2 + entries.length * 12, bo.r32(ifd + 2 + count * 12));
  const out = Buffer.concat([t, nb]);
  bo.w32(out, 4, t.length + pad);
  return out;
}

// Returns a new JPEG buffer whose EXIF Orientation is `value`; every other
// byte (entropy-coded data included) is untouched.
function setJpegOrientation(buf, value) {
  if (buf.readUInt16BE(0) !== 0xffd8) throw new Error('Not a JPEG');
  let off = 2;
  let insertAt = 2; // after SOI, and after a JFIF APP0 if there is one
  while (off + 4 <= buf.length && buf[off] === 0xff) {
    const marker = buf[off + 1];
    if (marker === 0xda) break;
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe0) insertAt = off + 2 + len;
    if (marker === 0xe1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
      const tiff = patchExifTiff(buf.subarray(off + 10, off + 2 + len), value);
      return spliceApp1(buf, off, off + 2 + len, tiff);
    }
    off += 2 + len;
  }
  const bo = byteOrder(Buffer.from('II'), 0);
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  orientationEntry(bo, value).copy(tiff, 10);
  return spliceApp1(buf, insertAt, insertAt, tiff);
}

function spliceApp1(buf, from, to, tiff) {
  const segLen = 2 + 6 + tiff.length;
  if (segLen > 0xffff) throw new Error('EXIF block too large to edit');
  const head = Buffer.alloc(10);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(segLen, 2);
  head.write('Exif\0\0', 4, 'latin1');
  return Buffer.concat([buf.subarray(0, from), head, tiff, buf.subarray(to)]);
}

// ---------- TIFF (edited in place, every page) ----------

// Rotates `degrees` clockwise by editing Orientation in each IFD of a classic
// TIFF. Only the tag's bytes change; a page lacking the tag gets a copy of its
// IFD appended at the end of the file (pixel data is never moved).
function rotateTiffByTag(filePath, degrees) {
  const fd = fs.openSync(filePath, 'r+');
  try {
    const read = (pos, len) => {
      const b = Buffer.alloc(len);
      if (fs.readSync(fd, b, 0, len, pos) !== len) throw new Error('Unreadable TIFF');
      return b;
    };
    const write = (b, pos) => fs.writeSync(fd, b, 0, b.length, pos);
    const head = read(0, 8);
    const bo = byteOrder(head, 0);
    const r16 = (b, o) => (bo.le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const r32 = (b, o) => (bo.le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    if (r16(head, 2) !== 42) throw new Error('Unsupported TIFF layout');
    let fileEnd = fs.fstatSync(fd).size;
    let ptrPos = 4; // where the offset of the IFD we're about to visit is stored
    let ifd = r32(head, 4);
    let pages = 0;
    while (ifd && pages < 64) {
      const count = r16(read(ifd, 2), 0);
      const body = read(ifd + 2, count * 12 + 4);
      const next = r32(body, count * 12);
      let found = -1;
      for (let i = 0; i < count; i++) if (r16(body, i * 12) === 0x0112) found = i;
      if (found !== -1) {
        const current = r16(body, found * 12 + 8) || 1;
        write(orientationEntry(bo, composeOrientation(current, degrees)), ifd + 2 + found * 12);
        ptrPos = ifd + 2 + count * 12;
      } else {
        const entries = [];
        for (let i = 0; i < count; i++) entries.push(body.subarray(i * 12, i * 12 + 12));
        const at = entries.findIndex((e) => r16(e, 0) > 0x0112);
        entries.splice(at === -1 ? entries.length : at, 0, orientationEntry(bo, composeOrientation(1, degrees)));
        const pos = fileEnd + (fileEnd % 2);
        const nb = Buffer.alloc(2 + entries.length * 12 + 4);
        bo.w16(nb, 0, entries.length);
        entries.forEach((e, i) => e.copy(nb, 2 + i * 12));
        bo.w32(nb, 2 + entries.length * 12, next);
        write(nb, pos);
        const p = Buffer.alloc(4);
        bo.w32(p, 0, pos);
        write(p, ptrPos); // single small write last: re-points the chain
        fileEnd = pos + nb.length;
        ptrPos = pos + 2 + entries.length * 12;
      }
      ifd = next;
      pages += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { composeOrientation, readJpegOrientation, setJpegOrientation, rotateTiffByTag };
