# Handoff: Retriever — photo library viewer and organizer

## Overview

Retriever is a desktop photo library browser and organizer: a simpler Adobe Bridge. It watches folders on disk live (no import step), browses them in tabs, groups photos into stacks, tags and filters them, and runs file operations (rename, move, copy, duplicate, rotate, strip metadata, reveal in Finder) without doing any image editing itself.

This bundle documents the UI design for that app: a dark browse window, a fit-width single-image view, four panels/dialogs, and six system/edge states.

## About the design files

The files in this bundle are **design references created in HTML** — prototypes showing intended look, structure and behavior. They are not production code to copy.

The task is to **recreate these designs in the target codebase's environment** using its established patterns. The project already has an Electron scaffold (see "Existing scaffold" below), so the natural target is Electron + a renderer framework of the implementer's choice. Where this document and the HTML disagree, the HTML is the source of truth for pixels; this document is the source of truth for intent.

## Fidelity

**High-fidelity.** Final colors, typography, spacing and layout. Every value below is exact and measurable in the HTML. Two caveats:

- The app icon (a dog head) is a **rough SVG placeholder**, not final artwork. It needs a real icon from a designer or illustrator.
- The sample photographs are crops taken from a screenshot the user supplied, used as grid filler only. They are not product assets.

## Existing scaffold

The user's repo (`uploads/retriever/` in the source project, not bundled here) already contains a working Electron main process that this UI should sit on top of:

- `src/main/watcher.js` — chokidar watch per root, emits add/change/unlink/addDir/unlinkDir to the renderer
- `src/main/db.js` — better-sqlite3 catalog: files, tags, groups, keyed by content hash so a moved file keeps its tags and group membership
- `src/main/hash.js` — content hashing used for that identity
- `src/preload/index.js` — contextBridge surface between renderer and main

The design assumes that identity model. Two places state it in the UI: the "selected file vanished" state holds tags for 30 days, and the metadata-cleanup dialog says tags and groups live in the catalog, not in the file.

---

## Design tokens

Everything below is drawn from the dark direction. The project has the **Modernist** design system bound (light ground, red accent, Archivo, zero radius); this UI deliberately departs from it — a photo tool's chrome should be the darkest thing on screen so the photographs carry all the brightness. The one thing kept from Modernist is the discipline: flush-left labels, visible structure, no decoration.

### Color

| Token | Value | Use |
| --- | --- | --- |
| `bg/window` | `#131314` | window ground, active tab fill |
| `bg/canvas` | `#1b1b1c` | grid area behind tiles |
| `bg/viewer` | `#0d0d0e` | fit-width viewer ground |
| `bg/rail` | `#171718` | left tree, info strip |
| `bg/toolbar` | `#191919` | toolbar row, table headers |
| `bg/raised` | `#1f1f21` | dialogs, inactive tabs |
| `bg/control` | `#232325` | secondary buttons, chips |
| `bg/control-alt` | `#2b2b2d` | dialog buttons, tokens |
| `bg/well` | `#0e0e0f` / `#0f0f10` | inputs; thumbnail wells |
| `bg/status` | `#101011` | status bar |
| `border/hairline` | `#232325` | tile borders, rail dividers |
| `border/window` | `#0c0c0d` | major chrome dividers |
| `border/control` | `#2b2b2d` → `#3c3c3f` | inputs → dialog edges |
| `text/primary` | `#e6e4e2` | body UI text |
| `text/strong` | `#f0eeec` | filenames, active tab |
| `text/secondary` | `#c6c3c0` / `#cfccc9` | tree rows, button labels |
| `text/muted` | `#a5a29f` / `#8f8c89` | secondary filenames, meta |
| `text/dim` | `#7d7a77` / `#6e6b68` | shortcut hints, paths |
| `text/label` | `#63605e` / `#5f5c5a` | uppercase field labels |
| `accent` | `#e6b422` | selection ring, primary fill, progress |
| `accent/text` | `#f0cf72` | accent-colored text and chips |
| `accent/pale` | `#f9edc9` | text on accent-tinted rows |
| `accent/on-fill` | `#241a06` | text on a solid accent fill |
| `accent/tint` | `rgba(230,180,34,.13–.16)` | tinted fills |
| `accent/edge` | `rgba(230,180,34,.28–.34)` | borders on tinted fills |
| `status/live` | `#7ac47a` | watcher heartbeat, newly-added ring |
| `status/danger` | `#c9503f` | destructive fill |
| `status/danger-text` | `#e79486` | warnings on tinted rows |
| `tag/select` | `#4a9d5f` | tag swatch |
| `tag/reject` | `#c9503f` | tag swatch |
| `tag/maybe` | `#d9a13d` | tag swatch |
| `tag/published` | `#e6b422` | tag swatch |

