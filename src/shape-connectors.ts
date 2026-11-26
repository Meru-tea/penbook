import { itemAABB } from './infinite';
import { Item, Point } from './model';

type XY = [number, number];

export type AnchorSide = 'center' | 'top' | 'right' | 'bottom' | 'left';
export interface EndpointBinding {
  itemId: string;
  anchor: AnchorSide;
}
export type ConnectorRoute = 'straight' | 'elbow' | 'curved';
export type ConnectorItem = Item & {
  startBinding?: EndpointBinding;
  endBinding?: EndpointBinding;
  connectorRoute?: ConnectorRoute;
};

export interface ShapeAnchor {
  anchor: AnchorSide;
  x: number;
  y: number;
  nx: number;
  ny: number;
}

export interface AnchorHit {
  item: Item;
  anchor: AnchorSide;
  x: number;
  y: number;
  nx: number;
  ny: number;
}

export const CONNECTABLE_SHAPES = new Set<string>([
  'rectangle',
  'rounded',
  'diamond',
  'ellipse',
  'triangle',
  'sticky',
  'text',
]);

const CARDINAL_SIDES: readonly { anchor: AnchorSide; dx: number; dy: number }[] = [
  { anchor: 'top', dx: 0, dy: -1 },
  { anchor: 'right', dx: 1, dy: 0 },
  { anchor: 'bottom', dx: 0, dy: 1 },
  { anchor: 'left', dx: -1, dy: 0 },
];

function safeZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function pointDistance(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pointToSegmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function orient2d(a: XY, b: XY, c: XY): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const o1 = orient2d(a, b, c);
  const o2 = orient2d(a, b, d);
  const o3 = orient2d(c, d, a);
  const o4 = orient2d(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

function segmentToSegmentDistance(a: XY, b: XY, c: XY, d: XY): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointToSegmentDistance(a, c, d),
    pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b),
    pointToSegmentDistance(d, a, b),
  );
}

function localToWorld(o: Item, lx: number, ly: number): XY {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const ux = (lx * o.w) / Math.max(1e-6, o.bw) - o.w / 2;
  const uy = (ly * o.h) / Math.max(1e-6, o.bh) - o.h / 2;
  const rad = ((o.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cx + ux * cos - uy * sin, cy + ux * sin + uy * cos];
}

function rayPolygonHit(origin: XY, dir: XY, vertices: XY[]): XY | null {
  let bestT = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const denom = dir[0] * ey - dir[1] * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const qx = a[0] - origin[0];
    const qy = a[1] - origin[1];
    const t = (qx * ey - qy * ex) / denom;
    const u = (qx * dir[1] - qy * dir[0]) / denom;
    if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && t < bestT) {
      bestT = t;
    }
  }
  return Number.isFinite(bestT) ? [origin[0] + dir[0] * bestT, origin[1] + dir[1] * bestT] : null;
}

function isConnectableItem(o: Item): boolean {
  if (o.kind === 'shape') return Boolean(o.shape && CONNECTABLE_SHAPES.has(o.shape));
  return CONNECTABLE_SHAPES.has(o.kind);
}

/**
 * Detects a rapid back-and-forth zig-zag scribble gesture while rejecting
 * straight lines, circles, triangles, and normal handwriting strokes.
 */
export function isScribbleGesture(points: Point[], zoom: number): boolean {
  const valid: XY[] = [];
  for (const p of points) {
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) valid.push([p[0], p[1]]);
  }
  if (valid.length < 10) return false;

  const z = safeZoom(zoom);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of valid) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  if (diagonal < 18 / z) return false;

  const minSeg = 3 / z;
  const filtered: XY[] = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    if (pointDistance(valid[i], filtered[filtered.length - 1]) >= minSeg) {
      filtered.push(valid[i]);
    }
  }
  if (filtered.length < 4) return false;

  const dirs: { ux: number; uy: number; len: number }[] = [];
  let pathLength = 0;
  for (let i = 1; i < filtered.length; i++) {
    const dx = filtered[i][0] - filtered[i - 1][0];
    const dy = filtered[i][1] - filtered[i - 1][1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    pathLength += len;
    dirs.push({ ux: dx / len, uy: dy / len, len });
  }
  if (dirs.length < 4 || pathLength / diagonal < 2.6) return false;

  let reversals = 0;
  for (let i = 0; i < dirs.length - 1; i++) {
    const dot = dirs[i].ux * dirs[i + 1].ux + dirs[i].uy * dirs[i + 1].uy;
    if (dot < -0.42) {
      reversals++;
    } else if (i + 2 < dirs.length && dirs[i + 1].len < Math.min(10 / z, diagonal * 0.2)) {
      // Catch slightly rounded 1-step turnarounds at scribble apexes without triggering on curves.
      const skipDot = dirs[i].ux * dirs[i + 2].ux + dirs[i].uy * dirs[i + 2].uy;
      if (skipDot < -0.42) {
        reversals++;
        i++;
      }
    }
  }
  return reversals >= 3;
}

