import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/pdf-search.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});

const mod = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const {
  extractPageTextRuns,
  findMatchesInRuns,
  findItemTextMatches,
  drawSearchHighlights,
  PdfSearchController,
} = mod;

const approx = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// 1. extractPageTextRuns: uncropped page
{
  const vp = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
  const page = { width: 600, height: 800 };
  const items = [
    { str: 'Hello', transform: [12, 0, 0, 12, 50, 700], width: 30, height: 12 },
    { str: '', transform: [12, 0, 0, 12, 90, 700], width: 0, height: 12 },
  ];
  const runs = extractPageTextRuns(items, vp, page);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].str, 'Hello');
  approx(runs[0].x, 50);
  approx(runs[0].y, 88);
  approx(runs[0].w, 30);
  approx(runs[0].h, 12);
}

// 2. extractPageTextRuns: cropped page (backgroundCrop)
{
  const vp = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
  const page = {
    width: 600,
    height: 800,
    backgroundCrop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, // viewport [150..450, 200..600] -> [0..600, 0..800]
  };
  const items = [
    // viewport: x=180..240, y=288..300 -> inside crop
    { str: 'Inside', transform: [12, 0, 0, 12, 180, 500], width: 60, height: 12 },
    // viewport: x=20..80, y=88..100 -> outside crop
    { str: 'Outside', transform: [12, 0, 0, 12, 20, 700], width: 60, height: 12 },
  ];
  const runs = extractPageTextRuns(items, vp, page);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].str, 'Inside');
  approx(runs[0].x, (180 - 150) * 2); // 60
  approx(runs[0].y, (288 - 200) * 2); // 176
  approx(runs[0].w, 120);
  approx(runs[0].h, 24);
}

// 3. extractPageTextRuns: rotated 90° viewport transform + rotated text item
{
  // 90° CW viewport for 600x800 PDF: (x_pdf, y_pdf) -> (y_pdf, x_pdf), vp.width=800, vp.height=600
  const vp90 = { width: 800, height: 600, transform: [0, 1, 1, 0, 0, 0] };
  const page90 = { width: 800, height: 600 };
  const runs90 = extractPageTextRuns(
    [{ str: 'RotatedVP', transform: [12, 0, 0, 12, 50, 700], width: 45, height: 12 }],
    vp90,
    page90,
  );
  assert.equal(runs90.length, 1);
  approx(runs90[0].x, 700);
  approx(runs90[0].y, 50);
  approx(runs90[0].w, 12);
  approx(runs90[0].h, 45);

  // Rotated text item (a[0]=0, a[1]=12, a[2]=-12, a[3]=0) on unrotated viewport
  const vp0 = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
  const runsItemRot = extractPageTextRuns(
    [{ str: 'Axis', transform: [0, 12, -12, 0, 100, 500], width: 40, height: 12 }],
    vp0,
    { width: 600, height: 800 },
  );
  assert.equal(runsItemRot.length, 1);
  approx(runsItemRot[0].x, 88);
  approx(runsItemRot[0].y, 260);
  approx(runsItemRot[0].w, 12);
  approx(runsItemRot[0].h, 40);
}

// 4. findMatchesInRuns: single-run, multi-run cross-span, case sensitivity, proportional sub-rects
{
  const runs = [
    { str: 'Hello', x: 10, y: 20, w: 50, h: 12 }, // 10 px per char
    { str: 'World', x: 70, y: 20, w: 50, h: 12 }, // gap=10 -> virtual space inserted
    { str: 'Pen', x: 10, y: 40, w: 30, h: 12 },
    { str: 'book', x: 40, y: 40, w: 40, h: 12 }, // gap=0 -> joined directly as "Penbook"
  ];

  // Single-run substring with proportional sub-rect
  const single = findMatchesInRuns(runs, 'ell', 2, 'p2', false);
  assert.equal(single.length, 1);
  assert.equal(single[0].pageIndex, 2);
  assert.equal(single[0].pageId, 'p2');
  assert.equal(single[0].text, 'ell');
  assert.equal(single[0].rects.length, 1);
  approx(single[0].rects[0].x, 20); // 10 + 50 * (1/5)
  approx(single[0].rects[0].w, 30); // 50 * (3/5)
  assert.ok(single[0].snippet.includes('Hello'));

  // Multi-run cross-span phrase with virtual space ("lo Wo")
  const crossSpace = findMatchesInRuns(runs, 'lo wo', 0, 'p0', false);
  assert.equal(crossSpace.length, 1);
  assert.equal(crossSpace[0].rects.length, 2);
  approx(crossSpace[0].rects[0].x, 40); // "lo" in "Hello" (3/5..5/5)
  approx(crossSpace[0].rects[0].w, 20);
  approx(crossSpace[0].rects[1].x, 70); // "Wo" in "World" (0/5..2/5)
  approx(crossSpace[0].rects[1].w, 20);

  // Multi-run kerned word ("Penbook")
  const crossKerned = findMatchesInRuns(runs, 'Penbook', 0, 'p0', true);
  assert.equal(crossKerned.length, 1);
  assert.equal(crossKerned[0].rects.length, 2);
  approx(crossKerned[0].rects[0].w, 30);
  approx(crossKerned[0].rects[1].w, 40);

  // Case sensitivity
  assert.equal(findMatchesInRuns(runs, 'penbook', 0, 'p0', true).length, 0);
  assert.equal(findMatchesInRuns(runs, 'penbook', 0, 'p0', false).length, 1);
}

