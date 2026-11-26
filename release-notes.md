# Penbook 0.5.0

Penbook 0.5.0 introduces five major writing, diagramming, search, and Obsidian integration upgrades on top of Infinite Canvas (0.4.0):

## Highlights

- **Pen Favorites Dock (A1)**: Save up to 6 pen presets (pen type, color, width, stroke style) in the context toolbar for one-tap switching, with long-press / right-click editing.
- **Scribble-to-Erase & Smart Shape Connectors (A2)**:
  - Scratch back-and-forth over ink strokes to erase them (toggleable in pen settings, undoable).
  - Keep dragging after auto-shape snap to adjust endpoints or dimensions smoothly.
  - Snap lines and arrows onto shape anchors with straight, orthogonal elbow, or curved routes that stay attached when shapes move, resize, rotate, align, or flip.
  - Double-click closed shapes to edit centered labels.
- **Marquee Selection, Smart Guides & Selection Tools (A3)**:
  - Switch between freehand lasso and rectangular marquee selection.
  - Smart edge/center alignment guides and optional grid snap while moving selections.
  - Align & distribute (8 modes), horizontal/vertical flip, and filter selection by object type.
- **In-Document PDF & Notebook Full-Text Search (B1)**:
  - Press `Ctrl/Cmd+F` to search PDF text (preserving rotation and crop coordinates) as well as text boxes, sticky notes, tables, and shape labels across paged and infinite notebooks, with on-canvas match highlights and next/previous navigation.
- **Native Live Wikilink Embeds (C1)**:
  - Embed notebooks, pages, or infinite viewport bookmarks directly with `![[Notebook.penbook#pageOrBookmark]]` in Reading View, Live Preview, and Obsidian Canvas, with `mtime`-cached rendering and automatic refresh on save.

## Installation

Download **penbook.zip**, extract the `penbook` folder, and copy its contents into your vault's `.obsidian/plugins/penbook/` folder (preserving `cmaps`, `standard_fonts`, `wasm`, and `licenses`), or update `main.js`, `manifest.json`, and `styles.css` directly (compatible with BRAT). Reload Penbook in Obsidian.

## Validation

- `npm run build` (`tsc --noEmit && node build.mjs`) passes cleanly.
- Automated regression checks pass: `check-a1-a3.mjs`, `check-a2.mjs`, `check-b1.mjs`, `check-c1.mjs`, `check-infinite.mjs`, `check-shortcuts.mjs`, and `check-erasure-regression.mjs`.