Tag vocabulary is the user's own: **select, reject, maybe, published**.

### Type

- UI face: **Geist** (300/400/500/600), fallback `system-ui, sans-serif`
- Mono face: **Geist Mono** (400/500), fallback `ui-monospace, monospace` — used for every filename, path, count, metadata value and shortcut key
- Sizes: 9.5px uppercase field labels (letter-spacing .8px) · 10–10.5px counts, status bar, tile filenames · 11–11.5px controls, metadata, chips · 12px tree rows, tabs, menus · 13px dialog and panel titles (weight 600)
- Uppercase labels: `text-transform:uppercase; letter-spacing:.8–.9px; font-weight:500`

### Spacing, radius, elevation

- Spacing steps used: 2, 4, 6, 8, 10, 12, 14, 16, 18, 22px
- Radius: 3px checkboxes/tokens · 4px thumbnails · 5px tree rows · 6px controls and buttons · 7px 7px 0 0 tabs · 8px context menu and group band · 11–14px pill chips · 0 on dialogs (square)
- Fixed chrome heights: 40px title bar · 44px toolbar · 26px status bar · 42px dialog headers
- Fixed widths: 236px left tree · 304px filter panel · 720px rename dialog · 520px cleanup dialog · 880px shortcuts sheet
- Elevation: context menu `0 24px 48px -12px rgba(0,0,0,.7)`; viewer image `0 20px 60px -20px rgba(0,0,0,.9)`; selection ring `box-shadow:0 0 0 2px #e6b422`; new-file ring `0 0 0 1px #7ac47a, 0 0 22px -6px rgba(122,196,122,.55)`

### Thumbnail sizing rule (important)

Every thumbnail cell is a **fixed-height flex box**: `box-sizing:border-box; display:flex; align-items:center; justify-content:center; overflow:hidden; padding:3px`, and the image inside is `max-width:100%; max-height:100%; width:auto; height:auto; object-fit:contain`. Do not use a grid cell with `place-items:center` and a percentage-height image — in an auto-sized row the percentage does not resolve and the photo overflows its tile. Photographs are never cropped or upscaled: contain, never cover, and the fit-width viewer caps the image at 760px rather than stretching a small source.

---

## Screens and views

### 1. Browse (default) — 1440 × 900

The main window. Four horizontal bands over a body split into tree + grid.

**Title bar (40px, `linear-gradient(#232326,#1b1b1d)`, bottom border `#0c0c0d`)**
- Traffic lights: three 11px circles, 8px gap — `#ec6a5e`, `#f4bf4f`, `#61c454`
- App mark (18px dog SVG, `#c9a24d`) + "Retriever" 12px/600 `#b9b6b2`
- Tab strip, flush left after the brand. Active tab: 30px tall, `#131314` fill, `7px 7px 0 0`, 12px `#f0eeec` label, a 6px green dot meaning "this folder is being watched", and a × close. Inactive tabs: 28px, `#1f1f21`, `#9c9895`. Labels truncate with ellipsis at 180–220px. A 26px "+" opens a new tab.
- Right: 6px green dot with a 3px glow ring + "watching 3 folders" in 11px mono `#7d7a77`

**Toolbar (44px, `#191919`)**
- Breadcrumb path in 12px mono; separators `#4f4d4b`, current folder `#e6e4e2`
- Operation chips, 26px tall, 6px radius, `#232325`, 11.5px: "↺ Rotate ↻", "Group 3" (accent-tinted when a multi-selection can be grouped), "Tag ▾", "Rename…", "Clean metadata". All `white-space:nowrap; flex:none` — they must never wrap.
- Right cluster: 210px search field (`#0e0e0f`, border `#2b2b2d`, magnifier glyph, typed text plus a 1px accent caret), "Filter" chip with an accent count badge, "Sort: Date ↓", then a thumbnail-size slider (82 × 3px track, 11px knob) flanked by small/large grid glyphs

