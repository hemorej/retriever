# Retriever

Retriever is a desktop photo library browser and organizer — a simpler
Adobe Bridge. It watches folders on disk live (no import step), browses
them in tabs, groups photos into stacks, tags and filters them, and runs
file operations (rename, move, copy, duplicate, rotate, strip metadata,
reveal in Finder) without doing any image editing itself.

## Stack

- **Electron** — main process owns the filesystem watch and the catalog db
- **Vue 3** (global build, no bundler) — renderer UI
- **chokidar** — live folder watching
- **better-sqlite3** — local catalog (tags, groups, file identity)
- **hash-wasm** — content hashing, so a moved/renamed file keeps its tags
- **pdfkit** — contact-sheet PDF export

Thumbnails and TIFF previews are produced with macOS's built-in `sips`, so
those currently require macOS.

## Getting started

```bash
pnpm install
pnpm start
```

`pnpm dist` builds an unpacked macOS app into `dist/` (electron-builder).

On first launch, choose a folder (or use the `~/Pictures` shortcut) — Retriever
starts watching it immediately and the grid fills in as files are found.
There's no import step: point it at a folder and it just shows what's there.

## Project structure

```
src/
  main/
    index.js          # app lifecycle, window, IPC handlers, contact-sheet PDF export
    watcher.js        # chokidar watch + hash-identity reconciliation
    db.js             # sqlite schema and queries (files, tags, groups)
    hash.js           # content hashing for file identity
    metadata.js       # JPEG/PNG metadata stripping (EXIF/GPS/IPTC/ICC)
    thumbnails.js     # disk-cached thumbnails, worker pool, TIFF previews
    thumbnail-worker.js # worker thread that shells out to `sips`
  preload/
    index.js       # contextBridge surface exposed to the renderer
  renderer/
    index.html
    style.css       # design tokens + component styles
    app.js          # the whole Vue app (single file, global Vue build)
    fonts/, icon*.png
docs/
  thumbnail-generation-plan.md  # proposal for faster thumbnails (not implemented)
```

## What's real vs. stubbed

Wired to real behavior: live watch, tagging, lost-file tracking, single/mass
rename (literal, counter, capture-date, dimensions, original-name and folder tokens), duplicate, move/copy (with a destination
picker, conflict resolution and drag-and-drop), JPEG/PNG metadata stripping
(EXIF, GPS, IPTC, ICC; optional `_originals/` backup), opening in an external
editor (Affinity Photo 2 if installed, else the OS default), trash, grouping
(stacks), contact-sheet PDF export, and rotation (session-only: it isn't
written to the file and isn't persisted).

Still stubbed or limited: EXIF thumbnail stripping on its own (only whole-APP1
removal is supported), formats other than JPEG/PNG for metadata stripping,
and ⌘, preferences. Undo (⌘Z) covers tag
changes and rotations only.

## Performance notes

The grid is virtualized: only the rows in (and just around) the scroll
viewport are mounted. The viewer's filmstrip is windowed around the active
file. By default browsing is scoped to one folder's direct contents; the
filter panel's "Include subfolders" widens it.

## App data

Retriever keeps everything it persists under Electron's per-app userData
directory — on macOS, `~/Library/Application Support/Retriever/`:

- `retriever.sqlite3` (+ `-wal`/`-shm`) — the catalog db: tags, groups,
  and file identity (see `src/main/db.js`)
- `thumbnails/` — disk-cached grid thumbnails (`src/main/thumbnails.js`);
  entries older than 60 days are pruned at startup
- `session.json` — open tabs, each tab's current folder/subfolder, a grid
  snapshot for instant repaint on relaunch, each tab's tree
  expand/collapse shape, and per-folder sort settings

Deleting the whole folder resets the app to a clean first-launch state.
Deleting just one of the above resets only that piece (e.g. remove
`retriever.sqlite3*` to wipe tags/groups while keeping thumbnails and
session state, or remove `thumbnails/` to force thumbnail regeneration).

## Design reference

The UI in `src/renderer/` is a from-scratch Vue implementation of a design
handoff (HTML mockup + spec) that is no longer kept in the repo — it was
removed from version control, so `src/renderer/style.css` (design tokens as CSS
variables) is now the working source of truth for colors, spacing and layout.