function polylineHitsPolyline(a: XY[], b: XY[], hitDist: number): boolean {
  if (!a.length || !b.length) return false;
  if (a.length === 1 && b.length === 1) return pointDistance(a[0], b[0]) <= hitDist;
  if (a.length === 1) {
    for (let j = 1; j < b.length; j++) {
      if (pointToSegmentDistance(a[0], b[j - 1], b[j]) <= hitDist) return true;
    }
    return false;
  }
  if (b.length === 1) {
    for (let i = 1; i < a.length; i++) {
      if (pointToSegmentDistance(b[0], a[i - 1], a[i]) <= hitDist) return true;
    }
    return false;
  }
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      if (segmentToSegmentDistance(a[i - 1], a[i], b[j - 1], b[j]) <= hitDist) return true;
    }
  }
  return false;
}

/**
 * Returns unlocked stroke items whose geometry intersects the scribble path within `radius`.
 */
export function findScribbleTargets(points: Point[], items: Item[], radius: number): Item[] {
  const scribble: XY[] = [];
  for (const p of points) {
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) scribble.push([p[0], p[1]]);
  }
  if (!scribble.length) return [];

  const r = Math.max(0, Number.isFinite(radius) ? radius : 0);
  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  for (const [x, y] of scribble) {
    if (x < sMinX) sMinX = x;
    if (y < sMinY) sMinY = y;
    if (x > sMaxX) sMaxX = x;
    if (y > sMaxY) sMaxY = y;
  }
  sMinX -= r; sMinY -= r; sMaxX += r; sMaxY += r;

  const hits: Item[] = [];
  for (const o of items) {
    if (o.kind !== 'stroke' || o.locked) continue;
    const box = itemAABB(o, (o.width ?? 2) * 0.5 + r);
    if (box.x > sMaxX || box.x + box.w < sMinX || box.y > sMaxY || box.y + box.h < sMinY) continue;

    const hitDist = r + (o.width ?? 2) * 0.5;
    if (o.frozenInk?.length) {
      const rings = o.frozenInk.map(ring => {
        const worldRing = ring.map(([lx, ly]) => localToWorld(o, lx, ly));
        if (worldRing.length > 1) worldRing.push(worldRing[0]);
        return worldRing;
      });
      if (rings.some(ring => polylineHitsPolyline(scribble, ring, hitDist))) hits.push(o);
      continue;
    }

    if (o.points?.length) {
      const worldStroke = o.points.map(([lx, ly]) => localToWorld(o, lx, ly));
      if (polylineHitsPolyline(scribble, worldStroke, hitDist)) hits.push(o);
      continue;
    }

    hits.push(o);
  }
  return hits;
}

/**
 * Computes world-space anchor points and outward unit normals for a shape or box item,
 * respecting `o.rotation`.
 */
