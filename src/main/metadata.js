// Pure-JS metadata stripping for the two formats this app actually sees in
// practice (JPEG, PNG). Both formats are simple enough (a flat sequence of
// length-prefixed segments/chunks) that surgical removal doesn't need a
// dependency — we just drop the segments/chunks that carry the metadata
// categories the cleanup dialog offers, and copy the rest of the file
// (including all pixel data) through untouched.
//
// JPEG note: the embedded thumbnail (if any) lives inside the same APP1
// segment as the rest of the EXIF IFD, so "embedded thumbnails" can only be
// stripped independently of EXIF/GPS by re-parsing the TIFF IFD — out of
// scope here. In this pass, checking EXIF and/or GPS removes the whole APP1
// segment (thumbnail included); checking only "thumbnails" with EXIF/GPS
// unchecked is a no-op.

function stripJpeg(buf, opts) {
  if (buf.readUInt16BE(0) !== 0xffd8) return buf; // not a JPEG we can parse safely
  const out = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  const removeApp1 = opts.exif || opts.gps;
  while (offset < buf.length - 1) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    // SOS (start of scan) — everything after this is entropy-coded image
    // data with no more markers to parse; copy the remainder verbatim.
    if (marker === 0xda) {
      out.push(buf.subarray(offset));
      break;
    }
    // Markers with no length/payload (standalone).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(buf.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2); // includes the 2 length bytes, not the marker
    const segEnd = offset + 2 + segLen;
    const payload = buf.subarray(offset + 4, segEnd);
    // APP1 carries both Exif and (separately) XMP packets — only drop the
    // Exif ones; an XMP packet's payload starts with its namespace URI, not "Exif\0\0".
    const dropExifApp1 = marker === 0xe1 && removeApp1 && payload.slice(0, 6).toString('latin1') === 'Exif\0\0';
    const dropIptcApp13 = marker === 0xed && opts.iptc; // Photoshop IRB / IPTC
    const dropIccApp2 = marker === 0xe2 && opts.icc && payload.slice(0, 11).toString('latin1') === 'ICC_PROFILE';
    if (!(dropExifApp1 || dropIptcApp13 || dropIccApp2)) out.push(buf.subarray(offset, segEnd));
    offset = segEnd;
  }
  return Buffer.concat(out);
}

function stripPng(buf, opts) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return buf; // not a PNG
  const DROP_ALWAYS = new Set(['tEXt', 'zTXt', 'iTXt']); // IPTC/XMP/free-text is usually carried here
  const out = [buf.subarray(0, 8)];
  let offset = 8;
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + len; // length(4) + type(4) + data(len) + crc(4)
    let drop = false;
    if (type === 'eXIf' && (opts.exif || opts.gps)) drop = true;
    else if (type === 'iCCP' && opts.icc) drop = true;
    else if (DROP_ALWAYS.has(type) && (opts.iptc || opts.exif)) drop = true;
    if (!drop) out.push(buf.subarray(offset, chunkEnd));
    offset = chunkEnd;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

const STRIPPERS = {
  '.jpg': stripJpeg, '.jpeg': stripJpeg,
  '.png': stripPng,
};

function stripBuffer(buf, ext, opts) {
  const strip = STRIPPERS[ext.toLowerCase()];
  return strip ? strip(buf, opts) : null; // null = format not supported in this pass
}

module.exports = { stripBuffer };
