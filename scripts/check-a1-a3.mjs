import assert from 'node:assert/strict';
import { build } from 'esbuild';

const obsidianStubPlugin = {
  name: 'obsidian-stub',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-stub', namespace: 'obsidian-stub' }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({
      contents: `
        export function addIcon() {}
        export class App {}
        export class Modal { constructor(app) { this.app = app; } open() {} close() {} }
        export class FuzzySuggestModal extends Modal {}
        export class TFile {}
        export class Setting {
          constructor(container) { this.container = container; this.controlEl = container; }
          setName() { return this; }
          addText(cb) { cb?.({ inputEl: { addEventListener() {} }, setValue() { return this; }, onChange() { return this; } }); return this; }
          addTextArea(cb) { cb?.({ setValue() { return this; }, onChange() { return this; } }); return this; }
          addDropdown(cb) { cb?.({ addOptions() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
          addToggle(cb) { cb?.({ setValue() { return this; }, onChange() { return this; } }); return this; }
          addButton(cb) { cb?.({ buttonEl: { style: {} }, setButtonText() { return this; }, setCta() { return this; }, setWarning() { return this; }, onClick() { return this; } }); return this; }
        }
      `,
      loader: 'js',
    }));
  },
};

const bundle = await build({
  stdin: {
    contents: `
      export * from './src/pen-favorites';
      export * from './src/selection-tools';
      export { item, stroke } from './src/model';
    `,
    loader: 'ts',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  loader: { '.svg': 'text' },
  plugins: [obsidianStubPlugin],
});

const mod = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const {
  MAX_PEN_FAVORITES,
  DEFAULT_PEN_FAVORITES,
  normalizePenFavorites,
  isFavoriteActive,
  upsertPenFavorite,
  removePenFavorite,
  itemsInRect,
  computeMoveSnap,
  alignItems,
  flipItems,
  filterSelectionByKind,
  item,
  stroke,
} = mod;

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// =========================================================================
// A1: Pen Favorites tests
// =========================================================================
{
  assert.equal(MAX_PEN_FAVORITES, 6);
  assert.equal(DEFAULT_PEN_FAVORITES.length, 4);
  assert.deepEqual(
    DEFAULT_PEN_FAVORITES.map(f => [f.name, f.pen, f.color, f.width, f.style]),
    [
      ['黑钢笔', 'fountain', '#000000', 2.5, 'solid'],
      ['红重点笔', 'fountain', '#d93025', 2.5, 'solid'],
      ['蓝笔记笔', 'ballpoint', '#1a73e8', 2.5, 'solid'],
      ['黄荧光笔', 'highlighter', '#facc15', 14, 'solid'],
    ],
  );

  // Fallback to cloned defaults when empty or undefined or all invalid
  const def1 = normalizePenFavorites(undefined);
  const def2 = normalizePenFavorites([]);
  assert.equal(def1.length, 4);
  assert.equal(def2.length, 4);
  assert.notEqual(def1[0], DEFAULT_PEN_FAVORITES[0]);
  def1[0].name = 'mutated';
  assert.equal(DEFAULT_PEN_FAVORITES[0].name, '黑钢笔');

  // Sanitizes invalid entries, deduplicates ids, clamps width & max 6
  const mixed = normalizePenFavorites([
    { id: 'dup', name: '  Custom 1 ', pen: 'brush', color: '#ABC', width: 99, style: 'dashed' },
    { id: 'dup', name: '', pen: 'pencil', color: '#112233', width: 0.1, style: 'unknown' },
    { id: 'bad-pen', name: 'bad', pen: 'crayon', color: '#000000', width: 2, style: 'solid' },
    { id: 'bad-width', name: 'bad', pen: 'fountain', color: '#000000', width: -3, style: 'solid' },
    { id: '3', name: '3', pen: 'fountain', color: '#000000', width: 2, style: 'solid' },
    { id: '4', name: '4', pen: 'fountain', color: '#000000', width: 2, style: 'solid' },
    { id: '5', name: '5', pen: 'fountain', color: '#000000', width: 2, style: 'solid' },
    { id: '6', name: '6', pen: 'fountain', color: '#000000', width: 2, style: 'solid' },
    { id: '7', name: '7', pen: 'fountain', color: '#000000', width: 2, style: 'solid' },
  ]);
  assert.equal(mixed.length, 6);
  assert.equal(mixed[0].name, 'Custom 1');
  assert.equal(mixed[0].color, '#aabbcc');
  assert.equal(mixed[0].width, 50);
  assert.equal(mixed[0].style, 'dashed');
  assert.notEqual(mixed[1].id, 'dup');
  assert.equal(mixed[1].name, '铅笔');
  assert.equal(mixed[1].width, 0.5);
  assert.equal(mixed[1].style, 'solid');
  assert.equal(mixed[5].id, '6');

  // isFavoriteActive
  const fav = DEFAULT_PEN_FAVORITES[0];
  assert.equal(isFavoriteActive(fav, { pen: 'fountain', color: '#000', width: 2.52, style: 'solid' }), true);
  assert.equal(isFavoriteActive(fav, { pen: 'ballpoint', color: '#000000', width: 2.5, style: 'solid' }), false);
  assert.equal(isFavoriteActive(fav, { pen: 'fountain', color: '#111111', width: 2.5, style: 'solid' }), false);
  assert.equal(isFavoriteActive(fav, { pen: 'fountain', color: '#000000', width: 3.0, style: 'solid' }), false);
  assert.equal(isFavoriteActive(fav, { pen: 'fountain', color: '#000000', width: 2.5, style: 'dashed' }), false);

  // upsertPenFavorite: insert, update in place, cap at MAX_PEN_FAVORITES
  let list = normalizePenFavorites();
  list = upsertPenFavorite(list, { id: 'c1', name: '绿笔', pen: 'ballpoint', color: '#00aa44', width: 3, style: 'solid' });
  assert.equal(list.length, 5);
  list = upsertPenFavorite(list, { id: 'c1', name: '深绿笔', pen: 'ballpoint', color: '#007722', width: 4, style: 'dotted' });
  assert.equal(list.length, 5);
  assert.equal(list[4].name, '深绿笔');
  assert.equal(list[4].style, 'dotted');
  list = upsertPenFavorite(list, { id: 'c2', name: '紫笔', pen: 'brush', color: '#7b2a90', width: 5, style: 'solid' });
  assert.equal(list.length, 6);
  // 7th distinct id should not overflow MAX_PEN_FAVORITES
  const capped = upsertPenFavorite(list, { id: 'c3', name: '溢出', pen: 'fountain', color: '#222222', width: 2, style: 'solid' });
  assert.equal(capped.length, 6);
  // Updating an existing id at capacity works
  const updatedAtCap = upsertPenFavorite(capped, { id: 'c2', name: '更新紫笔', pen: 'brush', color: '#8833aa', width: 6, style: 'solid' });
  assert.equal(updatedAtCap.length, 6);
  assert.equal(updatedAtCap[5].name, '更新紫笔');

  // removePenFavorite keeps at least 1 slot
  const removed = removePenFavorite(updatedAtCap, 'c2');
  assert.equal(removed.length, 5);
  assert.equal(removed.some(f => f.id === 'c2'), false);
  let single = removed;
  for (const f of removed.slice(0, 4)) single = removePenFavorite(single, f.id);
  assert.equal(single.length, 1);
  const keepLast = removePenFavorite(single, single[0].id);
  assert.equal(keepLast.length, 1);
  assert.equal(keepLast[0].id, single[0].id);
}

// =========================================================================
// A3: Rectangular Marquee (itemsInRect) including groups & rotated items
// =========================================================================
{
  const a = { ...item('shape', 100, 100, 50, 50, '#000'), id: 'a', group: 'g1' };
  const b = { ...item('shape', 500, 500, 50, 50, '#000'), id: 'b', group: 'g1' };
  // Unrotated: [200..300, 200..220], rotated 90deg around center (250, 210) -> AABB is [240..260, 160..260]
  const rot = { ...item('shape', 200, 200, 100, 20, '#000'), id: 'rot', rotation: 90 };
  const outside = { ...item('text', 700, 700, 40, 40, '#000'), id: 'out' };

  // Negative width/height rect hitting 'a' should expand group 'g1' to include 'b'
  const sel1 = itemsInRect([a, b, rot, outside], { x: 160, y: 160, w: -40, h: -40 });
  assert.deepEqual([...sel1].sort(), ['a', 'b']);

  // Rect hitting top tip of rotated AABB (y: 160..175, x: 245..255) which is outside unrotated [200..220] y-range
  const sel2 = itemsInRect([a, b, rot, outside], { x: 245, y: 160, w: 10, h: 15 });
  assert.deepEqual([...sel2], ['rot']);
}

// =========================================================================
// A3: Smart Guides + Grid Snap (computeMoveSnap)
// =========================================================================
{
  const moving = [{ ...item('shape', 100, 100, 40, 40, '#000'), id: 'm1' }];
  const other = { ...item('shape', 200, 150, 60, 80, '#000'), id: 'o1' };

  // Moving m1 by dx=97 -> curX = 197, within 6/1 = 6px of o1.x = 200 -> snaps to dx=100
  // Moving m1 by dy=48 -> curY = 148, within 6px of o1.y = 150 -> snaps to dy=50
  const snap1 = computeMoveSnap(moving, [other], 97, 48, { zoom: 1, smartGuides: true });
  approx(snap1.dx, 100);
  approx(snap1.dy, 50);
  assert.equal(snap1.guides.length, 2);
  const vGuide = snap1.guides.find(g => g.orientation === 'vertical');
  const hGuide = snap1.guides.find(g => g.orientation === 'horizontal');
  assert.ok(vGuide && hGuide);
  approx(vGuide.pos, 200);
  approx(vGuide.start, 150);
  approx(vGuide.end, 230);
  approx(hGuide.pos, 150);
  approx(hGuide.start, 200);
  approx(hGuide.end, 260);

  // Center alignment: other center is (230, 190). m1 center at raw is (120, 120).
  // dx = 113 -> curCenterX = 233 (3px from 230), dy = 74 -> curCenterY = 194 (4px from 190)
  const snapCenter = computeMoveSnap(moving, [other], 113, 74, { zoom: 1, smartGuides: true });
  approx(snapCenter.dx, 110);
  approx(snapCenter.dy, 70);

  // At zoom=2, threshold is 6/2 = 3px, so 4px diff should NOT snap
  const snapZoom = computeMoveSnap(moving, [other], 114, 74, { zoom: 2, smartGuides: true });
  approx(snapZoom.dx, 114);
  approx(snapZoom.dy, 74);
  assert.equal(snapZoom.guides.length, 0);

  // Grid snap when smart guides don't trigger (or disabled)
  const snapGrid = computeMoveSnap(moving, [other], 13, 27, { zoom: 1, gridSnap: true, spacing: 20, smartGuides: false });
  // raw x=100 + 13 = 113 -> rounds to 120 => dx=20; raw y=100 + 27 = 127 -> rounds to 120 => dy=20
  approx(snapGrid.dx, 20);
  approx(snapGrid.dy, 20);
  assert.equal(snapGrid.guides.length, 0);
}

// =========================================================================
// A3: alignItems (all 8 modes + locked item preservation)
// =========================================================================
{
  const makeSet = () => [
    { ...item('shape', 10, 20, 40, 20, '#000'), id: '1' },
    { ...item('shape', 80, 50, 60, 40, '#000'), id: '2' },
    { ...item('shape', 200, 100, 50, 30, '#000'), id: '3' },
  ];

  const lefts = makeSet();
  alignItems(lefts, 'left');
  assert.deepEqual(lefts.map(o => o.x), [10, 10, 10]);

  const centersH = makeSet();
  // minLeft=10, maxRight=250 -> cx=130
  alignItems(centersH, 'center-h');
  assert.deepEqual(centersH.map(o => o.x + o.w / 2), [130, 130, 130]);

  const rights = makeSet();
  alignItems(rights, 'right');
  assert.deepEqual(rights.map(o => o.x + o.w), [250, 250, 250]);

  const tops = makeSet();
  alignItems(tops, 'top');
  assert.deepEqual(tops.map(o => o.y), [20, 20, 20]);

  const centersV = makeSet();
  // minTop=20, maxBottom=130 -> cy=75
  alignItems(centersV, 'center-v');
  assert.deepEqual(centersV.map(o => o.y + o.h / 2), [75, 75, 75]);

  const bottoms = makeSet();
  alignItems(bottoms, 'bottom');
  assert.deepEqual(bottoms.map(o => o.y + o.h), [130, 130, 130]);

  // distribute-h preserves outer endpoints (10 and 200+50=250)
  // totalSpan = 240, sumWidths = 40+60+50 = 150, gap = 90/2 = 45
  // item1 x=10 (right=50), item2 x=95 (right=155), item3 x=200 (right=250)
  const distH = makeSet();
  alignItems(distH, 'distribute-h');
  approx(distH[0].x, 10);
  approx(distH[1].x, 95);
  approx(distH[2].x, 200);

  // distribute-v preserves outer endpoints (20 and 100+30=130)
  // totalSpan = 110, sumHeights = 20+40+30 = 90, gap = 20/2 = 10
  // item1 y=20 (bottom=40), item2 y=50 (bottom=90), item3 y=100 (bottom=130)
  const distV = [
    { ...item('shape', 10, 20, 40, 20, '#000'), id: '1' },
    { ...item('shape', 80, 62, 60, 40, '#000'), id: '2' },
    { ...item('shape', 200, 100, 50, 30, '#000'), id: '3' },
  ];
  alignItems(distV, 'distribute-v');
  approx(distV[0].y, 20);
  approx(distV[1].y, 50);
  approx(distV[2].y, 100);

  // < 3 items for distribute is a no-op
  const two = makeSet().slice(0, 2);
  alignItems(two, 'distribute-h');
  assert.deepEqual(two.map(o => o.x), [10, 80]);

  // Locked items are not mutated
  const withLocked = makeSet();
  withLocked[1].locked = true;
  alignItems(withLocked, 'left');
  assert.equal(withLocked[1].x, 80);
  assert.equal(withLocked[2].x, 10);
}

// =========================================================================
// A3: flipItems (H & V including points, rotation, frozenInk, eraseMasks, locked)
// =========================================================================
{
  const s = {
    ...stroke([[10, 10, 0.5], [30, 10, 0.5], [30, 50, 0.5]], '#000000', 2, 'fountain'),
    id: 's1',
    rotation: 30,
    frozenInk: [[[0, 0], [10, 0], [10, 20], [0, 20]]],
    eraseMasks: [[[[1, 1], [4, 1], [4, 4], [1, 4]]]],
  };
  const origPoints = s.points.map(p => [...p]);
  const box = { ...item('shape', 100, 100, 40, 20, '#000'), id: 'b1', rotation: -15 };
  const locked = { ...item('shape', 200, 200, 20, 20, '#000'), id: 'lk', locked: true, rotation: 45 };

  // Compute expected horizontal center of unlocked [s, box]
  flipItems([s, box, locked], 'horizontal');
  assert.equal(s.rotation, -30);
  assert.equal(box.rotation, 15);
  assert.equal(locked.x, 200);
  assert.equal(locked.rotation, 45);
  // Each point x flipped to bw - px, y unchanged
  for (let i = 0; i < s.points.length; i++) {
    approx(s.points[i][0], s.bw - origPoints[i][0]);
    approx(s.points[i][1], origPoints[i][1]);
  }
  // frozenInk & eraseMasks flipped horizontally
  assert.deepEqual(s.frozenInk[0].map(([x]) => Math.round((s.bw - x) * 1e6) / 1e6).sort((a, b) => a - b), [0, 0, 10, 10]);
  assert.deepEqual(s.eraseMasks[0][0].map(([x]) => Math.round((s.bw - x) * 1e6) / 1e6).sort((a, b) => a - b), [1, 1, 4, 4]);

  // Vertical flip reverses back vertically
  flipItems([s, box], 'vertical');
  assert.equal(s.rotation, 30);
  assert.equal(box.rotation, -15);
  for (let i = 0; i < s.points.length; i++) {
    approx(s.points[i][0], s.bw - origPoints[i][0]);
    approx(s.points[i][1], s.bh - origPoints[i][1]);
  }
}

// =========================================================================
// A3: filterSelectionByKind
// =========================================================================
{
  const items = [
    { ...stroke([[0, 0, 0.5], [10, 10, 0.5]], '#000', 2, 'fountain'), id: 'pen1' },
    { ...stroke([[0, 0, 0.5], [10, 10, 0.5]], '#ff0', 14, 'highlighter'), id: 'hl1' },
    { ...item('shape', 0, 0, 10, 10, '#000'), id: 'sh1' },
    { ...item('text', 0, 0, 10, 10, '#000'), id: 'tx1' },
    { ...item('sticky', 0, 0, 10, 10, '#000'), id: 'st1' },
    { ...item('image', 0, 0, 10, 10, '#000'), id: 'im1' },
    { ...item('table', 0, 0, 10, 10, '#000'), id: 'tb1' },
    { ...item('tape', 0, 0, 10, 10, '#000'), id: 'tp1' },
    { ...item('link', 0, 0, 10, 10, '#000'), id: 'lk1' },
  ];
  const sel = new Set(items.map(o => o.id));
  assert.equal(filterSelectionByKind(items, sel, 'all').size, 9);
  assert.deepEqual([...filterSelectionByKind(items, sel, 'stroke')], ['pen1']);
  assert.deepEqual([...filterSelectionByKind(items, sel, 'highlighter')], ['hl1']);
  assert.deepEqual([...filterSelectionByKind(items, sel, 'shape')], ['sh1']);
  assert.deepEqual([...filterSelectionByKind(items, sel, 'text')], ['tx1']);
  assert.deepEqual([...filterSelectionByKind(items, sel, 'sticky')], ['st1']);
  assert.deepEqual([...filterSelectionByKind(items, sel, 'image')], ['im1']);
  assert.deepEqual([...filterSelectionByKind(items, sel, 'table')], ['tb1']);
  assert.deepEqual([...filterSelectionByKind(items, sel, 'tape')], ['tp1']);
  assert.deepEqual([...filterSelectionByKind(items, sel, 'link')], ['lk1']);
}

console.log('ALL A1 & A3 CHECKS PASSED');
