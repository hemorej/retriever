const fs = require('fs');
const { createXXHash64 } = require('hash-wasm');

// Identity hashing, not security — xxhash64 streamed over the whole file.
// Fine for photo-sized files; if the library ever includes huge originals,
// swap in a cheap first/last-N-KB signature as a pre-filter before this.
async function hashFile(filePath) {
  const hasher = await createXXHash64();
  hasher.init();

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return hasher.digest('hex');
}

function statSync(filePath) {
  const st = fs.statSync(filePath);
  return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

module.exports = { hashFile, statSync };
