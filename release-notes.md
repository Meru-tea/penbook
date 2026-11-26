# Penbook 0.5.1

Penbook 0.5.1 is a stability, PDF fidelity, mobile input, and library performance release on top of 0.5.0:

## Fixes & Improvements

- **Sync Conflict Protection & Safe Flush**:
  - Track `dirtyVersion` and `inFlightWrite` so self-echoes never clobber edits and concurrent saves never clear `dirty` prematurely.
  - Preserve local unsaved ink on external sync conflicts and write the incoming remote version to a sibling `.sync-conflict-<timestamp>.penbook` backup with a notice.
  - Flush pending edits on open destination notebook leaves before `transferPage()` modifies the file.
- **0.7s Hold-to-Eraser Race & Interrupt Recovery**:
  - Clear pending auto-shape timers/snapped state when hold-to-eraser activates, scope `cancelPenHold()` to the active gesture pointer, and restore the previous tool cleanly across `pointerup`, `pointercancel`, and `lostpointercapture`.
- **Infinite Canvas Eraser & Object Resize**:
  - Expand infinite-canvas eraser dirty-rect clipping by 2 screen pixels (`infiniteEraserClipRegion`) so anti-aliased stroke edges are erased cleanly without ghosting.
  - Update `bw`/`bh` when resizing `table` and `link` items.
- **PDF TextMarkup (`Underline`, `StrikeOut`, `Squiggly`) Fidelity**:
  - Normalize imported PDF `quadPoints` into canonical order to prevent bowtie polygons.
  - Render `Underline`, `StrikeOut`, and `Squiggly` markups as clean stroked polylines/waves across Canvas, SVG export, and PDF appearance streams while keeping `Highlight` as a `multiply`-blended filled quad.
- **Stylus Zero-Pressure, `fingerInk` Pinch & Library Metadata Index**:
  - Keep true stylus/touch zero pressure at the thin `0.05^gamma` floor while mapping synthetic mouse `0` pressure to `0.5^gamma`.
  - Allow 2-finger pinch zoom to cleanly cancel an incipient single-finger ink stroke when `fingerInk` is enabled.
  - Persist an incremental `mtime`/`size`-cached metadata index (`library-index.json`) so opening the Library modal avoids re-parsing unchanged `.penbook` files.

## Installation

Download **main.js**, **manifest.json**, and **styles.css** (or extract **penbook.zip** if provided) into your vault's `.obsidian/plugins/penbook/` folder, then reload Penbook in Obsidian (compatible with BRAT).

## Validation

- `npm run build` (`tsc --noEmit && node build.mjs`) passes cleanly.
- All automated regression checks pass: `check-pdf-markup.mjs`, `check-library-index.mjs`, `check-view-stability.mjs`, `check-a1-a3.mjs`, `check-a2.mjs`, `check-b1.mjs`, `check-c1.mjs`, `check-infinite.mjs`, `check-shortcuts.mjs`, and `check-erasure-regression.mjs`.
