import { Item, Notebook, Page, clone, normalizeInfinitePaper } from './model';
import type { Renderer } from './render';

export const INFINITE_MIN_ZOOM = 0.1;
export const INFINITE_MAX_ZOOM = 5;
export const A4_WIDTH = 794;
export const A4_HEIGHT = 1123;

export interface Camera { x: number; y: number; zoom: number; }
export interface Rect { x: number; y: number; w: number; h: number; }
export interface Size { w: number; h: number; }
export interface A4Tile { col: number; row: number; x: number; y: number; w: number; h: number; }

export function clampInfiniteZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.max(INFINITE_MIN_ZOOM, Math.min(INFINITE_MAX_ZOOM, zoom));
}

export function screenToWorld(sx: number, sy: number, camera: Camera, view: Size): [number, number] {
  const z = clampInfiniteZoom(camera.zoom);
  return [camera.x + (sx - view.w / 2) / z, camera.y + (sy - view.h / 2) / z];
}

export function worldToScreen(wx: number, wy: number, camera: Camera, view: Size): [number, number] {
  const z = clampInfiniteZoom(camera.zoom);
  return [(wx - camera.x) * z + view.w / 2, (wy - camera.y) * z + view.h / 2];
}

export function visibleWorldRect(camera: Camera, view: Size, padScreen = 0): Rect {
  const z = clampInfiniteZoom(camera.zoom);
  const halfW = (Math.max(1, view.w) / 2 + padScreen) / z;
  const halfH = (Math.max(1, view.h) / 2 + padScreen) / z;
  return { x: camera.x - halfW, y: camera.y - halfH, w: halfW * 2, h: halfH * 2 };
}

export function zoomAtScreenPoint(camera: Camera, targetZoom: number, sx: number, sy: number, view: Size): Camera {
  const z = clampInfiniteZoom(targetZoom);
  const [wx, wy] = screenToWorld(sx, sy, camera, view);
  return {
    x: wx - (sx - view.w / 2) / z,
    y: wy - (sy - view.h / 2) / z,
    zoom: z,
  };
}

export function pinchTransform(
  startCamera: Camera,
  startMid: [number, number],
  startDist: number,
  currMid: [number, number],
  currDist: number,
  view: Size,
): Camera {
  const [wx, wy] = screenToWorld(startMid[0], startMid[1], startCamera, view);
  const scale = currDist / Math.max(1, startDist);
  const z = clampInfiniteZoom(startCamera.zoom * scale);
  return {
    x: wx - (currMid[0] - view.w / 2) / z,
    y: wy - (currMid[1] - view.h / 2) / z,
    zoom: z,
  };
}

export function itemAABB(o: Pick<Item, 'x' | 'y' | 'w' | 'h' | 'rotation' | 'width'>, extraPad = 0): Rect {
  const a = (o.rotation || 0) * Math.PI / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const halfW = (o.w * c + o.h * s) / 2 + extraPad;
  const halfH = (o.w * s + o.h * c) / 2 + extraPad;
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  return { x: cx - halfW, y: cy - halfH, w: halfW * 2, h: halfH * 2 };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export function filterVisibleItems(items: Item[], viewRect: Rect, showResolved = true, excludeId?: string): Item[] {
  return items.filter(o => {
    if (o.id === excludeId) return false;
    if (o.resolved && !showResolved) return false;
    const pad = (o.width ?? 2) * 4 + 8;
    return rectsIntersect(itemAABB(o, pad), viewRect);
  });
}

export function contentBounds(items: Item[], pad = 0): Rect | null {
  if (!items.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of items) {
    const b = itemAABB(o, (o.width ?? 0) * 0.5);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX - pad, y: minY - pad, w: Math.max(1, maxX - minX) + pad * 2, h: Math.max(1, maxY - minY) + pad * 2 };
}

export function fitCameraToBounds(bounds: Rect | null, view: Size, margin = 48): Camera {
  if (!bounds || view.w <= 0 || view.h <= 0) return { x: 0, y: 0, zoom: 1 };
  const availW = Math.max(40, view.w - margin * 2);
  const availH = Math.max(40, view.h - margin * 2);
  const zoom = clampInfiniteZoom(Math.min(availW / Math.max(1, bounds.w), availH / Math.max(1, bounds.h), 1.5));
  return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2, zoom };
}

export function adaptiveGridStep(baseSpacing: number, zoom: number, minScreenGap = 14): number {
  let step = Math.max(8, Number.isFinite(baseSpacing) && baseSpacing > 0 ? baseSpacing : 28);
  const z = clampInfiniteZoom(zoom);
  while (step * z < minScreenGap && step < 16384) step *= 2;
  return step;
}

