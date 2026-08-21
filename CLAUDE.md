# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install   # also runs postinstall: electron-rebuild -f -w better-sqlite3
pnpm start     # launches the app (electron .)
```

Package management is pnpm, not npm — `pnpm-lock.yaml` is the lockfile,
`pnpm-workspace.yaml` holds the `allowBuilds` allowlist (which packages may
run postinstall/build scripts; add a new native dependency here or its
install silently no-ops) and a `minimumReleaseAge` supply-chain safety net
(new package versions aren't installable until they've been out a few days).

There is no build step, bundler, lint script, or test suite configured.
The renderer is loaded as plain files (`src/renderer/index.html` script-tags
`vue.global.prod.js` from `node_modules` directly and `app.js` next to it) —
editing `src/renderer/*` takes effect on next `npm start`, no compile step.

To sanity-check a change without opening a window, `node --check <file>`
catches syntax errors in any of the `src/**/*.js` files.

There's no headless test harness. To actually exercise the UI, drive the
app with Playwright's `_electron` support. `npm install --no-save
playwright-core` doesn't work cleanly against pnpm's node_modules layout
(ERESOLVE crash) — instead `npm init -y && npm install playwright-core` in a
scratch directory outside the repo, then a script there can still launch
`<repo>/node_modules/electron/dist/Electron.app/.../Electron` against the
repo root and screenshot via `page.screenshot()`; see git history of this
session for a working pattern. It's a manual verification tool, not a
project dependency — never add it to this repo's package.json.

## Architecture

Three processes, connected by a narrow contextBridge surface — this shape
matters more here than in a typical Electron app because the renderer is
**sandboxed** (Electron 32 default): it cannot `require()` anything, not
even Node built-ins like `os` or `path`. Anything the renderer needs that
isn't pure JS has to go through `src/preload/index.js` → IPC → main.

- **`src/main/index.js`** — window lifecycle, all `ipcMain.handle` endpoints.
  Owns a single `watcher` instance for a single `watchedRoot` at a time —
  choosing a new folder tears down and replaces the watcher, it does not
  layer multiple roots. `startWatching()` is the one place that changes.
- **`src/main/watcher.js`** — chokidar wrapped with the identity model
  (see below) and normalized into `{type, ...}` events forwarded to the
  renderer as a single `fs-event` IPC channel. Event types: `added`,
  `removed`, `lost`, `moved`, `ready`, `error`.
- **`src/main/db.js`** — better-sqlite3, schema inline in the file. Tables:
  `files` (hash-keyed), `tags`, `file_tags`, `groups`, `group_members`.
- **`src/main/hash.js`** — xxhash64 over full file contents; used only for
  identity, not security.
- **`src/preload/index.js`** — the entire `window.retriever` API surface.
  If the renderer needs a new capability, it's added here as a thin
  `ipcRenderer.invoke` wrapper, plus the matching `ipcMain.handle` in
  `main/index.js`. Never add a Node `require()` here beyond `electron`.
- **`src/renderer/app.js`** — the whole UI. One file, Vue 3 (global/runtime
  compiler build — templates are plain strings compiled at runtime, which
  is why `index.html`'s CSP allows `'unsafe-eval'` for `script-src`; that's
  safe here because everything loaded is local `file:`, nothing remote).
  Root `App` component's `setup()` holds all app state as one `reactive()`
  object; a handful of small presentational components (`ContextMenu`,
  `TagMenu`, `FilterPanel`, dialogs, `ShortcutsSheet`, `TreeNode`) are
  defined above it and registered via `app.component`.

### The identity model (read this before touching watcher.js or db.js)

Files are identified by content hash, not path, so a moved/renamed file
keeps its tags and group membership. The critical asymmetry: **untagged
files are never hashed or written to the db** — only files the user
tags or groups get a row (`ensureTracked` in watcher.js is the only place
that happens). This keeps the catalog small regardless of library size and
means most `add`/`unlink` events are just reported to the UI as plain
filesystem entries with no db lookup at all. When a *tracked* file
disappears, its row is kept with `path = NULL` ("lost") rather than
deleted; a new file whose size matches a lost row gets hash-compared, and
a match re-points the row (`moved`) instead of creating a new one.

### Renderer performance guardrails — don't remove these without reason

`app.js` batches incoming `fs-event` messages (`queueFsEvent`/`flushFsEvents`,
~50ms) instead of applying each one as its own Vue reactive mutation.
Watching a folder with tens of thousands of files (a broad root like
`~/Pictures`) previously hung the renderer entirely before this existed.
Related guardrails in the same file, all serving the same problem:

- `state.filters.includeSubfolders` defaults `false` and `beginWatch()`
  sets `folderFilter` to the watched root itself — browsing is scoped to
  one folder's direct contents by default, not the whole recursive tree.
- `isNew()` derives the "just added" ring from `state.now` (a single
  ticking ref) instead of a `setTimeout` per file.
- `renderCap` (1500) hard-caps how many tiles `renderedEntries` mounts;
  there is no virtualized grid yet, so this is the only thing standing
  between a huge single folder and a frozen window.

`style.css`'s `.tile-grid` uses `minmax(0, 1fr)` columns, not bare `1fr` —
plain `1fr` grid blowout when tile images are large (columns size to
content instead of the track) is a real bug that was hit and fixed here.

### Design source of truth

`design_handoff_retriever/` holds the original HTML mockup and its own
`README.md`, which documents every color token, spacing value, and
interaction spec exactly. `src/renderer/style.css` and `app.js` are a
from-scratch reimplementation of that spec, not a copy of the mockup's
markup — when changing visual design, check the mockup's README for the
token/spec first rather than reverse-engineering it from the Vue templates.

Scope note: several context-menu/toolbar actions in the design are wired
to real file operations (rename, duplicate, reveal in Finder, tag/untag,
group) and some are intentionally UI-only stubs (move/copy destination
pickers, EXIF metadata stripping, external editor launch, mass-rename's
date/dimension tokens beyond a literal+counter). Grep `app.js` for
`toast(` calls with "isn't wired up" / "not implemented" to find the stubs.
