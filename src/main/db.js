const path = require('path');
const Database = require('better-sqlite3');

// The DB only ever holds rows for files the user has actually tagged or
// grouped. Untagged files are never inserted, so this stays small no matter
// how large the on-disk library is.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY,
  hash       TEXT UNIQUE NOT NULL,
  path       TEXT UNIQUE,          -- NULL when the file is currently missing (deleted or mid-move)
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  lost_at    INTEGER               -- set when path goes NULL, cleared when re-matched
);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS file_tags (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id   INTEGER PRIMARY KEY,
  name TEXT
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (group_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
`;

function openDb(userDataDir) {
  const dbPath = path.join(userDataDir, 'retriever.sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// --- queries -----------------------------------------------------------

function getByPath(db, filePath) {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(filePath);
}

function getByHash(db, hash) {
  return db.prepare('SELECT * FROM files WHERE hash = ?').get(hash);
}

function getLost(db) {
  return db.prepare('SELECT * FROM files WHERE path IS NULL').all();
}

function insertFile(db, { hash, filePath, size, mtimeMs }) {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO files (hash, path, size, mtime_ms, created_at)
       VALUES (@hash, @filePath, @size, @mtimeMs, @now)`
    )
    .run({ hash, filePath, size, mtimeMs, now });
  return getByHash(db, hash);
}

function markLost(db, filePath) {
  db.prepare('UPDATE files SET path = NULL, lost_at = ? WHERE path = ?').run(
    Date.now(),
    filePath
  );
}

function reattachPath(db, hash, newPath, mtimeMs) {
  db.prepare(
    'UPDATE files SET path = ?, mtime_ms = ?, lost_at = NULL WHERE hash = ?'
  ).run(newPath, mtimeMs, hash);
}

function deleteFile(db, fileId) {
  db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
}

function addTag(db, fileId, tagName) {
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tagName);
  const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
  db.prepare(
    'INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)'
  ).run(fileId, tag.id);
}

function clearTags(db, fileId) {
  db.prepare('DELETE FROM file_tags WHERE file_id = ?').run(fileId);
}

function getTagsForFile(db, fileId) {
  return db
    .prepare(
      `SELECT tags.name FROM tags
       JOIN file_tags ON file_tags.tag_id = tags.id
       WHERE file_tags.file_id = ?`
    )
    .all(fileId)
    .map((r) => r.name);
}

// Every currently-present tracked file and its tags, as { path: [names] }.
// One query so the renderer can hydrate tags on startup without a per-file
// IPC round-trip (see the renderer performance guardrails in CLAUDE.md).
function getAllFileTags(db) {
  const rows = db
    .prepare(
      `SELECT files.path AS path, tags.name AS name
       FROM file_tags
       JOIN files ON files.id = file_tags.file_id
       JOIN tags  ON tags.id  = file_tags.tag_id
       WHERE files.path IS NOT NULL`
    )
    .all();
  const map = {};
  for (const r of rows) (map[r.path] || (map[r.path] = [])).push(r.name);
  return map;
}

module.exports = {
  openDb,
  getByPath,
  getByHash,
  getLost,
  insertFile,
  markLost,
  reattachPath,
  deleteFile,
  addTag,
  clearTags,
  getTagsForFile,
  getAllFileTags,
};