**Left tree (236px, `#171718`)**
- Sections "PLACES" and "TAGS" as 10px uppercase labels
- Rows: 12px, 5px vertical padding, 5px radius, indent step 16px, disclosure triangles ▾/▸. Current folder is accent-tinted with an accent border and an accent count. Counts are right-aligned 10px mono.
- A folder that is a live drop target gets `1px dashed rgba(230,180,34,.5)` + `rgba(230,180,34,.07)` fill and a "drop 3" hint
- Tag rows carry an 8px square swatch and a count
- Pinned to the bottom: watcher receipt in 10.5px mono — "fsevents · 42ms ago" over "+3 added · 1 moved" in green

**Grid (`#1b1b1c`, 14px 16px padding)**
- Active-filter line above the grid: "filter:" in accent, then chips, then "· 1284 of 8214 shown"
- 6 columns, gap 16px row / 18px column, tile height 140px (the slider drives this; small ≈ 90px, large ≈ 220px), filename below each tile in 10.5px mono with ellipsis
- **Selected** tile: 2px accent ring, filename in `#e6e4e2` preceded by a 7px tag swatch
- **Collapsed group (stack)**: two offset card layers behind the tile (`#242426`/`#2b2b2d` with 1px borders, offset 3px and 6px down-right) and a pill top-left — `▸ 4` on `rgba(10,10,11,.82)`. Group name below carries a ⌗ mark.
- **Inline rename**: the filename row becomes a 17px field, `#0b0b0c` on a 1px accent border, with a caret
- **Newly detected file**: green ring + glow, and the filename row is prefixed with "new" in green. Decays after a few seconds.
- **Expanded group band**: full-width block below the tiles, `1px solid rgba(230,180,34,.34)` on `rgba(230,180,34,.06)`, 8px radius. Header row: "▾ group "window_seq" · 5 items" in accent mono, right-aligned actions "collapse · add selection · ungroup". Inside, the same grid at 104px tiles.
- **Context menu**: 224px, `rgba(32,32,34,.97)`, 1px `#3c3c3f`, 8px radius, 5px padding. Items 12px, 5px 9px, 5px radius; hovered item is a solid accent fill with `#241a06` text; shortcut hints right-aligned in mono `#7d7a77`; 1px `#3c3c3f` separators. Order: Open in Photoshop / Rename… ↩ / Duplicate ⌘D — Move to… › / Copy to… › / Tag › — Group selection ⌘G / Rotate [ ] / Remove all metadata — Reveal in Finder.

**Info strip (150px, `#171718`)**
- 120px thumbnail well, then filename (13px mono 600) + path (10.5px mono dim), then tag pills on the right — filled pills per tag plus a dashed "+ tag" affordance
- Metadata as a 5-column grid, each cell a 9.5px uppercase label over an 11px mono value: dimensions, color space, bit depth, size + format, modified, camera, exposure, lens, group (accent), metadata blocks present
- Right column, 150px: "All metadata ▾", "Remove all metadata" (danger-tinted), "Reveal in Finder"

**Status bar (26px, `#101011`)**: "1284 items · 3 selected · 12.6 GB" · "2 groups" · right: green dot + "live · indexed 8214 files" · "⌘/ shortcuts"

### 2. Fit-width viewer — 1440 × 900

Replaces the grid **in the same tab**; the tab label becomes "2026 Selects — kestrel_0114.jpg". Same title bar, tree and status bar.

- Toolbar changes to: "← Back to grid `esc`" · divider · zoom segment where **Fit width** is the accent-tinted active state, then "Fit screen", "100%" · "↺ Rotate ↻" · "Tag ▾" · "Open in Photoshop" · right: "614 / 1284" in mono and two 26px ‹ › buttons
- Viewer ground `#0d0d0e`, 22px padding, image centered with `max-width:760px; max-height:100%` and the deep drop shadow. The cap exists so a small source is never upscaled — with production photos, raise it to the natural width.
- Filmstrip: 96px band, `#141415`, top border `#1f1f21`, 96 × 70px cells, 10px gap, horizontally scrolling; the current frame gets the accent ring
- Info strip shrinks to 112px: filename block with tag pills on the left, a 4-column metadata grid on the right, including an "orientation — rotated 90° cw" cell (rotation is recorded, not baked)

### 3. Filter panel — 304px

Slides over the tree. Header 38px `#1f1f21`: "Filter" + "1284 of 8214" in mono + "Reset" in accent text.
Sections, each a 9.5px uppercase label over its control:
- **Tags** — checkbox rows (11px square, accent fill with a ✓ when on, else 1px `#4a4846`), tag swatch, name, count. Below: an any/all segmented pair.
- **File type** — pill chips with counts; selected chips are accent-tinted with accent text
- **Resolution** — two mono fields, "≥ 2000 px" and "any", joined by "to"
- **Other** — checkboxes: grouped items only, has GPS metadata, untagged only, include subfolders
- Footer: accent "Apply" filling the width, plus "Save as view"

