import { Rect, itemAABB, rectsIntersect } from './infinite';
import { Item, Point } from './model';

export type LassoMode = 'lasso' | 'rect';
export type SelectionFilterKind =
  | 'all'
  | 'stroke'
  | 'highlighter'
  | 'shape'
  | 'text'
  | 'sticky'
  | 'image'
  | 'table'
  | 'tape'
  | 'link';
export type AlignAction =
  | 'left'
  | 'center-h'
  | 'right'
  | 'top'
  | 'center-v'
  | 'bottom'
  | 'distribute-h'
  | 'distribute-v';

export interface AlignmentGuide {
  orientation: 'vertical' | 'horizontal';
  pos: number;
  start: number;
  end: number;
}

function normalizeRect(rect: Rect): Rect {
  const x = rect.w < 0 ? rect.x + rect.w : rect.x;
  const y = rect.h < 0 ? rect.y + rect.h : rect.y;
  return { x, y, w: Math.abs(rect.w), h: Math.abs(rect.h) };
}

function combinedBounds(items: readonly Item[]): Rect | null {
  if (!items.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const o of items) {
    const b = itemAABB(o, 0);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function itemsInRect(items: Item[], rect: { x: number; y: number; w: number; h: number }): Set<string> {
  const norm = normalizeRect(rect);
  const selected = new Set<string>();
  for (const o of items) {
    if (rectsIntersect(itemAABB(o, 0), norm)) {
      selected.add(o.id);
    }
  }
  const groups = new Set(
    items.filter(o => selected.has(o.id) && o.group).map(o => o.group as string),
  );
  if (groups.size) {
    for (const o of items) {
      if (o.group && groups.has(o.group)) {
        selected.add(o.id);
      }
    }
  }
  return selected;
}

export function computeMoveSnap(
  moving: Item[],
  others: Item[],
  dx: number,
  dy: number,
  opts: { zoom: number; gridSnap?: boolean; spacing?: number; smartGuides?: boolean },
): { dx: number; dy: number; guides: AlignmentGuide[] } {
  const rawBounds = combinedBounds(moving);
  if (!rawBounds) return { dx, dy, guides: [] };

  const movingIds = new Set(moving.map(o => o.id));
  const useSmart = opts.smartGuides ?? true;
  const threshold = 6 / Math.max(0.05, opts.zoom || 1);

  const curX = rawBounds.x + dx;
  const curY = rawBounds.y + dy;
  const curW = rawBounds.w;
  const curH = rawBounds.h;

  let snapDx: number | undefined;
  let snapTargetX: number | undefined;
  let bestAbsX = Infinity;

  let snapDy: number | undefined;
  let snapTargetY: number | undefined;
  let bestAbsY = Infinity;

  const otherBounds: Rect[] = [];
  if (useSmart) {
    const mXs = [curX, curX + curW, curX + curW / 2];
    const mYs = [curY, curY + curH, curY + curH / 2];

    for (const o of others) {
      if (movingIds.has(o.id)) continue;
      const b = itemAABB(o, 0);
      otherBounds.push(b);

      const oXs = [b.x, b.x + b.w, b.x + b.w / 2];
      for (const mx of mXs) {
        for (const ox of oXs) {
          const diff = ox - mx;
          const abs = Math.abs(diff);
          if (abs <= threshold && abs < bestAbsX) {
            bestAbsX = abs;
            snapDx = diff;
            snapTargetX = ox;
          }
        }
      }

      const oYs = [b.y, b.y + b.h, b.y + b.h / 2];
      for (const my of mYs) {
        for (const oy of oYs) {
          const diff = oy - my;
          const abs = Math.abs(diff);
          if (abs <= threshold && abs < bestAbsY) {
            bestAbsY = abs;
            snapDy = diff;
            snapTargetY = oy;
          }
        }
      }
    }
  }

  let finalDx = dx + (snapDx ?? 0);
  let finalDy = dy + (snapDy ?? 0);

  if (opts.gridSnap) {
    const spacing = Math.max(1, opts.spacing ?? 28);
    if (snapDx === undefined) {
      const snappedX = Math.round((rawBounds.x + finalDx) / spacing) * spacing;
      finalDx = snappedX - rawBounds.x;
    }
    if (snapDy === undefined) {
      const snappedY = Math.round((rawBounds.y + finalDy) / spacing) * spacing;
      finalDy = snappedY - rawBounds.y;
    }
  }

  const guides: AlignmentGuide[] = [];
  const snappedLeft = rawBounds.x + finalDx;
  const snappedTop = rawBounds.y + finalDy;
  const snappedRight = snappedLeft + curW;
  const snappedBottom = snappedTop + curH;

  if (snapTargetX !== undefined) {
    let start = snappedTop;
    let end = snappedBottom;
    for (const b of otherBounds) {
      if (
        Math.abs(b.x - snapTargetX) < 1e-6
        || Math.abs(b.x + b.w / 2 - snapTargetX) < 1e-6
        || Math.abs(b.x + b.w - snapTargetX) < 1e-6
      ) {
        start = Math.min(start, b.y);
        end = Math.max(end, b.y + b.h);
      }
    }
    guides.push({ orientation: 'vertical', pos: snapTargetX, start, end });
  }

  if (snapTargetY !== undefined) {
    let start = snappedLeft;
    let end = snappedRight;
    for (const b of otherBounds) {
      if (
        Math.abs(b.y - snapTargetY) < 1e-6
        || Math.abs(b.y + b.h / 2 - snapTargetY) < 1e-6
        || Math.abs(b.y + b.h - snapTargetY) < 1e-6
      ) {
        start = Math.min(start, b.x);
        end = Math.max(end, b.x + b.w);
      }
    }
    guides.push({ orientation: 'horizontal', pos: snapTargetY, start, end });
  }

  return { dx: finalDx, dy: finalDy, guides };
}

export function alignItems(items: Item[], action: AlignAction): void {
  const unlocked = items.filter(o => !o.locked);
  if (action === 'distribute-h' || action === 'distribute-v') {
    if (unlocked.length < 3) return;
    const entries = unlocked.map((o, index) => ({ o, b: itemAABB(o, 0), index }));
    if (action === 'distribute-h') {
      entries.sort((a, b) => (a.b.x + a.b.w / 2) - (b.b.x + b.b.w / 2) || a.b.x - b.b.x || a.index - b.index);
      const first = entries[0];
      const last = entries[entries.length - 1];
      const totalSpan = (last.b.x + last.b.w) - first.b.x;
      const sumWidths = entries.reduce((sum, e) => sum + e.b.w, 0);
      const gap = (totalSpan - sumWidths) / (entries.length - 1);
      let cursor = first.b.x + first.b.w + gap;
      for (let i = 1; i < entries.length - 1; i++) {
        const entry = entries[i];
        entry.o.x += cursor - entry.b.x;
        cursor += entry.b.w + gap;
      }
    } else {
      entries.sort((a, b) => (a.b.y + a.b.h / 2) - (b.b.y + b.b.h / 2) || a.b.y - b.b.y || a.index - b.index);
      const first = entries[0];
      const last = entries[entries.length - 1];
      const totalSpan = (last.b.y + last.b.h) - first.b.y;
      const sumHeights = entries.reduce((sum, e) => sum + e.b.h, 0);
      const gap = (totalSpan - sumHeights) / (entries.length - 1);
      let cursor = first.b.y + first.b.h + gap;
      for (let i = 1; i < entries.length - 1; i++) {
        const entry = entries[i];
        entry.o.y += cursor - entry.b.y;
        cursor += entry.b.h + gap;
      }
    }
    return;
  }

  if (unlocked.length < 2) return;
  const entries = unlocked.map(o => ({ o, b: itemAABB(o, 0) }));
  const minLeft = Math.min(...entries.map(e => e.b.x));
  const maxRight = Math.max(...entries.map(e => e.b.x + e.b.w));
  const minTop = Math.min(...entries.map(e => e.b.y));
  const maxBottom = Math.max(...entries.map(e => e.b.y + e.b.h));

  switch (action) {
    case 'left':
      for (const { o, b } of entries) o.x += minLeft - b.x;
      break;
    case 'center-h': {
      const cx = (minLeft + maxRight) / 2;
      for (const { o, b } of entries) o.x += cx - (b.x + b.w / 2);
      break;
    }
    case 'right':
      for (const { o, b } of entries) o.x += maxRight - (b.x + b.w);
      break;
    case 'top':
      for (const { o, b } of entries) o.y += minTop - b.y;
      break;
    case 'center-v': {
      const cy = (minTop + maxBottom) / 2;
      for (const { o, b } of entries) o.y += cy - (b.y + b.h / 2);
      break;
    }
    case 'bottom':
      for (const { o, b } of entries) o.y += maxBottom - (b.y + b.h);
      break;
  }
}

function ensureShapePoints(o: Item): void {
  if (o.kind !== 'shape' || o.points?.length) return;
  if (o.shape === 'line' || o.shape === 'arrow') {
    o.points = [[0, 0, 0.5], [o.bw, o.bh, 0.5]];
  } else if (o.shape === 'triangle') {
    o.points = [[o.bw / 2, 0, 0.5], [o.bw, o.bh, 0.5], [0, o.bh, 0.5]];
  }
}

export function flipItems(items: Item[], axis: 'horizontal' | 'vertical'): void {
  const unlocked = items.filter(o => !o.locked);
  const bounds = combinedBounds(unlocked);
  if (!bounds) return;

  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;

  for (const o of unlocked) {
    if (axis === 'horizontal') {
      o.x = 2 * cx - o.x - o.w;
    } else {
      o.y = 2 * cy - o.y - o.h;
    }

    o.rotation = o.rotation ? -o.rotation : 0;

    ensureShapePoints(o);
    if (o.points) {
      o.points = o.points.map(([px, py, p]): Point => (
        axis === 'horizontal' ? [o.bw - px, py, p] : [px, o.bh - py, p]
      ));
    }

    if (o.frozenInk) {
      o.frozenInk = o.frozenInk.map(ring =>
        ring.map(([px, py]): [number, number] => (
          axis === 'horizontal' ? [o.bw - px, py] : [px, o.bh - py]
        )).reverse(),
      );
    }

    if (o.eraseMasks) {
      o.eraseMasks = o.eraseMasks.map(polygon =>
        polygon.map(ring =>
          ring.map(([px, py]): [number, number] => (
            axis === 'horizontal' ? [o.bw - px, py] : [px, o.bh - py]
          )).reverse(),
        ),
      );
    }

    if (o.pdfMarkup?.quadPoints) {
      o.pdfMarkup.quadPoints = o.pdfMarkup.quadPoints.map(([px, py, p]): Point => (
        axis === 'horizontal' ? [o.bw - px, py, p] : [px, o.bh - py, p]
      ));
    }
  }
}

export function filterSelectionByKind(
  items: Item[],
  selection: Set<string>,
  filter: SelectionFilterKind,
): Set<string> {
  const result = new Set<string>();
  for (const o of items) {
    if (!selection.has(o.id)) continue;
    if (filter === 'all') {
      result.add(o.id);
    } else if (filter === 'highlighter') {
      if (o.kind === 'stroke' && o.pen === 'highlighter') result.add(o.id);
    } else if (filter === 'stroke') {
      if (o.kind === 'stroke' && o.pen !== 'highlighter') result.add(o.id);
    } else if (o.kind === filter) {
      result.add(o.id);
    }
  }
  return result;
}
