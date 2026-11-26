# Changelog

## 0.5.1

- **Sync Conflict Protection & Safe Flush**: Added `dirtyVersion` / `inFlightWrite` tracking in `PenbookView` to ignore vault echo writes, preserve local unsaved edits while saving remote sync conflicts to `.sync-conflict-<timestamp>.penbook` backups, and flush open destination leaves before `transferPage()`.
- **0.7s Hold-to-Eraser Race & Interrupt Fix**: Cleared active shape timers/snapped state when hold-to-eraser triggers, scoped `cancelPenHold()` to the active pointer, removed the racy `setTimeout(..., 0)` tool restore, and restored `penHoldBefore` consistently on both commit and cancel/interrupt.
- **Infinite Canvas Eraser Clip & Table/Link Resize**: Added `infiniteEraserClipRegion()` 2px screen-space padding in `repaintEraserRegion()` to prevent anti-aliased stroke edge artifacts, and updated `bw`/`bh` during `table` and `link` resize gestures.
- **PDF Underline / StrikeOut / Squiggly Rendering**: Canonicalized imported PDF `quadPoints` to prevent bowties and rendered `Underline`, `StrikeOut`, and `Squiggly` markups as stroked paths across Canvas, SVG export, and PDF appearance streams while keeping `Highlight` as `multiply`-blended filled quads.
- **Stylus Zero-Pressure, `fingerInk` Pinch & Incremental Library Cache**: Mapped `mouse` zero-pressure to `0.5` while keeping pen/touch `0` at minimum `0.05^gamma`, allowed 2-finger pinch zoom to cancel incipient touch strokes in `fingerInk` mode, and added an `mtime`/`size`-cached `LibraryIndex` (`library-index.json`) to avoid re-parsing unchanged notebooks.

## 0.5.0

- **Pen Favorites Dock (A1)**: Added up to 6 customizable quick-switch pen presets in the context bar with persistent settings and long-press/right-click slot management.
- **Scribble-to-Erase, Hold-to-Adjust Shapes & Bound Connectors (A2)**: Added back-and-forth scribble stroke erasing, continuous post-snap shape adjustment while holding the pen, shape anchor snapping with straight/elbow/curved bound connectors that follow shape transforms, and double-click centered text labels inside closed shapes.
- **Rectangular Marquee, Smart Guides & Selection Tools (A3)**: Added lasso/marquee selection toggle, grid snap and smart edge/center alignment guides while dragging, 8-way align/distribute, horizontal/vertical flip, and selection filtering by object kind.
- **In-Document Full-Text Search (B1)**: Added `Ctrl/Cmd+F` floating search bar supporting PDF text coordinates (with rotation and crop support) and canvas text/sticky/table/shape items across paged and infinite notebooks with match highlighting and navigation.
- **Native Live Embeds (C1)**: Added `![[Notebook.penbook#pageOrBookmark]]` live embed rendering in Markdown Reading View, Live Preview, and Obsidian Canvas with `mtime`-keyed LRU caching, auto-refresh on file modification, upgraded `penbook` codeblocks, and one-click embed link copying.

## 0.3.1

- Use Obsidian's settings heading and CSS APIs to satisfy current community review checks.
- Keep the release manifest name aligned with the directory listing and terminate its description with accepted punctuation.

## 0.3.0

- Preserve standard annotation subtypes, original appearance streams, comments, attachments, popup/reply relationships, and form values when importing and exporting PDFs.
- Select, move, resize, rotate, copy, delete, and edit comments on native annotations. Keep their source PDF embedded when copying them to another notebook.
- Preserve FreeText appearances until text/style changes; regenerate the appearance and retain font size/color when edited.
- Preserve complex/native annotations as movable objects with their original data and a preview. This does not add media playback, 3D interaction, form filling, digital signing, or applying redactions.
- Add regression coverage for 26 subtypes at four page rotations, plus links/popups, attachment bytes, replies, hidden fields, radio groups, deletion, and transformed copies.
- Package installable release assets with local PDF resources, licenses, and SHA-256 checksums.

## 0.2.0

- Keep every imported PDF embedded in the notebook, including files above 150 MB. Use chunked encoding, bounded caches, and shared PDF export resources.
- Copy and cut selections across notebooks, including their image resources and groups.
- Edit table cells and change row/column counts.
- Export strokes, text, shapes, tables, and tape as SVG vectors.
- Import PDF outlines and follow native PDF links; preserve destinations when merging pages.
- Convert common standard PDF annotations into editable objects and export standard annotation objects. Preserve Penbook-specific details in an embedded annotation archive.
- Crop PDF pages with support for rotated pages and native text selection.
- Bundle PDF.js 6.4.299; keep the PDF parser and its assets local.