### 4. Mass rename — 720px

Header: "Rename 3 files" + folder path + ×.
- **Pattern** field: `#0e0e0f` on a 1px accent border, holding draggable tokens — a literal ("kestrel", accent-tinted) and two metadata tokens (`{capture:yyyy-mm-dd}`, `{counter:001}`) on `#2b2b2d`, separated by · with a caret at the end
- Token palette below as 11px pills: + text, + counter, + capture date, + original name, + folder, + dimensions
- Options row: start at 001 · separator _ · case lower · right: "Extension unchanged"
- **Preview table**: 1px `#2f2f31`, 6px radius, header row on `#191919` with "current / new"; each row a `1fr 18px 1fr` grid — old name in `#a5a29f`, → in `#4f4d4b`, new name in `#f0eeec`, 11.5px mono
- Collision row at the table foot: danger-tinted, "already exists in this folder — Retriever will append -2"
- Footer: "Renames on disk. Undo with ⌘Z." left; Cancel + accent "Rename 3" right

### 5. Metadata cleanup — 520px

Header: "Remove metadata" + "group "window_seq" · 5 files · 41 MB".
- **Will be removed** — checkbox rows with per-item file counts: EXIF (camera, lens, exposure) ✓, GPS location ✓, IPTC (creator, copyright, captions) ✓, embedded thumbnails ☐, ICC color profile ☐ flagged "affects color" in danger text
- 1px divider, then **Kept** — "Pixels, orientation, and Retriever's own tags and groups — those live in Retriever's catalog, not in the file."
- Accent-tinted row: "Keep an untouched copy in `_originals/`" (checked)
- Footer: "Writes to the files on disk." left; Cancel + danger-filled "Strip 5 files" right

### 6. Shortcuts sheet — 880px

`rgba(24,24,25,.98)` over the window. Header: app mark, "Keyboard shortcuts", "hold ⌘/ · release to dismiss", and a shortcut-search field on the right. Four columns — Navigate, Select & group, Tag & sort, Files — each a 9.5px accent uppercase heading over rows of `52px` mono key + description. Footer: "⌘Z undo — covers renames, moves, rotations and strips" and "⌘, preferences".

Bindings (implement all of these):

| Key | Action |
| --- | --- |
| ↑ ↓ ← → | move selection |
| ↵ / esc | open fit-width / back to grid |
| ⌘T · ⌘1–9 · ⌘⌥← | new tab · go to tab · parent folder |
| ⌘F · ⌘L | search filenames · filter panel |
| ⌘A · ⇧click · ⌘click | select all · extend · add or remove |
| ⌘G · ⌘⇧G · ⌘⌥G | group selection · ungroup · add to group |
| → · ← | expand · collapse group |
| 1 2 3 4 · 0 | select / reject / maybe / published · clear tags |
| ⌘⌥1 / 2 / 3 | sort by name / date / size |
| [ ] | rotate ccw / cw |
| ⌘R · ⌘⇧R · ⌘D | rename · mass rename · duplicate |
| ⌘⌥M · ⌘⌥C | move to… · copy to… |
| ⌘⌫ · ⌘⇧O | strip metadata · reveal in Finder |
| ⌘Z · ⌘, · ⌘/ | undo · preferences · this sheet |

### 7. System and edge states

Six panes, each `#131314` on a 1px `#232325` border with a 10px uppercase caption bar. Copy is exact — use it verbatim.

1. **No folder chosen** — dimmed 34px dog mark, "Point Retriever at a folder", "It watches everything inside it from then on. No import step.", accent "Choose folder…" + "Use ~/Pictures"
2. **Folder has no photos** — "Nothing here yet", a note that the folder holds files Retriever doesn't read (2 PSD, 1 MOV, 1 PDF), a green "watching — drop files in and they appear" line, and a dashed full-width "drop photos here" target pinned to the bottom
3. **Filtered to nothing** — "0 of 1284 match", the active filter chips, "Drop the resolution rule and 20 files come back.", Clear filters / Edit filter
4. **Selected file vanished** — a 96px diagonally-hatched placeholder (`repeating-linear-gradient(45deg,#191919,#191919 6px,#1d1a16 6px,#1d1a16 12px)`, dashed `#4a3a2a` border) reading "moved or deleted on disk", then "…left this folder 2 seconds ago. Its tags and its place in window_seq are held for 30 days.", Find it / Forget
5. **Permission denied** — danger-tinted "macOS won't let Retriever read this folder", the volume path in mono, remediation pointing at Privacy & Security → Files and Folders, "The watch resumes on its own.", accent "Open settings" + "Retry"
6. **First index · thumbnails decoding** — a 4-cell mini grid with one decoded thumbnail, two empty `#191919` placeholders and one "?" for an undecodable file; a labelled 3px accent progress bar at 62%; "Browsing works now — thumbnails fill in behind you. One file won't decode: frame_test.jpg is truncated."

