// Main-process side of on-disk rotation: hands a batch to a one-shot
// rotate-worker.js (rotations are rare, so no pool) and resolves with its
// per-file results. See rotate-worker.js for why this isn't done inline.
const { Worker } = require('worker_threads');
const path = require('path');

function rotateFiles(items) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'rotate-worker.js'));
    worker.once('message', ({ results }) => { resolve(results); worker.terminate(); });
    worker.once('error', reject);
    worker.postMessage({ items });
  });
}

module.exports = { rotateFiles };
