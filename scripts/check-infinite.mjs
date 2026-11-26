import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const viewSource = (await readFile('src/view.ts', 'utf8')).replace(/^import .*;\r?\n/gm, '');
const bundle = await build({
  stdin: {
    contents: `
      import { SHORTCUTS, EDIT_ACTIONS, SELECTION_ACTIONS, shortcutAction, shortcutHint } from './src/shortcuts';
      import { pageAtOffset } from './src/page-navigation';
      import { newBook, newPage, parseBook, item, clone, uid, isInfiniteBook, normalizeInfinitePaper } from './src/model';
      import { selectionClipboard, pasteItems } from './src/selection-clipboard';
      import { historyWeight } from './src/history';
      import { A4_HEIGHT, A4_WIDTH, INFINITE_MAX_ZOOM, INFINITE_MIN_ZOOM, adaptiveGridStep, buildVirtualExportPage, clampInfiniteZoom, computeA4Tiles, contentBounds, drawInfiniteBackground, filterVisibleItems, fitCameraToBounds, itemAABB, pinchTransform, rectsIntersect, renderInfiniteExportCanvas, screenToWorld, visibleWorldRect, worldToScreen, zoomAtScreenPoint } from './src/infinite';
      const PEN_ICONS = { fountain: '', ballpoint: '', brush: '', pencil: '', highlighter: '' };
      const SHAPE_ICONS = { auto: '', rectangle: '', ellipse: '', triangle: '', line: '', arrow: '', diamond: '', rounded: '' };
      const ERASER_ICONS = { stroke: '', pixel: '' };
      const SELECT_ALL_ICON = '', LASER_ICON = '';
      const UI_ICONS = { check: '', close: '', tune: '', eyedropper: '', bold: '', italic: '', alignLeft: '', alignCenter: '', alignRight: '', lineHeight: '', pin: '', tape: '', dot: '' };
      const ICONS = { rotate: '' };
      const actionIcon = () => 'settings';
      const TextFileView = class {};
      const Notice = class { constructor(public message = '') {} };
      const icon = () => {}, pathIcon = () => {}, dropdownIcon = () => {};
      const rememberAnchor = () => {}, dismissPopoverFor = () => false, toolAnchor = () => null, sizeControl = () => {};
      const form = async () => null;
      ${viewSource}
      export {
        newBook, newPage, parseBook, item, clone, uid, isInfiniteBook, normalizeInfinitePaper,
        selectionClipboard, pasteItems,
        A4_HEIGHT, A4_WIDTH, INFINITE_MAX_ZOOM, INFINITE_MIN_ZOOM,
        adaptiveGridStep, buildVirtualExportPage, clampInfiniteZoom, computeA4Tiles,
        contentBounds, drawInfiniteBackground, filterVisibleItems, fitCameraToBounds,
        itemAABB, pinchTransform, rectsIntersect, screenToWorld, visibleWorldRect,
        worldToScreen, zoomAtScreenPoint,
      };
    `,
    loader: 'ts',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});

const mod = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const {
  PenbookView, newBook, parseBook, item, isInfiniteBook, normalizeInfinitePaper,
  selectionClipboard, A4_HEIGHT, A4_WIDTH, INFINITE_MAX_ZOOM, INFINITE_MIN_ZOOM,
  adaptiveGridStep, buildVirtualExportPage, computeA4Tiles, contentBounds,
  drawInfiniteBackground, filterVisibleItems, fitCameraToBounds, itemAABB,
  pinchTransform, screenToWorld, visibleWorldRect, worldToScreen, zoomAtScreenPoint,
} = mod;

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// 1. Model compatibility & validation
{
  const paged = newBook('Paged Book', 'ruled');
  assert.equal(paged.mode, undefined);
  assert.equal(isInfiniteBook(paged), false);
  const parsedPaged = parseBook(JSON.stringify(paged));
  assert.equal(parsedPaged.pages.length, 1);

  assert.equal(normalizeInfinitePaper('cornell'), 'dots');
  assert.equal(normalizeInfinitePaper('grid'), 'grid');

  const inf = newBook('Infinite Book', 'cornell', 'infinite');
  assert.equal(inf.mode, 'infinite');
  assert.equal(isInfiniteBook(inf), true);
  assert.equal(inf.pages.length, 1);
  assert.equal(inf.pages[0].width, 794);
  assert.equal(inf.pages[0].height, 1123);
  assert.equal(inf.pages[0].paper, 'dots');
  assert.deepEqual(inf.viewport, { x: 0, y: 0, zoom: 1, showGuides: false });
  assert.deepEqual(inf.bookmarks, []);

  inf.pages[0].items.push({ ...item('sticky', -1200, -850, 220, 140, '#000000'), text: 'Negative quadrant' });
  inf.viewport = { x: -300, y: 450, zoom: 99, showGuides: true };
  inf.bookmarks.push({ id: 'bm-1', title: 'Intro', x: -1100, y: -780, zoom: 0.01 });

  const parsedInf = parseBook(JSON.stringify(inf));
  assert.equal(parsedInf.mode, 'infinite');
  assert.equal(parsedInf.viewport.zoom, INFINITE_MAX_ZOOM);
  assert.equal(parsedInf.bookmarks[0].zoom, INFINITE_MIN_ZOOM);
  assert.equal(parsedInf.pages[0].items[0].x, -1200);

  assert.throws(() => parseBook(JSON.stringify({ ...inf, mode: 'unknown' })));
  assert.throws(() => parseBook(JSON.stringify({ ...inf, viewport: { x: 0, y: 0, zoom: -1 } })));
  assert.throws(() => parseBook(JSON.stringify({ ...inf, bookmarks: [{ id: '', title: 'bad', x: 0, y: 0, zoom: 1 }] })));
}

// 2. Positive & negative world/screen transforms
{
  const view = { w: 1200, h: 800 };
  for (const cam of [{ x: 0, y: 0, zoom: 1 }, { x: -640, y: 320, zoom: 0.25 }, { x: 420, y: -910, zoom: 2.5 }]) {
    for (const [wx, wy] of [[0, 0], [-1500, -900], [820, -40], [-33.5, 712.25]]) {
      const [sx, sy] = worldToScreen(wx, wy, cam, view);
      const [rx, ry] = screenToWorld(sx, sy, cam, view);
      approx(rx, wx);
      approx(ry, wy);
    }
  }
}

// 3. Focal zoom invariance & clamping
{
  const view = { w: 1000, h: 700 };
  const cam = { x: -240, y: 180, zoom: 1.2 };
  const sx = 730, sy = 210;
  const [wxBefore, wyBefore] = screenToWorld(sx, sy, cam, view);
  const zoomedIn = zoomAtScreenPoint(cam, 2.8, sx, sy, view);
  const [wxAfter, wyAfter] = screenToWorld(sx, sy, zoomedIn, view);
  approx(wxAfter, wxBefore);
  approx(wyAfter, wyBefore);

  assert.equal(zoomAtScreenPoint(cam, 0.01, sx, sy, view).zoom, INFINITE_MIN_ZOOM);
  assert.equal(zoomAtScreenPoint(cam, 20, sx, sy, view).zoom, INFINITE_MAX_ZOOM);
}

// 4. Simultaneous two-finger pinch zoom + pan
{
  const view = { w: 1280, h: 800 };
  const startCam = { x: -100, y: 50, zoom: 1 };
  const startMid = [400, 300];
  const currMid = [520, 360];
  const next = pinchTransform(startCam, startMid, 100, currMid, 200, view);
  approx(next.zoom, 2);
  const [wxStart, wyStart] = screenToWorld(startMid[0], startMid[1], startCam, view);
  const [sxCurr, syCurr] = worldToScreen(wxStart, wyStart, next, view);
  approx(sxCurr, currMid[0]);
  approx(syCurr, currMid[1]);
}

// 5. AABB, culling, contentBounds, fitCameraToBounds
{
  const rotBox = { ...item('shape', 0, 0, 100, 40, '#000000'), rotation: 90 };
  const box = itemAABB(rotBox, 0);
  approx(box.w, 40, 1e-4);
  approx(box.h, 100, 1e-4);

  const items = [
    { ...item('text', -500, -400, 120, 60, '#000000'), text: 'Visible neg' },
    { ...item('text', 5000, 5000, 120, 60, '#000000'), text: 'Far off' },
    { ...item('sticky', -450, -350, 100, 80, '#000000'), resolved: true },
  ];
  const vr = visibleWorldRect({ x: -450, y: -360, zoom: 1 }, { w: 400, h: 300 });
  assert.deepEqual(filterVisibleItems(items, vr, false).map(o => o.text), ['Visible neg']);
  assert.equal(filterVisibleItems(items, vr, true).length, 2);
  assert.equal(filterVisibleItems(items, vr, true, items[0].id).length, 1);

  assert.equal(contentBounds([], 10), null);
  const cb = contentBounds(items.slice(0, 2), 20);
  assert.ok(cb && cb.x < -500 && cb.x + cb.w > 5120);

  assert.deepEqual(fitCameraToBounds(null, { w: 800, h: 600 }), { x: 0, y: 0, zoom: 1 });
  const fitted = fitCameraToBounds({ x: -200, y: -100, w: 1200, h: 800 }, { w: 700, h: 500 }, 50);
  approx(fitted.x, 400);
  approx(fitted.y, 300);
  assert.ok(fitted.zoom >= INFINITE_MIN_ZOOM && fitted.zoom <= 1.5);
}

// 6. Adaptive grid step & drawInfiniteBackground across 4 papers + guides
{
  assert.equal(adaptiveGridStep(28, 1, 14), 28);
  assert.equal(adaptiveGridStep(28, 0.25, 14), 56);
  assert.equal(adaptiveGridStep(28, 0.1, 14), 224);

  for (const paper of ['dots', 'grid', 'ruled', 'blank']) {
    let strokes = 0, fills = 0, texts = 0, dashed = false;
    const ctx = {
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textBaseline: 'top',
      save() {}, restore() {}, setTransform() {}, translate() {}, scale() {},
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {},
      fillRect() { fills++; },
      fill() { fills++; },
      stroke() { strokes++; },
      setLineDash(d) { if (d.length) dashed = true; },
      fillText() { texts++; },
    };
    drawInfiniteBackground(ctx, { paper, color: paper === 'dots' ? '#202020' : '#ffffff', spacing: 28 }, { x: -100, y: 200, zoom: 0.5 }, { w: 800, h: 600 }, true, 1, true);
    assert.ok(fills >= 1, `paper ${paper} filled background`);
    assert.ok(strokes >= 1 && dashed && texts >= 1, `paper ${paper} drew A4 dashed guides`);
  }
}

// 7. A4 tiling (skip empty tiles, row-major sorting) & virtual export page
{
  assert.deepEqual(computeA4Tiles([]), []);
  const items = [
    item('text', -100, -100, 40, 40, '#000'),       // col -1, row -1
    item('text', A4_WIDTH * 2 + 10, 20, 50, 50, '#000'), // col 2, row 0
    item('text', 20, A4_HEIGHT + 20, 50, 50, '#000'),    // col 0, row 1
  ];
  const tiles = computeA4Tiles(items);
  assert.deepEqual(tiles.map(t => [t.col, t.row]), [[-1, -1], [2, 0], [0, 1]]);
  const vp = buildVirtualExportPage({ ...newBook('t', 'dots', 'infinite').pages[0], items }, tiles[0]);
  assert.equal(vp.width, A4_WIDTH);
  assert.equal(vp.height, A4_HEIGHT);
  assert.equal(vp.items.length, 1);
  assert.equal(vp.items[0].x, A4_WIDTH - 100);
  assert.equal(vp.items[0].y, A4_HEIGHT - 100);
}

// 8. PenbookView infinite mode interactions
{
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#7f6df2' });
  globalThis.Path2D = class {};
  globalThis.document = {
    activeElement: null,
    createElementNS: () => makeEl(),
    createElement: () => makeEl(),
  };
  globalThis.Element = class { closest() { return null; } };
  globalThis.window = { clearTimeout() {}, setTimeout: () => 1 };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  const makeEl = () => ({
    children: [],
    style: {},
    classList: new Set(),
    isConnected: true,
    clientWidth: 1000,
    clientHeight: 700,
    empty() { this.children = []; },
    createDiv() { const d = makeEl(); this.children.push(d); return d; },
    createEl() { const d = makeEl(); this.children.push(d); return d; },
    createSpan() { return makeEl(); },
    addClass(c) { this.classList.add(c); },
    removeClass(c) { this.classList.delete(c); },
    toggleClass(c, v) { if (v) this.classList.add(c); else this.classList.delete(c); },
    hasClass(c) { return this.classList.has(c); },
    dataset: {},
    closest() { return null; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    focus() {},
    setCssProps() {},
    setAttribute() {},
    setText() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }),
    getContext: () => ({
      setTransform() {}, clearRect() {}, save() {}, restore() {}, translate() {}, scale() {},
      fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      arc() {}, rect() {}, clip() {}, setLineDash() {}, fillText() {},
    }),
  });

  const v = Object.create(PenbookView.prototype);
  const book = newBook('Test Inf', 'grid', 'infinite');
  book.viewport = { x: -250, y: 120, zoom: 1.5, showGuides: false };
  book.pages[0].items.push({ ...item('text', -800, -600, 200, 80, '#000'), text: 'Remote note' });

  Object.assign(v, {
    plugin: { settings: { penColor: '#000000', penWidth: 3, fingerInk: false, leftHanded: false, toolbarBottom: false, showResolved: false, eraser: 'stroke', presetColors: ['#000000'], colorHistory: [], inkProfiles: {} }, selectionClipboard: null, saveSettings: async () => {} },
    contentEl: makeEl(),
    renderer: { clear() {}, draw() {}, cachedImage: () => undefined },
    pdfs: { clear: async () => {} },
    snapshots: { capture: b => structuredClone(b), clear() {} },
    penButtons: new Map(),
    selection: new Set(),
    undoStack: [],
    redoStack: [],
    touches: new Map(),
    surfaces: [],
    pageObservers: [],
    thumbObservers: [],
    thumbPainters: new Map(),
    pageCards: new Map(),
    sidebarItems: new Map(),
    pendingThumbs: new Set(),
    eraserCursorRects: new WeakMap(),
    camera: { x: 0, y: 0, zoom: 1 },
    showGuides: false,
    minimapVisible: false,
    index: 0,
    zoom: 1,
    tool: 'pen',
    pen: 'fountain',
    shape: 'rectangle',
    color: '#000000',
    width: 3,
    eraserSize: 22,
    textStyle: { fontSize: 22, font: 'sans-serif', bold: false, italic: false, align: 'left', lineHeight: 1.4, pinned: false },
    sidebarQuery: '',
    reading: false,
    fingerInk: false,
    layout: 'continuous',
    automaticShape: true,
    laserMode: 'line',
    tapeStraight: true,
    tapeColor: '#e79757',
    stickyColor: '#fff2a8',
    sampleColor: false,
    previousTool: 'pen',
    renderEpoch: 0,
    thumbEpoch: 0,
    dirty: false,
    saving: Promise.resolve(),
    valid: true,
    closed: false,
  });

  v.setViewData(JSON.stringify(book), true);
  assert.equal(v.infinite, true);
  approx(v.camera.x, -250);
  approx(v.camera.y, 120);
  approx(v.camera.zoom, 1.5);
  assert.equal(v.root.hasClass('pb-sidebar-hidden'), true);
  assert.equal(v.undoStack.length, 0);

  // Disabled page shortcuts in infinite mode
  assert.equal(v.canShortcut('next-page', makeEl()), false);
  assert.equal(v.canShortcut('previous-page', makeEl()), false);
  assert.equal(v.canShortcut('new-page', makeEl()), false);
  assert.equal(v.canShortcut('zoom-in', makeEl()), true);

  // Zoom, origin, fit, guides, bookmark do not pollute undoStack
  v.setZoom(2, [500, 350]);
  assert.equal(v.undoStack.length, 0);
  v.toggleGuides();
  assert.equal(v.showGuides, true);
  assert.equal(v.book.viewport.showGuides, true);
  assert.equal(v.undoStack.length, 0);

  await v.addViewportBookmark('Zone A');
  assert.equal(v.book.bookmarks.length, 1);
  assert.equal(v.undoStack.length, 0);
  const bmId = v.book.bookmarks[0].id;

  v.resetOrigin();
  approx(v.camera.x, 0);
  approx(v.camera.y, 0);
  approx(v.camera.zoom, 1);

  v.goToBookmarkId(bmId);
  approx(v.camera.x, v.book.bookmarks[0].x);
  approx(v.camera.y, v.book.bookmarks[0].y);

  // Off-screen paste recenters to current camera
  v.setInfiniteCamera({ x: 3000, y: -2000, zoom: 1 });
  v.clipboard = selectionClipboard([v.page.items[0]], v.book);
  v.pasteSelection();
  const pasted = v.page.items[1];
  assert.ok(Math.abs((pasted.x + pasted.w / 2) - 3000) < 5);
  assert.ok(Math.abs((pasted.y + pasted.h / 2) - (-2000)) < 5);

  // Plain text paste centers around current camera in infinite mode
  v.clipboard = null;
  await v.pasteEvent({
    target: makeEl(),
    clipboardData: { items: [], getData: t => (t === 'text/plain' ? 'Hello Infinite' : '') },
    preventDefault() {},
  });
  const pastedText = v.page.items[2];
  assert.equal(pastedText.kind, 'text');
  assert.equal(pastedText.text, 'Hello Infinite');
  approx(pastedText.x, 2800);
  approx(pastedText.y, -2120);
}

console.log(JSON.stringify({ infiniteTestsPassed: true }));