// 5. findItemTextMatches across text, sticky, link, shape, and table items
{
  const items = [
    { id: 't1', kind: 'text', x: 10, y: 10, w: 100, h: 40, bw: 100, bh: 40, rotation: 0, color: '#000', opacity: 1, text: 'Alpha note' },
    { id: 's1', kind: 'sticky', x: 20, y: 80, w: 120, h: 120, bw: 120, bh: 120, rotation: 0, color: '#000', opacity: 1, text: 'Remember alpha test' },
    { id: 'l1', kind: 'link', x: 20, y: 220, w: 140, h: 30, bw: 140, bh: 30, rotation: 0, color: '#00f', opacity: 1, text: 'Docs', target: 'https://alpha.example' },
    { id: 'sh1', kind: 'shape', shape: 'rectangle', x: 200, y: 50, w: 80, h: 60, bw: 80, bh: 60, rotation: 0, color: '#000', opacity: 1, text: 'Alpha Box' },
    { id: 'tb1', kind: 'table', x: 300, y: 50, w: 200, h: 100, bw: 200, bh: 100, rotation: 0, color: '#000', opacity: 1, rows: 2, columns: 2, cells: [['Key', 'Value'], ['alpha', '42']] },
    { id: 'st1', kind: 'stroke', x: 0, y: 0, w: 10, h: 10, bw: 10, bh: 10, rotation: 0, color: '#000', opacity: 1, text: 'alpha' },
  ];

  const hits = findItemTextMatches(items, 'alpha', 1, 'page-1', false);
  assert.equal(hits.length, 5);
  assert.deepEqual(hits.map(h => h.itemId), ['t1', 's1', 'l1', 'sh1', 'tb1']);
  assert.equal(hits[0].pageIndex, 1);
  assert.equal(hits[0].pageId, 'page-1');
  assert.deepEqual(hits[3].rects[0], { x: 200, y: 50, w: 80, h: 60 });
  assert.equal(hits[4].text, 'alpha');

  // Case-sensitive check
  assert.equal(findItemTextMatches(items, 'Alpha', 1, 'page-1', true).length, 2);
}

// 6. drawSearchHighlights + PdfSearchController sanity check
{
  const calls = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    fillRect: (x, y, w, h) => calls.push(['fillRect', ctx.fillStyle, x, y, w, h]),
    strokeRect: (x, y, w, h) => calls.push(['strokeRect', ctx.strokeStyle, x, y, w, h]),
  };
  const matches = [
    { pageIndex: 0, pageId: 'p1', rects: [{ x: 1, y: 2, w: 3, h: 4 }], snippet: 'a', text: 'a' },
    { pageIndex: 0, pageId: 'p1', rects: [{ x: 5, y: 6, w: 7, h: 8 }], snippet: 'b', text: 'b' },
    { pageIndex: 1, pageId: 'p2', rects: [{ x: 9, y: 9, w: 9, h: 9 }], snippet: 'c', text: 'c' },
  ];
  drawSearchHighlights(ctx, matches, 1, 'p1', 1);
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'fillRect' && c[1] === 'rgba(250, 204, 21, 0.38)' && c[2] === 1));
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'fillRect' && c[1] === 'rgba(249, 115, 22, 0.52)' && c[2] === 5));
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'strokeRect' && c[2] === 5));
  assert.ok(!calls.some(c => Array.isArray(c) && c[2] === 9));

  const ctrl = new PdfSearchController({
    getBook: () => ({
      format: 'penbook',
      version: 1,
      title: 'T',
      cover: '#000',
      tags: [],
      created: '',
      modified: '',
      resources: {},
      pages: [
        { id: 'p1', title: '', width: 600, height: 800, paper: 'blank', color: '#fff', spacing: 28, items: [{ id: 'i1', kind: 'text', x: 10, y: 10, w: 100, h: 30, bw: 100, bh: 30, rotation: 0, color: '#000', opacity: 1, text: 'hello world' }], bookmark: false, tags: [], ocr: '', pdfText: '' },
        { id: 'p2', title: '', width: 600, height: 800, paper: 'blank', color: '#fff', spacing: 28, items: [{ id: 'i2', kind: 'sticky', x: 20, y: 20, w: 100, h: 80, bw: 100, bh: 80, rotation: 0, color: '#000', opacity: 1, text: 'hello again' }], bookmark: false, tags: [], ocr: '', pdfText: '' },
      ],
    }),
    getPdfs: () => ({ withDocument: async () => [] }),
  });
  const found = await ctrl.search('hello');
  assert.equal(found.length, 2);
  assert.equal(ctrl.getActiveIndex(), 0);
  assert.equal(ctrl.next()?.itemId, 'i2');
  assert.equal(ctrl.prev()?.itemId, 'i1');
  ctrl.clearCache();
  ctrl.destroy();
}

console.log('check-b1.mjs: all assertions passed');
