import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const viewSource = (await readFile('src/view.ts', 'utf8')).replace(/^import .*;\r?\n/gm, '');
const bundle = await build({
  stdin: {
    contents: `
      import { SHORTCUTS, EDIT_ACTIONS, SELECTION_ACTIONS, shortcutAction, shortcutHint } from './src/shortcuts';
      import { pageAtOffset } from './src/page-navigation';
      import { newBook, newPage, parseBook, item, stroke, contains, localPoint, inPolygon, encode, decode, resourceUrl, clone, uid, isInfiniteBook, normalizeInfinitePaper, DEFAULT_INK } from './src/model';
      import { selectionClipboard, pasteItems } from './src/selection-clipboard';
      import { historyWeight, SnapshotStore } from './src/history';
      import { extendLaserTrail } from './src/laser';
      import { A4_HEIGHT, A4_WIDTH, INFINITE_MAX_ZOOM, INFINITE_MIN_ZOOM, adaptiveGridStep, buildVirtualExportPage, clampInfiniteZoom, computeA4Tiles, contentBounds, drawInfiniteBackground, filterVisibleItems, fitCameraToBounds, itemAABB, pinchTransform, rectsIntersect, renderInfiniteExportCanvas, screenToWorld, visibleWorldRect, worldToScreen, zoomAtScreenPoint } from './src/infinite';
      import { alignItems, computeMoveSnap, filterSelectionByKind, flipItems, itemsInRect } from './src/selection-tools';
      import { CONNECTABLE_SHAPES, adjustSnappedShape, clearDanglingBindings, computeConnectorPoints, findNearestAnchor, findScribbleTargets, getShapeAnchors, isScribbleGesture, updateBoundConnectors } from './src/shape-connectors';
      import { PdfSearchController, drawSearchHighlights } from './src/pdf-search';
      const DEFAULT_PEN_FAVORITES = [], MAX_PEN_FAVORITES = 6;
      const normalizePenFavorites = x => x ?? [], renderPenFavoritesDock = () => {}, upsertPenFavorite = (a, b) => [...(a ?? []), b];
      const formatEmbedLink = (p, id) => '![[' + p + (id ? '#' + id : '') + ']]';
      const PEN_ICONS = { fountain: '', ballpoint: '', brush: '', pencil: '', highlighter: '' };
      const SHAPE_ICONS = { auto: '', rectangle: '', ellipse: '', triangle: '', line: '', arrow: '', diamond: '', rounded: '' };
      const ERASER_ICONS = { stroke: '', pixel: '' };
      const SELECT_ALL_ICON = '', LASER_ICON = '';
      const UI_ICONS = { check: '', close: '', tune: '', eyedropper: '', bold: '', italic: '', alignLeft: '', alignCenter: '', alignRight: '', lineHeight: '', pin: '', tape: '', dot: '', marquee: '' };
      const ICONS = { rotate: '', lasso: '', guides: '', align: '', flip: '', filter: '', marquee: '' };
      const actionIcon = () => 'settings';
      const TextFileView = class {};
      const notices = [];
      const Notice = class { constructor(public message = '') { notices.push(message); } };
      const icon = () => {}, pathIcon = () => {}, dropdownIcon = () => {};
      const rememberAnchor = () => {}, dismissPopoverFor = () => false, toolAnchor = () => null, sizeControl = () => {};
      const form = async () => null;
      const normalizePath = p => p.replace(/^\\/+/, '').replace(/\\/+/g, '/');
      ${viewSource}
      export { newBook, newPage, parseBook, item, clone, uid, notices };
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
  PenbookView, VIEW_TYPE, mapPointerPressure, infiniteEraserClipRegion, isIncipientTouchGesture,
  newBook, item, clone, notices,
} = mod;

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

const makeEl = () => ({
  children: [],
  style: {},
  classList: new Set(),
  isConnected: true,
  clientWidth: 1000,
  clientHeight: 700,
  scrollLeft: 0,
  scrollTop: 0,
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

function createMockView(opts = {}) {
  const book = opts.book ?? newBook('Test', 'grid', opts.infinite ? 'infinite' : 'paged');
  const v = Object.create(PenbookView.prototype);
  const surface = {
    page: book.pages[0],
    sheet: makeEl(),
    bg: { width: 1000, height: 700, getContext: () => makeEl().getContext() },
    ink: { width: 1000, height: 700, getContext: () => makeEl().getContext() },
    ui: { ...makeEl(), width: 1000, height: 700, setPointerCapture() {} },
    text: makeEl(),
    epoch: 1,
    visible: true,
    backgroundReady: true,
  };
  Object.assign(v, {
    book,
    index: 0,
    valid: true,
    closed: false,
    raw: JSON.stringify(book),
    dirty: false,
    dirtyVersion: 0,
    saving: Promise.resolve(),
    camera: { x: 0, y: 0, zoom: 1 },
    zoom: 1,
    showGuides: false,
    minimapVisible: false,
    tool: opts.tool ?? 'pen',
    pen: 'fountain',
    shape: 'rectangle',
    color: '#000000',
    width: 3,
    eraserSize: 22,
    reading: false,
    fingerInk: Boolean(opts.fingerInk),
    layout: 'continuous',
    automaticShape: true,
    laserMode: 'line',
    tapeStraight: true,
    tapeColor: '#e79757',
    stickyColor: '#fff2a8',
    sampleColor: false,
    previousTool: 'pen',
    textStyle: { fontSize: 22, font: 'sans-serif', bold: false, italic: false, align: 'left', lineHeight: 1.4, pinned: false },
    renderEpoch: 1,
    thumbEpoch: 1,
    lastPen: 0,
    touchPinching: false,
    touches: new Map(),
    surfaces: [surface],
    penButtons: new Map([['pen', makeEl()], ['eraser', makeEl()], ['shape', makeEl()], ['lasso', makeEl()]]),
    selection: new Set(),
    undoStack: [],
    redoStack: [],
    snapshots: { capture: b => clone(b), clear() {} },
    eraserCursorRects: new WeakMap(),
    pageObservers: [],
    thumbObservers: [],
    thumbPainters: new Map(),
    pageCards: new Map(),
    sidebarItems: new Map(),
    pendingThumbs: new Set(),
    backgroundEraser: { stop() {}, execute: async () => ({ changes: [] }) },
    renderer: { clear() {}, draw() {}, cachedImage: () => undefined, strokeOutline: () => [] },
    pdfs: { clear: async () => {} },
    root: makeEl(),
    stage: makeEl(),
    contentEl: makeEl(),
    plugin: {
      settings: {
        penColor: '#000000', penWidth: 3, fingerInk: Boolean(opts.fingerInk),
        penEnabled: true, pressure: 0.7, eraser: 'stroke', eraserAutoPrevious: false,
        eraserOnly: 'all', eraserPrecision: 'standard', gridSnap: false, showResolved: false,
        presetColors: ['#000000'], colorHistory: [], inkProfiles: {},
      },
      selectionClipboard: null,
      saveSettings: async () => {},
      unique: async p => p,
    },
    repaint() {},
    paintUI() {},
    drawContext() {},
    drawFooter() {},
    drawSidebar() {},
    drawPages() {},
    updateSelectionBar() {},
    updateHistory() {},
    render() {},
    scheduleInfiniteRender() {},
    paintMinimap() {},
  });
  return { v, surface };
}

function setupTimerMocks() {
  const timeouts = new Map();
  let nextId = 1;
  globalThis.window = {
    setTimeout(fn, ms) { const id = nextId++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
  };
  globalThis.requestAnimationFrame = fn => { const id = nextId++; timeouts.set(id, { fn: () => fn(performance.now()), ms: 16 }); setImmediate(() => { if (timeouts.has(id)) { timeouts.delete(id); fn(performance.now()); } }); return id; };
  globalThis.cancelAnimationFrame = id => { timeouts.delete(id); };
  return {
    timeouts,
    fire(id) {
      const entry = timeouts.get(id);
      if (!entry) return false;
      timeouts.delete(id);
      entry.fn();
      return true;
    },
    fireByMs(ms) {
      for (const [id, entry] of timeouts) {
        if (entry.ms === ms) {
          timeouts.delete(id);
          entry.fn();
          return true;
        }
      }
      return false;
    },
  };
}

// 1. Pressure mapping (Android zero-pressure end-blob fix)
{
  const gamma = 0.7;
  approx(mapPointerPressure(0, 'pen', gamma), Math.pow(0.05, gamma));
  approx(mapPointerPressure(0, 'touch', gamma), Math.pow(0.05, gamma));
  approx(mapPointerPressure(0, 'mouse', gamma), Math.pow(0.5, gamma));
  approx(mapPointerPressure(undefined, 'mouse', gamma), Math.pow(0.5, gamma));
  approx(mapPointerPressure(Number.NaN, 'pen', gamma), Math.pow(0.5, gamma));
  approx(mapPointerPressure(0.64, 'pen', gamma), Math.pow(0.64, gamma));

  const { v, surface } = createMockView();
  const penZero = v.point({ clientX: 100, clientY: 120, pressure: 0, pointerType: 'pen' }, surface);
  const mouseZero = v.point({ clientX: 100, clientY: 120, pressure: 0, pointerType: 'mouse' }, surface);
  approx(penZero[2], Math.pow(0.05, 0.7));
  approx(mouseZero[2], Math.pow(0.5, 0.7));
}

// 2. Infinite eraser 2px clip gap & table/link resize bw/bh
{
  const region = infiniteEraserClipRegion(100, 200, 40, 50, 2, 2);
  approx(region.x, 100 - 0.5);
  approx(region.y, 200 - 0.5);
  approx(region.w, 40 + 1);
  approx(region.h, 50 + 1);

  const clampedRegion = infiniteEraserClipRegion(0, 0, 10, 10, 0.01, 1);
  approx(clampedRegion.x, -40);
  approx(clampedRegion.w, 90);

  // Verify repaintEraserRegion clears and clips matching padded region
  const { v, surface } = createMockView({ infinite: true });
  v.camera = { x: 0, y: 0, zoom: 2 };
  surface.ink.width = 2000;
  surface.ink.height = 1400;
  const cleared = [], clipped = [];
  surface.ink.getContext = () => ({
    setTransform() {},
    clearRect(x, y, w, h) { cleared.push({ x, y, w, h }); },
    save() {}, restore() {}, translate() {}, scale() {},
    beginPath() {},
    rect(x, y, w, h) { clipped.push({ x, y, w, h }); },
    clip() {},
  });
  v.repaintEraserRegion(surface, 10, 20, 30, 40);
  assert.equal(cleared.length, 1);
  assert.equal(clipped.length, 1);
  approx(clipped[0].x, 10 - 0.5);
  approx(clipped[0].y, 20 - 0.5);
  approx(clipped[0].w, 30 + 1);
  approx(clipped[0].h, 40 + 1);

  // Table and link resize updates bw/bh on g.surface.page.items
  const tbl = { ...item('table', 10, 10, 100, 80, '#000'), bw: 100, bh: 80 };
  const lnk = { ...item('link', 10, 110, 120, 40, '#000'), bw: 120, bh: 40 };
  const { v: rv, surface: rsurf } = createMockView({ tool: 'lasso' });
  rsurf.page.items.push(tbl, lnk);
  rv.selection = new Set([tbl.id, lnk.id]);
  rv.gesture = {
    pointer: 1,
    pointerType: 'mouse',
    surface: rsurf,
    tool: 'lasso',
    points: [[130, 150, 0.5]],
    start: [130, 150, 0.5],
    last: [130, 150, 0.5],
    mode: 'resize',
    frame: { cx: 70, cy: 80, w: 120, h: 140, angle: 0 },
    original: clone([tbl, lnk]),
  };
  rv.pointerMove({ pointerId: 1, pointerType: 'mouse', clientX: 190, clientY: 220, preventDefault() {} }, rsurf);
  approx(tbl.bw, tbl.w);
  approx(tbl.bh, tbl.h);
  approx(lnk.bw, lnk.w);
  approx(lnk.bh, lnk.h);
  assert.ok(tbl.w > 100 && lnk.h > 40);
}

// 3. Sync conflict guard (setViewData, flush dirtyVersion, transferPage)
{
  const timers = setupTimerMocks();
  notices.length = 0;
  const { v } = createMockView();
  const created = [];
  const modified = [];
  let resolveModify;
  v.file = { path: 'notes/Math.penbook', basename: 'Math', parent: { path: 'notes' } };
  v.app = {
    vault: {
      create: async (p, data) => { created.push({ path: p, data }); },
      modify: async (file, data) => { modified.push({ file, data }); await new Promise(r => { resolveModify = r; }); },
    },
    workspace: { getLeavesOfType: () => [] },
  };
  v.run = fn => Promise.resolve(fn());

  // Local unsaved edit
  v.page.items.push(item('sticky', 20, 30, 100, 80, '#000'));
  v.changed(clone(v.book));
  assert.equal(v.dirty, true);
  assert.equal(v.dirtyVersion, 1);

  // Incoming remote sync while dirty: preserve local book, create conflict backup
  const remoteBook = newBook('Remote', 'blank');
  remoteBook.pages[0].items.push(item('text', 5, 5, 50, 50, '#111'));
  const remoteRaw = JSON.stringify(remoteBook);
  v.setViewData(remoteRaw, false);
  await new Promise(setImmediate);

  assert.equal(v.book.pages[0].items.length, 1);
  assert.equal(v.book.pages[0].items[0].kind, 'sticky');
  assert.equal(v.raw, remoteRaw);
  assert.equal(v.dirty, true);
  assert.equal(created.length, 1);
  assert.match(created[0].path, /^notes\/Math\.sync-conflict-.*\.penbook$/);
  assert.equal(created[0].data, remoteRaw);
  assert.ok(notices.some(m => m.includes('冲突备份')));

  // Flush dirtyVersion race: concurrent edit during in-flight modify keeps dirty = true
  const flushPromise = v.flush();
  await new Promise(setImmediate);
  assert.equal(modified.length, 1);
  const firstWrite = modified[0].data;
  assert.equal(v.dirty, true); // Not cleared prematurely!

  // Echo of inFlightWrite is ignored
  const beforeEchoBook = v.book;
  v.setViewData(firstWrite, false);
  assert.equal(v.book, beforeEchoBook);

  // Concurrent edit while modify is still in flight
  v.page.items.push(item('sticky', 50, 50, 100, 80, '#000'));
  v.changed(clone(v.book));
  assert.equal(v.dirtyVersion, 2);

  resolveModify();
  await flushPromise;
  assert.equal(v.lastWritten, firstWrite);
  assert.equal(v.dirty, true); // Must stay dirty because dirtyVersion bumped!
  assert.equal(v.inFlightWrite, undefined);

  // Clean flush clears dirty when no concurrent edit occurred
  let resolveSecond;
  v.app.vault.modify = async (file, data) => { modified.push({ file, data }); await new Promise(r => { resolveSecond = r; }); };
  const secondFlush = v.flush();
  await new Promise(setImmediate);
  resolveSecond();
  await secondFlush;
  assert.equal(v.dirty, false);

  // Failed modify keeps dirty = true and preserves previous lastWritten
  v.page.items.push(item('sticky', 80, 80, 100, 80, '#000'));
  v.changed(clone(v.book));
  v.app.vault.modify = async () => { throw new Error('disk full'); };
  const origConsoleError = console.error;
  console.error = () => {};
  try { await v.flush(); } finally { console.error = origConsoleError; }
  assert.equal(v.dirty, true);
  assert.equal(v.inFlightWrite, undefined);
  assert.notEqual(v.lastWritten, JSON.stringify(v.book));
  timers.timeouts.clear();
}

// 4. transferPage flushes destination open PenbookView leaf first
{
  const timers = setupTimerMocks();
  const { v: src } = createMockView();
  const { v: dst } = createMockView();
  src.file = { path: 'src.penbook', basename: 'src', parent: { path: '' } };
  dst.file = { path: 'dst.penbook', basename: 'dst', parent: { path: '' } };
  dst.page.items.push(item('text', 12, 14, 90, 40, '#000'));
  dst.dirty = true;
  dst.dirtyVersion = 1;

  const events = [];
  let dstDisk = JSON.stringify(newBook('OldDst', 'blank'));
  dst.app = {
    vault: {
      modify: async (_file, data) => { events.push('flush-dst'); dstDisk = data; },
    },
  };
  const destFile = { path: 'dst.penbook', extension: 'penbook' };
  src.app = {
    vault: {
      getName: () => 'Vault',
      process: async (_file, fn) => {
        events.push('process-dst');
        dstDisk = fn(dstDisk);
      },
    },
    workspace: {
      getLeavesOfType: type => type === VIEW_TYPE ? [{ view: dst }] : [],
    },
  };
  // Bypass pickFile modal by testing the leaf flush + vault.process flow via stubbed pickFile?
  // Note: pickFile is imported from dialogs; verify flushPending works and transferPage invokes it.
  await dst.flushPending();
  assert.deepEqual(events, ['flush-dst']);
  assert.equal(JSON.parse(dstDisk).pages[0].items.length, 1);
  assert.equal(dst.dirty, false);
  // Check transferPage source references flushPending and VIEW_TYPE before vault.process
  const transferMatch = viewSource.match(/private async transferPage\([\s\S]*?vault\.process\(/);
  assert.ok(transferMatch && transferMatch[0].includes('getLeavesOfType(VIEW_TYPE)') && transferMatch[0].includes('flushPending()'));
  timers.timeouts.clear();
}

// 5. 0.7s hold-to-eraser races & interrupt recovery
{
  const timers = setupTimerMocks();
  const { v, surface } = createMockView({ tool: 'pen' });
  const setTools = [];
  const origSetTool = PenbookView.prototype.setTool;
  v.setTool = function (t) { setTools.push(t); return origSetTool.call(this, t); };

  // Start pen stroke and schedule shape timer
  v.pointerDown({ pointerId: 10, pointerType: 'pen', button: 0, buttons: 1, clientX: 100, clientY: 100, pressure: 0.5, preventDefault() {} }, surface);
  assert.ok(v.gesture);
  v.shapeTimer = 9999;
  v.gesture.snapped = item('shape', 10, 10, 50, 50, '#000');
  v.gesture.snappedBase = clone(v.gesture.snapped);
  v.gesture.holdPoint = [100, 100, 0.5];

  // Unrelated pointerUp must NOT cancel pen hold timer
  v.pointerUp({ pointerId: 99, pointerType: 'touch', clientX: 200, clientY: 200 });
  assert.ok(timers.fireByMs(700), '700ms pen hold timer should still be active');

  assert.equal(v.tool, 'eraser');
  assert.equal(v.gesture.tool, 'eraser');
  assert.equal(v.gesture.penHoldBefore, 'pen');
  assert.equal(v.shapeTimer, undefined);
  assert.equal(v.gesture.snapped, undefined);
  assert.equal(v.gesture.snappedBase, undefined);
  assert.equal(v.gesture.holdPoint, undefined);

  // Release pen -> finishEraser runs asynchronously, tool stays eraser until finishEraser resolves
  let resolveErase;
  v.backgroundEraser.execute = async () => new Promise(r => { resolveErase = () => r({ changes: [] }); });
  v.gesture.erasedStrokes.add('s1');
  v.page.items.push({ ...item('stroke', 90, 90, 20, 20, '#000'), id: 's1', points: [[0, 0, 0.5], [10, 10, 0.5]] });

  v.pointerUp({ pointerId: 10, pointerType: 'pen', clientX: 102, clientY: 102, pressure: 0 });
  // Even after a macrotask, no racy setTimeout(..., 0) restored tool prematurely
  assert.equal(setTools.length, 0);
  assert.equal(v.tool, 'eraser');

  await new Promise(setImmediate);
  resolveErase?.();
  await v.gesture?.ending;
  assert.equal(v.tool, 'pen');
  assert.deepEqual(setTools, ['pen']);

  // Interrupt recovery via pointerCancel / lostpointercapture when hold fired
  v.pointerDown({ pointerId: 11, pointerType: 'pen', button: 0, buttons: 1, clientX: 150, clientY: 150, pressure: 0.5, preventDefault() {} }, surface);
  assert.ok(timers.fireByMs(700));
  assert.equal(v.tool, 'eraser');
  v.pointerCancel({ pointerId: 11, pointerType: 'pen' });
  assert.equal(v.tool, 'pen');
  assert.equal(v.gesture, undefined);
  timers.timeouts.clear();
}

// 6. fingerInk 2-finger pinch & mobile gesture invariants
{
  const timers = setupTimerMocks();
  const { v, surface } = createMockView({ fingerInk: true, tool: 'pen', infinite: true });
  let drawPagesCalls = 0, persistCalls = 0;
  v.drawPages = () => { drawPagesCalls++; };
  v.persistViewport = () => { persistCalls++; };

  // 6a. Single-finger ink stroke draws and commits without triggering persistViewport/drawPages
  v.pointerDown({ pointerId: 1, pointerType: 'touch', button: 0, buttons: 1, clientX: 50, clientY: 50, pressure: 0.5, preventDefault() {} }, surface);
  assert.equal(v.touches.size, 1);
  assert.equal(v.gesture?.pointerType, 'touch');
  v.pointerMove({ pointerId: 1, pointerType: 'touch', clientX: 120, clientY: 50, pressure: 0.5, preventDefault() {} }, surface);
  v.pointerUp({ pointerId: 1, pointerType: 'touch', clientX: 120, clientY: 50, pressure: 0 });
  assert.equal(v.touches.size, 0);
  assert.equal(v.page.items.length, 1);
  assert.equal(persistCalls, 0);
  assert.equal(drawPagesCalls, 0);

  // 6b. Incipient 1st finger + 2nd finger lands -> cancels 1st finger stroke & starts pinch without tearing down DOM
  let renderCalls = 0;
  v.render = () => { renderCalls++; surface.page = v.book.pages[0]; };
  v.pointerDown({ pointerId: 2, pointerType: 'touch', button: 0, buttons: 1, clientX: 200, clientY: 200, pressure: 0.5, preventDefault() {} }, surface);
  v.pointerMove({ pointerId: 2, pointerType: 'touch', clientX: 204, clientY: 203, pressure: 0.5, preventDefault() {} }, surface);
  assert.equal(isIncipientTouchGesture(v.gesture, v.zoom), true);

  v.pointerDown({ pointerId: 3, pointerType: 'touch', button: 0, buttons: 1, clientX: 300, clientY: 200, pressure: 0.5, preventDefault() {} }, surface);
  assert.equal(v.gesture, undefined);
  assert.equal(renderCalls, 0);
  assert.equal(v.touches.size, 2);
  assert.ok(v.infinitePinch);
  assert.equal(v.page.items.length, 1); // No extra stroke committed!

  v.pointerMove({ pointerId: 3, pointerType: 'touch', clientX: 400, clientY: 200, preventDefault() {} }, surface);
  assert.ok(v.camera.zoom > 1);
  v.pointerUp({ pointerId: 2, pointerType: 'touch', clientX: 204, clientY: 203 });
  assert.equal(v.touches.size, 1);
  v.pointerUp({ pointerId: 3, pointerType: 'touch', clientX: 400, clientY: 200 });
  assert.equal(v.touches.size, 0);
  assert.ok(persistCalls > 0);

  // 6c. Real 1st-finger stroke (>= 28/zoom) rejects 2nd finger instead of aborting stroke
  v.camera = { x: 0, y: 0, zoom: 1 };
  v.zoom = 1;
  v.pointerDown({ pointerId: 4, pointerType: 'touch', button: 0, buttons: 1, clientX: 100, clientY: 100, pressure: 0.5, preventDefault() {} }, surface);
  v.pointerMove({ pointerId: 4, pointerType: 'touch', clientX: 160, clientY: 100, pressure: 0.5, preventDefault() {} }, surface);
  assert.equal(isIncipientTouchGesture(v.gesture, v.zoom), false);
  v.pointerDown({ pointerId: 5, pointerType: 'touch', button: 0, buttons: 1, clientX: 300, clientY: 300, pressure: 0.5, preventDefault() {} }, surface);
  assert.ok(v.gesture && v.gesture.pointer === 4);
  assert.equal(v.touches.size, 1);
  v.pointerUp({ pointerId: 4, pointerType: 'touch', clientX: 160, clientY: 100, pressure: 0 });
  assert.equal(v.page.items.length, 2);

  // 6d. Invariant: different pointerType (pen) takes over existing touch gesture
  v.pointerDown({ pointerId: 6, pointerType: 'touch', button: 0, buttons: 1, clientX: 10, clientY: 10, pressure: 0.5, preventDefault() {} }, surface);
  v.pointerMove({ pointerId: 6, pointerType: 'touch', clientX: 60, clientY: 10, pressure: 0.5, preventDefault() {} }, surface);
  v.pointerDown({ pointerId: 7, pointerType: 'pen', button: 0, buttons: 1, clientX: 300, clientY: 300, pressure: 0.5, preventDefault() {} }, surface);
  assert.equal(v.page.items.length, 3);
  assert.equal(v.gesture?.pointerType, 'pen');
  assert.equal(v.touches.size, 0);
  v.pointerUp({ pointerId: 7, pointerType: 'pen', clientX: 330, clientY: 300, pressure: 0 });
  assert.equal(v.page.items.length, 4);
  timers.timeouts.clear();
}

console.log(JSON.stringify({ viewStabilityPassed: true }));