---

## Interactions and behavior

**Live filesystem watch** — the spine of the app. There is no import action anywhere in the UI.
- A file appearing in a watched folder animates into the grid with the green ring + glow and a "new" prefix that decays after roughly 3 seconds
- A file removed or moved out fades out; if it was selected, the viewer switches to the "selected file vanished" pane rather than jumping to another photo
- The tree's bottom receipt updates continuously ("fsevents · 42ms ago", "+3 added · 1 moved") and the status bar keeps a "live" dot; if the watch drops, both go amber and the receipt says why
- Because identity is the content hash, a file moved between watched folders keeps its tags and group membership and simply re-parents in the tree

**Tabs** — each tab is an independent directory view with its own sort, filter, scroll position and selection. ⌘T opens one on the current folder; tab labels truncate; a tab whose folder is watched shows the green dot.

**Selection** — click, ⇧click for a range, ⌘click to toggle. The toolbar's Group chip lights accent at 2+. Multi-select shows a count in the status bar and the info strip shows shared values with the rest marked mixed (not yet mocked).

**Grouping (stacks)** — 2+ selected + ⌘G makes a group. Collapsed, it renders as one tile with the layered-card treatment and a count; expanded (→ or clicking the count), it becomes the accent-bordered band. **The group survives every sort mode**: sorting orders groups by their key photo and never splits members apart. Members can be added (⌘⌥G), removed, or the whole thing ungrouped (⌘⇧G).

**Drag and drop** — dragging tiles onto a tree row moves the files on disk; the target row shows the dashed accent border and a count. An illegal target (unwritable volume, the folder the files are already in) shows a denied cursor and no highlight.

**Rotation** — [ and ] rotate the selection. Recorded as an orientation change, shown in the info strip as "rotated 90° cw", applied to thumbnails immediately.

**Tagging** — number keys 1–4 apply the four tags, 0 clears. Tags are catalog-side, so they survive renames, moves and metadata stripping.

**External editing** — "Open in Photoshop" is the first context-menu item and the primary action; the app never edits pixels. The external editor is a preference.

**Undo** — ⌘Z covers renames, moves, rotations and metadata strips. Both destructive dialogs say so in their footer.

**Transitions** — keep them short and mechanical: 120–160ms ease-out for panel slides and menu appearance, 200ms for the new-file ring fade, no bounce, no scale-in. The grid must stay responsive while thumbnails decode behind it.

## State

Per window: watched roots, tab list, active tab.
Per tab: current directory, sort mode + direction, filter set (tags + any/all, file types, resolution range, flags), search query, thumbnail size, selection (ordered ids), expanded-group ids, scroll offset, view mode (grid or fit-width) and current photo.
Global: catalog (files by hash → path, tags, group id, metadata), group definitions with key photo and order, watcher status per root, indexing progress, thumbnail cache state per file, undo stack, preferences (external editor, watched roots, cache size).

## Assets

- **App icon**: placeholder SVG only — a dog head in `#c9a24d` (dark chrome) / `#e6b422` (sheet header). Needs real artwork.
- **Icons**: the design uses a handful of inline SVG glyphs (magnifier, grid-density marks) and text glyphs (▾ ▸ ↺ ↻ ‹ › × + ✓ ⌗ →). Replace with the codebase's icon set; Lucide matches the weight.
- **Photographs**: `photos/p01–p18.png`, crops from a screenshot the user supplied. Sample filler for the grid — not product assets, do not ship.

## Files

- `Retriever.dc.html` — the design. Turn 2 (top of the page) holds the filter panel, mass rename, metadata cleanup, shortcuts sheet and the six system states; turn 1 (below) holds the browse screen and the fit-width viewer. Open it in a browser.
- `support.js` — runtime needed to render that file locally.
- `photos/` — the sample crops.