export function getShapeAnchors(o: Item): ShapeAnchor[] {
  const w = Math.max(1, o.w);
  const h = Math.max(1, o.h);
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const rad = ((o.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  let triangleVerts: XY[] | null = null;
  let triangleCentroid: XY = [0, 0];
  if (o.kind === 'shape' && o.shape === 'triangle') {
    const raw = o.points?.length && o.points.length >= 3
      ? o.points.slice(0, 3).map(([lx, ly]) => [(lx * w) / Math.max(1e-6, o.bw) - w / 2, (ly * h) / Math.max(1e-6, o.bh) - h / 2] as XY)
      : ([[0, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as XY[]);
    triangleVerts = raw;
    triangleCentroid = [
      (raw[0][0] + raw[1][0] + raw[2][0]) / 3,
      (raw[0][1] + raw[1][1] + raw[2][1]) / 3,
    ];
  }

  const anchors: ShapeAnchor[] = [];
  for (const side of CARDINAL_SIDES) {
    let ux = (side.dx * w) / 2;
    let uy = (side.dy * h) / 2;
    if (triangleVerts) {
      const hit = rayPolygonHit(triangleCentroid, [side.dx, side.dy], triangleVerts);
      if (hit) {
        ux = hit[0];
        uy = hit[1];
      }
    }
    anchors.push({
      anchor: side.anchor,
      x: cx + ux * cos - uy * sin,
      y: cy + ux * sin + uy * cos,
      nx: side.dx * cos - side.dy * sin,
      ny: side.dx * sin + side.dy * cos,
    });
  }
  anchors.push({ anchor: 'center', x: cx, y: cy, nx: 0, ny: 0 });
  return anchors;
}

/**
 * Finds the nearest connectable shape anchor within `threshold` world units.
 */
export function findNearestAnchor(
  pt: XY,
  items: Item[],
  threshold: number,
  excludeIds?: Set<string>,
): AnchorHit | null {
  let best: AnchorHit | null = null;
  let bestDist = threshold;
  for (const o of items) {
    if (excludeIds?.has(o.id) || o.resolved || !isConnectableItem(o)) continue;
    for (const a of getShapeAnchors(o)) {
      const d = Math.hypot(pt[0] - a.x, pt[1] - a.y);
      if (d <= bestDist) {
        bestDist = d;
        best = { item: o, anchor: a.anchor, x: a.x, y: a.y, nx: a.nx, ny: a.ny };
      }
    }
  }
  return best;
}

/**
 * Builds world-space polyline points for a connector with `straight`, `elbow`, or `curved` routing.
 */
export function computeConnectorPoints(
  start: XY,
  end: XY,
  route: ConnectorRoute,
  startNormal?: XY,
  endNormal?: XY,
): Point[] {
  if (route === 'straight') {
    return [[start[0], start[1], 0.5], [end[0], end[1], 0.5]];
  }

  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-3) {
    return [[start[0], start[1], 0.5], [end[0], end[1], 0.5]];
  }

  const hasSn = Boolean(startNormal && Math.hypot(startNormal[0], startNormal[1]) > 0.1);
  const hasEn = Boolean(endNormal && Math.hypot(endNormal[0], endNormal[1]) > 0.1);

  if (route === 'elbow') {
    const startHoriz = hasSn ? Math.abs(startNormal![0]) >= Math.abs(startNormal![1]) : Math.abs(dx) >= Math.abs(dy);
    const endHoriz = hasEn ? Math.abs(endNormal![0]) >= Math.abs(endNormal![1]) : startHoriz;

    if (startHoriz !== endHoriz) {
      const corner: XY = startHoriz ? [end[0], start[1]] : [start[0], end[1]];
      return [[start[0], start[1], 0.5], [corner[0], corner[1], 0.5], [end[0], end[1], 0.5]];
    }

    if (startHoriz) {
      const stub = 24;
      const sameSide = hasSn && hasEn && startNormal![0] * endNormal![0] > 0.5;
      const midX = sameSide
        ? (startNormal![0] >= 0 ? Math.max(start[0], end[0]) + stub : Math.min(start[0], end[0]) - stub)
        : (start[0] + end[0]) / 2;
      return [
        [start[0], start[1], 0.5],
        [midX, start[1], 0.5],
        [midX, end[1], 0.5],
        [end[0], end[1], 0.5],
      ];
    }

    const stub = 24;
    const sameSide = hasSn && hasEn && startNormal![1] * endNormal![1] > 0.5;
    const midY = sameSide
      ? (startNormal![1] >= 0 ? Math.max(start[1], end[1]) + stub : Math.min(start[1], end[1]) - stub)
      : (start[1] + end[1]) / 2;
    return [
      [start[0], start[1], 0.5],
      [start[0], midY, 0.5],
      [end[0], midY, 0.5],
      [end[0], end[1], 0.5],
    ];
  }

  // Curved cubic Bezier route using anchor normals when available, or a gentle perpendicular arc.
  const handle = Math.max(24, Math.min(180, dist * 0.45));
  let c1: XY;
  let c2: XY;
  if (!hasSn && !hasEn) {
    const nx = -dy / dist;
    const ny = dx / dist;
    const arch = Math.min(64, dist * 0.24);
    c1 = [start[0] + dx * 0.33 + nx * arch, start[1] + dy * 0.33 + ny * arch];
    c2 = [start[0] + dx * 0.67 + nx * arch, start[1] + dy * 0.67 + ny * arch];
  } else {
    c1 = hasSn
      ? [start[0] + startNormal![0] * handle, start[1] + startNormal![1] * handle]
      : [start[0] + dx * 0.35, start[1] + dy * 0.35];
    c2 = hasEn
      ? [end[0] + endNormal![0] * handle, end[1] + endNormal![1] * handle]
      : [end[0] - dx * 0.35, end[1] - dy * 0.35];
  }

  const steps = 20;
  const result: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const x = mt2 * mt * start[0] + 3 * mt2 * t * c1[0] + 3 * mt * t2 * c2[0] + t2 * t * end[0];
    const y = mt2 * mt * start[1] + 3 * mt2 * t * c1[1] + 3 * mt * t2 * c2[1] + t2 * t * end[1];
    result.push([x, y, 0.5]);
  }
  return result;
}

function applyWorldPointsToConnector(o: ConnectorItem, worldPts: Point[]): ConnectorItem {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of worldPts) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  o.x = minX;
  o.y = minY;
  o.w = w;
  o.h = h;
  o.bw = w;
  o.bh = h;
  o.rotation = 0;
  o.points = worldPts.map(([px, py, pr]) => [px - minX, py - minY, pr]);
  return o;
}

/**
 * Adjusts a newly snapped shape while the user continues dragging after hold-to-snap.
 * Connectors (`line`/`arrow`) snap endpoints to shape anchors or 45-degree angles;
 * closed shapes resize smoothly from their center without discarding the snapped shape.
 */
export function adjustSnappedShape(
  snapped: Item,
  start: Point,
  current: Point,
  items: Item[],
  zoom: number,
): ConnectorItem {
  const z = safeZoom(zoom);
  const copy: ConnectorItem = {
    ...snapped,
    points: snapped.points?.map(p => [p[0], p[1], p[2]] as Point),
  };

  if (copy.shape === 'line' || copy.shape === 'arrow') {
    const exclude = new Set([copy.id]);
    const snapThreshold = 18 / z;

    const startHit = findNearestAnchor([start[0], start[1]], items, snapThreshold, exclude);
    const p0: XY = startHit ? [startHit.x, startHit.y] : [start[0], start[1]];
    const startNormal: XY | undefined = startHit ? [startHit.nx, startHit.ny] : undefined;
    if (startHit) copy.startBinding = { itemId: startHit.item.id, anchor: startHit.anchor };
    else delete copy.startBinding;

    const endHit = findNearestAnchor([current[0], current[1]], items, snapThreshold, exclude);
    let p1: XY;
    let endNormal: XY | undefined;
    if (endHit) {
      p1 = [endHit.x, endHit.y];
      endNormal = [endHit.nx, endHit.ny];
      copy.endBinding = { itemId: endHit.item.id, anchor: endHit.anchor };
    } else {
      delete copy.endBinding;
      const dx = current[0] - p0[0];
      const dy = current[1] - p0[1];
      const len = Math.hypot(dx, dy);
      if (len > 1e-3) {
        let angle = Math.atan2(dy, dx);
        const nearest45 = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        if (Math.abs(angle - nearest45) < Math.PI / 24) angle = nearest45;
        p1 = [p0[0] + len * Math.cos(angle), p0[1] + len * Math.sin(angle)];
      } else {
        p1 = [current[0], current[1]];
      }
    }

    const route: ConnectorRoute = copy.connectorRoute ?? 'straight';
    copy.connectorRoute = route;
    const worldPts = computeConnectorPoints(p0, p1, route, startNormal, endNormal);
    return applyWorldPointsToConnector(copy, worldPts);
  }

  // Closed shapes: proportional resize around the snapped shape's center.
  const cx = snapped.x + snapped.w / 2;
  const cy = snapped.y + snapped.h / 2;
  const rStart = Math.hypot(start[0] - cx, start[1] - cy);
  const baseRef = rStart >= 8 ? rStart : Math.max(8, Math.hypot(snapped.w, snapped.h) / 2);
  const rCurr = Math.hypot(current[0] - cx, current[1] - cy);
  const minScale = Math.max(8 / Math.max(1, snapped.w), 8 / Math.max(1, snapped.h));
  const scale = Math.max(minScale, Math.min(10, rCurr / baseRef));

  const newW = Math.max(8, snapped.w * scale);
  const newH = Math.max(8, snapped.h * scale);
  copy.x = cx - newW / 2;
  copy.y = cy - newH / 2;
  copy.w = newW;
  copy.h = newH;
  if (copy.points?.length) {
    const sx = newW / Math.max(1e-6, snapped.bw);
    const sy = newH / Math.max(1e-6, snapped.bh);
    copy.points = copy.points.map(([px, py, pr]) => [px * sx, py * sy, pr] as Point);
  }
  copy.bw = newW;
  copy.bh = newH;
  return copy;
}

/**
 * Recomputes geometry for all connectors bound to any item in `movedIds`.
 * Returns the IDs of connectors that were updated.
 */
export function updateBoundConnectors(items: Item[], movedIds: Set<string>): string[] {
  if (!movedIds.size) return [];
  const byId = new Map(items.map(o => [o.id, o]));
  const updated: string[] = [];

  for (const o of items) {
    if (o.kind !== 'shape' || (o.shape !== 'line' && o.shape !== 'arrow')) continue;
    const conn = o as ConnectorItem;
    const startHitMoved = Boolean(conn.startBinding && movedIds.has(conn.startBinding.itemId));
    const endHitMoved = Boolean(conn.endBinding && movedIds.has(conn.endBinding.itemId));
    if (!startHitMoved && !endHitMoved) continue;

    const rawStart = o.points?.[0] ? localToWorld(o, o.points[0][0], o.points[0][1]) : localToWorld(o, 0, 0);
    const rawEnd = o.points?.length ? localToWorld(o, o.points[o.points.length - 1][0], o.points[o.points.length - 1][1]) : localToWorld(o, o.bw, o.bh);

    let startPt: XY = rawStart;
    let startNormal: XY | undefined;
    if (conn.startBinding) {
      const target = byId.get(conn.startBinding.itemId);
      if (target) {
        const anchors = getShapeAnchors(target);
        const found = anchors.find(a => a.anchor === conn.startBinding!.anchor) ?? anchors.find(a => a.anchor === 'center');
        if (found) {
          startPt = [found.x, found.y];
          if (found.anchor !== 'center') startNormal = [found.nx, found.ny];
        }
      }
    }

    let endPt: XY = rawEnd;
    let endNormal: XY | undefined;
    if (conn.endBinding) {
      const target = byId.get(conn.endBinding.itemId);
      if (target) {
        const anchors = getShapeAnchors(target);
        const found = anchors.find(a => a.anchor === conn.endBinding!.anchor) ?? anchors.find(a => a.anchor === 'center');
        if (found) {
          endPt = [found.x, found.y];
          if (found.anchor !== 'center') endNormal = [found.nx, found.ny];
        }
      }
    }

    const route: ConnectorRoute = conn.connectorRoute ?? 'straight';
    const worldPts = computeConnectorPoints(startPt, endPt, route, startNormal, endNormal);
    applyWorldPointsToConnector(conn, worldPts);
    updated.push(o.id);
  }
  return updated;
}

/**
 * Removes `startBinding` and `endBinding` references to item IDs no longer present in `items`.
 */
export function clearDanglingBindings(items: Item[]): void {
  const present = new Set(items.map(o => o.id));
  for (const o of items) {
    const conn = o as ConnectorItem;
    if (conn.startBinding && !present.has(conn.startBinding.itemId)) delete conn.startBinding;
    if (conn.endBinding && !present.has(conn.endBinding.itemId)) delete conn.endBinding;
  }
}
