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

## Getting started

```bash
npm install
npm start
```

On first launch, choose a folder (or use the `~/Pictures` shortcut) — Retriever
starts watching it immediately and the grid fills in as files are found.
There's no import step: point it at a folder and it just shows what's there.

## Project structure

```
src/
  main/
    index.js      # app lifecycle, window, IPC handlers
    watcher.js     # chokidar watch + hash-identity reconciliation
    db.js          # sqlite schema and queries (files, tags, groups)
    hash.js        # content hashing for file identity
  preload/
    index.js       # contextBridge surface exposed to the renderer
  renderer/
    index.html
    style.css       # design tokens + component styles
    app.js          # the whole Vue app (single file, global Vue build)
design_handoff_retriever/
  Retriever.dc.html # the source design reference (HTML mockup)
  README.md          # full design spec: tokens, screens, interactions
```

## What's real vs. stubbed

The catalog identity model (content-hash based, so tags/groups survive
renames and moves) is fully wired, along with: live watch, tagging,
lost-file tracking, single/mass rename, duplicate, rotation (session-only),
reveal in Finder, and grouping (stacks).

A few things from the design are intentionally UI-only for now — no
backend work has been done for: move/copy destination pickers, EXIF-level
metadata stripping, and launching an external editor. These render and
behave like the design but don't touch files on disk yet.

## Known limitation

The grid isn't virtualized. Folders with many thousands of files *directly*
inside them (not spread across subfolders) will render slower past a
1500-tile cap. Scoping the tree to a subfolder, or building a virtualized
grid, are the natural next steps if that turns out to matter.

## Design reference

The UI in `src/renderer/` is a from-scratch Vue implementation of the
mockup in `design_handoff_retriever/`. That folder's `README.md` is the
source of truth for every design token, screen, and interaction — read it
before changing layout, color, or spacing.