export function isDarkPaperColor(hex: string): boolean {
  const clean = (hex || '#ffffff').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return false;
  const n = parseInt(clean, 16);
  const lum = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
  return lum < 128;
}

let cachedDotTile: { key: string; canvas: HTMLCanvasElement } | undefined;

export function drawInfiniteBackground(
  ctx: CanvasRenderingContext2D,
  page: Pick<Page, 'paper' | 'color' | 'spacing'>,
  camera: Camera,
  view: Size,
  showGuides = false,
  dpr = 1,
  adaptive = true,
): void {
  const z = clampInfiniteZoom(camera.zoom);
  const w = Math.max(1, view.w), h = Math.max(1, view.h);
  const bg = page.color || '#ffffff';
  const dark = isDarkPaperColor(bg);
  const lineColor = dark ? 'rgba(255,255,255,0.16)' : '#9ba8b544';
  const dotColor = dark ? 'rgba(255,255,255,0.32)' : '#8898a988';
  const guideColor = dark ? 'rgba(148,163,184,0.45)' : 'rgba(100,116,139,0.42)';
  const originColor = dark ? 'rgba(148,163,184,0.55)' : 'rgba(100,116,139,0.45)';

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const paper = normalizeInfinitePaper(page.paper);
  const step = adaptive
    ? adaptiveGridStep(page.spacing, z, 14)
    : Math.max(8, Number.isFinite(page.spacing) && page.spacing > 0 ? page.spacing : 28);
  const rect = visibleWorldRect({ ...camera, zoom: z }, { w, h }, 4);

  if (paper === 'dots') {
    const cell = step * z;
    if (typeof document !== 'undefined' && typeof DOMMatrix !== 'undefined' && typeof ctx.createPattern === 'function' && cell >= 4) {
      const tilePx = Math.max(4, Math.min(512, Math.round(cell * dpr)));
      const radius = Math.max(0.9, Math.min(2.2, 1.15 * dpr));
      const key = `${tilePx}:${radius.toFixed(2)}:${dotColor}`;
      let tile = cachedDotTile?.key === key ? cachedDotTile.canvas : undefined;
      if (!tile) {
        tile = document.createElement('canvas');
        tile.width = tile.height = tilePx;
        const tctx = tile.getContext('2d');
        if (tctx) {
          tctx.fillStyle = dotColor;
          for (const tx of [0, tilePx]) {
            for (const ty of [0, tilePx]) {
              tctx.beginPath();
              tctx.arc(tx, ty, radius, 0, Math.PI * 2);
              tctx.fill();
            }
          }
        }
        cachedDotTile = { key, canvas: tile };
      }
      const pattern = ctx.createPattern(tile, 'repeat');
      if (pattern) {
        const ox = ((w / 2 - camera.x * z) % cell + cell) % cell;
        const oy = ((h / 2 - camera.y * z) % cell + cell) % cell;
        pattern.setTransform(new DOMMatrix().translate(ox, oy).scale(cell / tilePx, cell / tilePx));
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, w, h);
      }
    } else {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(z, z);
      ctx.translate(-camera.x, -camera.y);
      const startX = Math.floor(rect.x / step) * step;
      const endX = Math.ceil((rect.x + rect.w) / step) * step;
      const startY = Math.floor(rect.y / step) * step;
      const endY = Math.ceil((rect.y + rect.h) / step) * step;
      const r = Math.max(0.8 / z, Math.min(1.6, 1.15 / z));
      ctx.fillStyle = dotColor;
      ctx.beginPath();
      for (let y = startY; y <= endY; y += step) {
        for (let x = startX; x <= endX; x += step) {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
      ctx.restore();
    }
  } else if (paper === 'grid' || paper === 'ruled') {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(z, z);
    ctx.translate(-camera.x, -camera.y);
    const startX = Math.floor(rect.x / step) * step;
    const endX = Math.ceil((rect.x + rect.w) / step) * step;
    const startY = Math.floor(rect.y / step) * step;
    const endY = Math.ceil((rect.y + rect.h) / step) * step;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 0.85 / z;
    ctx.beginPath();
    for (let y = startY; y <= endY; y += step) {
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
    }
    if (paper === 'grid') {
      for (let x = startX; x <= endX; x += step) {
        ctx.moveTo(x, rect.y);
        ctx.lineTo(x, rect.y + rect.h);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  if (adaptive || showGuides) {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(z, z);
    ctx.translate(-camera.x, -camera.y);

    if (adaptive && rect.x <= 24 / z && rect.x + rect.w >= -24 / z && rect.y <= 24 / z && rect.y + rect.h >= -24 / z) {
      const arm = 10 / z;
      ctx.strokeStyle = originColor;
      ctx.lineWidth = 1.2 / z;
      ctx.beginPath();
      ctx.moveTo(-arm, 0); ctx.lineTo(arm, 0);
      ctx.moveTo(0, -arm); ctx.lineTo(0, arm);
      ctx.stroke();
    }

    if (showGuides) {
      const startCol = Math.floor(rect.x / A4_WIDTH);
      const endCol = Math.ceil((rect.x + rect.w) / A4_WIDTH);
      const startRow = Math.floor(rect.y / A4_HEIGHT);
      const endRow = Math.ceil((rect.y + rect.h) / A4_HEIGHT);
      ctx.strokeStyle = guideColor;
      ctx.lineWidth = 1.1 / z;
      ctx.setLineDash([8 / z, 6 / z]);
      ctx.beginPath();
      for (let col = startCol; col <= endCol; col++) {
        const x = col * A4_WIDTH;
        ctx.moveTo(x, rect.y);
        ctx.lineTo(x, rect.y + rect.h);
      }
      for (let row = startRow; row <= endRow; row++) {
        const y = row * A4_HEIGHT;
        ctx.moveTo(rect.x, y);
        ctx.lineTo(rect.x + rect.w, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (z >= 0.25 && typeof ctx.fillText === 'function') {
        ctx.fillStyle = guideColor;
        ctx.font = `${11 / z}px sans-serif`;
        ctx.textBaseline = 'top';
        for (let row = startRow; row < endRow; row++) {
          for (let col = startCol; col < endCol; col++) {
            ctx.fillText(`A4 (${col}, ${row})`, col * A4_WIDTH + 8 / z, row * A4_HEIGHT + 6 / z);
          }
        }
      }
    }
    ctx.restore();
  }

  ctx.restore();
}

export function computeA4Tiles(items: Item[], tileW = A4_WIDTH, tileH = A4_HEIGHT): A4Tile[] {
  if (!items.length) return [];
  const seen = new Map<string, A4Tile>();
  for (const o of items) {
    const b = itemAABB(o, (o.width ?? 2) * 0.5);
    const colMin = Math.floor(b.x / tileW);
    const colMax = Math.max(colMin, Math.floor((b.x + Math.max(0.001, b.w) - 1e-6) / tileW));
    const rowMin = Math.floor(b.y / tileH);
    const rowMax = Math.max(rowMin, Math.floor((b.y + Math.max(0.001, b.h) - 1e-6) / tileH));
    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        const key = `${col},${row}`;
        if (!seen.has(key)) seen.set(key, { col, row, x: col * tileW, y: row * tileH, w: tileW, h: tileH });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.row - b.row || a.col - b.col);
}

export function buildVirtualExportPage(sourcePage: Page, region: Rect, title?: string): Page {
  const visible = filterVisibleItems(sourcePage.items, region, true);
  const shifted = clone(visible).map(o => {
    o.x -= region.x;
    o.y -= region.y;
    return o;
  });
  return {
    ...clone({ ...sourcePage, items: [] }),
    id: `${sourcePage.id}-export`,
    title: title ?? sourcePage.title,
    width: Math.max(10, Math.round(region.w)),
    height: Math.max(10, Math.round(region.h)),
    paper: normalizeInfinitePaper(sourcePage.paper),
    background: undefined,
    items: shifted,
  };
}

export async function renderInfiniteExportCanvas(
  page: Page,
  book: Notebook,
  renderer: Renderer,
  region: Rect,
  scale = 1.5,
  mode: 'all' | 'ink' | 'background' = 'all',
): Promise<HTMLCanvasElement> {
  const rw = Math.max(10, region.w), rh = Math.max(10, region.h);
  const actualScale = Math.min(scale, Math.sqrt(16_000_000 / (rw * rh)), 16384 / rw, 16384 / rh);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rw * actualScale));
  canvas.height = Math.max(1, Math.round(rh * actualScale));
  const ctx = canvas.getContext('2d')!;
  try {
    if (mode !== 'ink') {
      drawInfiniteBackground(
        ctx,
        page,
        { x: region.x + rw / 2, y: region.y + rh / 2, zoom: 1 },
        { w: rw, h: rh },
        false,
        actualScale,
        false,
      );
    }
    if (mode !== 'background') {
      const visible = filterVisibleItems(page.items, region, true);
      ctx.save();
      ctx.setTransform(actualScale, 0, 0, actualScale, 0, 0);
      ctx.translate(-region.x, -region.y);
      for (const o of visible) {
        const img = o.resource ? await renderer.image(o.resource, book).catch(() => undefined) : undefined;
        renderer.draw(ctx, o, img);
      }
      ctx.restore();
    }
    return canvas;
  } catch (error) {
    canvas.width = canvas.height = 1;
    throw error;
  }
}
