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

// Opens (creating if needed) retriever.sqlite3 in userDataDir with WAL and
// foreign keys on, and applies SCHEMA. Returns the better-sqlite3 handle that
// every query below takes as its first argument.
function openDb(userDataDir) {
  const dbPath = path.join(userDataDir, 'retriever.sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// --- queries -----------------------------------------------------------

// Row for a currently-present file at filePath, or undefined if untracked.
function getByPath(db, filePath) {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(filePath);
}

// Row for a content hash, whether its file is present or lost.
function getByHash(db, hash) {
  return db.prepare('SELECT * FROM files WHERE hash = ?').get(hash);
}

// Same as getLost() filtered to one size, in SQL — called once per file the
// watcher sees, so it can't afford to load and filter every lost row in JS.
const lostBySizeStmts = new WeakMap();
function getLostBySize(db, size) {
  let stmt = lostBySizeStmts.get(db);
  if (!stmt) {
    stmt = db.prepare('SELECT * FROM files WHERE path IS NULL AND size = ?');
    lostBySizeStmts.set(db, stmt);
  }
  return stmt.all(size);
}

// Every tracked file whose path is currently NULL (missing from disk).
function getLost(db) {
  return db.prepare('SELECT * FROM files WHERE path IS NULL').all();
}

// Starts tracking a file (called only via ensureTracked in watcher.js).
// Returns the new row.
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

// Marks the row at filePath as lost: path -> NULL, lost_at -> now. The row
// (and its tags/group membership) is kept so a later move can re-attach it.
function markLost(db, filePath) {
  db.prepare('UPDATE files SET path = NULL, lost_at = ? WHERE path = ?').run(
    Date.now(),
    filePath
  );
}

// Points the row with this hash at newPath and clears its lost state.
function reattachPath(db, hash, newPath, mtimeMs) {
  db.prepare(
    'UPDATE files SET path = ?, mtime_ms = ?, lost_at = NULL WHERE hash = ?'
  ).run(newPath, mtimeMs, hash);
}

// Hard-deletes a row; tags and group memberships cascade.
function deleteFile(db, fileId) {
  db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
}

// Creates the tag name if new and attaches it to the file (idempotent).
function addTag(db, fileId, tagName) {
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tagName);
  const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
  db.prepare(
    'INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)'
  ).run(fileId, tag.id);
}

function removeTag(db, fileId, tagName) {
  db.prepare(
    'DELETE FROM file_tags WHERE file_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)'
  ).run(fileId, tagName);
}

// Detaches every tag from the file (the tag names themselves are kept).
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

// Creates a group with fileIds as members in the given order (position =
// index). Returns the new group id.
function createGroup(db, name, fileIds) {
  const tx = db.transaction(() => {
    const id = db.prepare('INSERT INTO groups (name) VALUES (?)').run(name).lastInsertRowid;
    const ins = db.prepare('INSERT OR IGNORE INTO group_members (group_id, file_id, position) VALUES (?, ?, ?)');
    fileIds.forEach((fid, i) => ins.run(id, fid, i));
    return Number(id);
  });
  return tx();
}

function deleteGroup(db, groupId) {
  db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
}

// Appends files after the group's current last position; files already in
// the group are ignored.
function addGroupMembers(db, groupId, fileIds) {
  let pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM group_members WHERE group_id = ?').get(groupId).n;
  const ins = db.prepare('INSERT OR IGNORE INTO group_members (group_id, file_id, position) VALUES (?, ?, ?)');
  for (const fid of fileIds) pos += ins.run(groupId, fid, pos).changes;
}

function removeGroupMembers(db, groupId, fileIds) {
  const del = db.prepare('DELETE FROM group_members WHERE group_id = ? AND file_id = ?');
  for (const fid of fileIds) del.run(groupId, fid);
}

// Every group with its currently-present members, as
// [{ id, name, memberPaths, keyPath }]. Lost members (path NULL) are kept in
// the table but omitted here; the first present member is the cover.
function getAllGroups(db) {
  const rows = db
    .prepare(
      `SELECT groups.id AS id, groups.name AS name, files.path AS path
       FROM groups
       JOIN group_members ON group_members.group_id = groups.id
       JOIN files ON files.id = group_members.file_id
       WHERE files.path IS NOT NULL
       ORDER BY groups.id, group_members.position`
    )
    .all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) map.set(r.id, { id: r.id, name: r.name, memberPaths: [], keyPath: r.path });
    map.get(r.id).memberPaths.push(r.path);
  }
  return [...map.values()];
}

module.exports = {
  createGroup,
  deleteGroup,
  addGroupMembers,
  removeGroupMembers,
  getAllGroups,
  openDb,
  getByPath,
  getByHash,
  getLost,
  getLostBySize,
  insertFile,
  markLost,
  reattachPath,
  deleteFile,
  addTag,
  removeTag,
  clearTags,
  getTagsForFile,
  getAllFileTags,
};
