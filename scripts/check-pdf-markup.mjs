import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { createCanvas, Image, Path2D, DOMMatrix } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

await build({
  entryPoints: ['scripts/next-version-api.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'release/pdf-markup-api.mjs',
  logLevel: 'silent',
  plugins: [
    {
      name: 'worker',
      setup(b) {
        b.onResolve({ filter: /pdf\.worker\.mjs$/ }, a => ({
          path: resolve('node_modules', a.path),
          namespace: 'worker',
        }));
        b.onLoad({ filter: /.*/, namespace: 'worker' }, async a => ({
          contents: await readFile(a.path, 'utf8'),
          loader: 'text',
        }));
      },
    },
  ],
});

const canvas = (w = 1, h = 1) => {
  const c = createCanvas(w, h);
  c.toBlob = callback => callback(new Blob([c.toBuffer('image/png')]));
  return c;
};
Object.assign(globalThis, { Image, Path2D, DOMMatrix, document: { createElement: () => canvas() } });

const api = await import('../release/pdf-markup-api.mjs');
const renderer = new api.Renderer();
const fonts = resolve('node_modules/pdfjs-dist/standard_fonts') + '/';

const mockPage = (pageHeight = 800) => ({
  getViewport: () => ({
    width: 600,
    height: pageHeight,
    convertToViewportPoint: (x, y) => [x, pageHeight - y],
  }),
});

const polygonArea = ring => {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
};

const assertQuadPointsInBounds = o => {
  const qps = o.pdfMarkup?.quadPoints;
  assert.ok(Array.isArray(qps) && qps.length === 4, 'expected 4 quadPoints');
  for (const [qx, qy] of qps) {
    assert.ok(qx >= -1e-6 && qx <= o.bw + 1e-6, `quadPoint x=${qx} out of [0, ${o.bw}]`);
    assert.ok(qy >= -1e-6 && qy <= o.bh + 1e-6, `quadPoint y=${qy} out of [0, ${o.bh}]`);
  }
  // Canonical order: [topLeft, topRight, bottomLeft, bottomRight]
  assert.ok(qps[0][0] < qps[1][0], 'topLeft.x < topRight.x');
  assert.ok(qps[2][0] < qps[3][0], 'bottomLeft.x < bottomRight.x');
  assert.ok(qps[0][1] < qps[2][1], 'topLeft.y < bottomLeft.y');
  assert.ok(qps[1][1] < qps[3][1], 'topRight.y < bottomRight.y');
};

// 1. Canonical quad normalization for swapped/reversed/CCW/bottom-up quadPoints orders
{
  const page = mockPage(800);
  // PDF box: x in [100, 220] (width 120), y in [700, 720] (height 20) -> viewport y in [80, 100]
  const quadVariants = [
    [100, 720, 220, 720, 100, 700, 220, 700], // standard PDF Z-order
    [100, 700, 220, 700, 220, 720, 100, 720], // CCW perimeter order
    [100, 700, 220, 700, 100, 720, 220, 720], // bottom-up Z-order
    [220, 720, 100, 720, 220, 700, 100, 700], // horizontally reversed Z-order
    [220, 700, 100, 720, 100, 700, 220, 720], // scrambled diagonals
  ];
  for (const quadPoints of quadVariants) {
    const items = api.annotationItems(
      { id: 'hl-norm', annotationType: 9, subtype: 'Highlight', rect: [100, 700, 220, 720], quadPoints, color: [255, 230, 0] },
      page,
    );
    assert.equal(items.length, 1);
    const o = items[0];
    assert.ok(o.frozenInk?.length === 1 && o.frozenInk[0].length === 4, 'Highlight keeps frozenInk quad');
    assert.ok(Math.abs(polygonArea(o.frozenInk[0]) - 120 * 20) < 1e-3, 'normalized quad must not form a bowtie');
    assertQuadPointsInBounds(o);
    assert.equal(o.opacity, 0.35);
    assert.equal(o.pen, 'highlighter');
  }

  // Unspecified subtype on annotationType 9 behaves like Highlight
  const unspecified = api.annotationItems(
    { id: 'hl-unspec', annotationType: 9, rect: [100, 700, 220, 720], quadPoints: quadVariants[1], color: [255, 255, 0] },
    page,
  )[0];
  assert.ok(unspecified.frozenInk?.length === 1);
  assert.equal(unspecified.opacity, 0.35);
}

// 2. Underline, StrikeOut, Squiggly geometry, width, opacity clamping, and no frozenInk
{
  const page = mockPage(800);
  const quadPoints = [100, 700, 260, 700, 260, 720, 100, 720]; // height=20, width=160, viewport top=80, bottom=100

  const underline = api.annotationItems(
    { id: 'ul-1', annotationType: 10, subtype: 'Underline', rect: [100, 700, 260, 720], quadPoints, color: [0, 128, 0] },
    page,
  )[0];
  assert.equal(underline.frozenInk, undefined);
  assert.equal(underline.pen, 'ballpoint');
  assert.equal(underline.opacity, 1);
  assert.equal(underline.width, Math.max(1, 20 * 0.08));
  assert.equal(underline.points.length, 2);
  assert.equal(underline.pdfMarkup.subtype, 'Underline');
  assertQuadPointsInBounds(underline);
  // Bottom edge stroke sits below quad midline
  const ulQ = underline.pdfMarkup.quadPoints;
  const ulMidY = (ulQ[0][1] + ulQ[2][1]) / 2;
  assert.ok(underline.points[0][1] > ulMidY && underline.points[1][1] > ulMidY);
  assert.ok(Math.abs(underline.points[0][1] - underline.points[1][1]) < 1e-6);

  // Also works if caller mocks annotationType 9 with subtype 'Underline'
  const underlineMock9 = api.annotationItems(
    { id: 'ul-9', annotationType: 9, subtype: 'Underline', rect: [100, 700, 260, 720], quadPoints, color: [0, 128, 0], opacity: 1.7 },
    page,
  )[0];
  assert.equal(underlineMock9.frozenInk, undefined);
  assert.equal(underlineMock9.opacity, 1);

  const strike = api.annotationItems(
    { id: 'so-1', annotationType: 12, subtype: 'StrikeOut', rect: [100, 700, 260, 720], quadPoints, color: [220, 0, 0], opacity: -0.4 },
    page,
  )[0];
  assert.equal(strike.frozenInk, undefined);
  assert.equal(strike.pen, 'ballpoint');
  assert.equal(strike.opacity, 0);
  assert.equal(strike.width, Math.max(1, 20 * 0.08));
  assert.equal(strike.points.length, 2);
  assert.equal(strike.pdfMarkup.subtype, 'StrikeOut');
  assertQuadPointsInBounds(strike);
  const soQ = strike.pdfMarkup.quadPoints;
  const soMidY = (soQ[0][1] + soQ[2][1]) / 2;
  assert.ok(Math.abs(strike.points[0][1] - soMidY) < 1e-6 && Math.abs(strike.points[1][1] - soMidY) < 1e-6);

  const squiggly = api.annotationItems(
    { id: 'sq-1', annotationType: 11, subtype: 'Squiggly', rect: [100, 700, 260, 720], quadPoints, color: [255, 80, 0], opacity: 0.75 },
    page,
  )[0];
  assert.equal(squiggly.frozenInk, undefined);
  assert.equal(squiggly.pen, 'ballpoint');
  assert.equal(squiggly.opacity, 0.75);
  assert.equal(squiggly.width, Math.max(0.8, 20 * 0.07));
  assert.ok(squiggly.points.length > 8, 'Squiggly generates multi-point wave polyline');
  assert.equal(squiggly.pdfMarkup.subtype, 'Squiggly');
  assertQuadPointsInBounds(squiggly);
  const sqYs = squiggly.points.map(p => p[1]);
  const sqBaseY = squiggly.points[0][1];
  assert.ok(Math.min(...sqYs) < sqBaseY && Math.max(...sqYs) > sqBaseY, 'Squiggly wave oscillates around baseline');
  assert.ok(Math.abs(Math.max(...sqYs) - sqBaseY - Math.max(1.2, 20 * 0.09)) < 0.3, 'Squiggly amplitude matches spec');
}

// 3. Renderer.draw, itemSvg, and vectorAppearance outputs
{
  const page = mockPage(800);
  const quadPoints = [100, 700, 260, 700, 100, 720, 260, 720];
  const book = api.newBook('Markup');
  const svgCanvas = canvas(400, 200);
  const svgCtx = svgCanvas.getContext('2d');

  const highlight = api.annotationItems(
    { id: 'hl', annotationType: 9, subtype: 'Highlight', rect: [100, 700, 260, 720], quadPoints, color: [255, 255, 0] },
    page,
  )[0];
  const underline = api.annotationItems(
    { id: 'ul', annotationType: 10, subtype: 'Underline', rect: [100, 700, 260, 720], quadPoints, color: [0, 128, 0] },
    page,
  )[0];
  const strike = api.annotationItems(
    { id: 'so', annotationType: 12, subtype: 'StrikeOut', rect: [100, 700, 260, 720], quadPoints, color: [200, 0, 0] },
    page,
  )[0];
  const squiggly = api.annotationItems(
    { id: 'sq', annotationType: 11, subtype: 'Squiggly', rect: [100, 700, 260, 720], quadPoints, color: [255, 100, 0] },
    page,
  )[0];

  // Spy canvas context to verify Renderer.draw strokes polylines instead of filling blobs
  const spyDraw = item => {
    const ops = [];
    let comp = 'source-over';
    let lw = 0;
    const ctx = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      scale() {},
      setLineDash() {},
      beginPath() { ops.push('beginPath'); },
      moveTo() { ops.push('moveTo'); },
      lineTo() { ops.push('lineTo'); },
      closePath() { ops.push('closePath'); },
      stroke() { ops.push('stroke'); },
      fill() { ops.push('fill'); },
      clip() {},
      set globalAlpha(_) {},
      set fillStyle(_) {},
      set strokeStyle(_) {},
      set lineCap(_) {},
      set lineJoin(_) {},
      set lineWidth(v) { lw = v; },
      get lineWidth() { return lw; },
      set globalCompositeOperation(v) { comp = v; },
      get globalCompositeOperation() { return comp; },
    };
    renderer.draw(ctx, item);
    return { ops, comp, lw };
  };

  const hlDraw = spyDraw(highlight);
  assert.equal(hlDraw.comp, 'multiply');
  assert.ok(hlDraw.ops.includes('fill'));

  for (const item of [underline, strike, squiggly]) {
    const res = spyDraw(item);
    assert.equal(res.comp, 'source-over');
    assert.ok(res.ops.includes('stroke'), `${item.pdfMarkup.subtype} must call ctx.stroke()`);
    assert.ok(!res.ops.includes('fill'), `${item.pdfMarkup.subtype} must not call ctx.fill()`);
    assert.equal(res.lw, item.width);

    // Also render onto real @napi-rs/canvas to ensure no runtime errors
    const realCanvas = canvas(400, 200);
    renderer.draw(realCanvas.getContext('2d'), item);

    const svg = api.itemSvg(item, book, renderer, svgCtx, item.id);
    assert.ok(svg.includes('fill="none"'), `${item.pdfMarkup.subtype} SVG must use fill="none"`);
    assert.ok(svg.includes('stroke="'), `${item.pdfMarkup.subtype} SVG must include stroke`);
    assert.ok(!svg.includes('mix-blend-mode:multiply'), `${item.pdfMarkup.subtype} SVG must not use multiply`);

    const pdfOps = api.vectorAppearance(item, renderer);
    assert.ok(pdfOps && pdfOps.endsWith('\nS'), `${item.pdfMarkup.subtype} vectorAppearance must end with S`);
    assert.ok(!pdfOps.includes('f*'), `${item.pdfMarkup.subtype} vectorAppearance must not emit f*`);
    assert.ok(!pdfOps.includes('/Multiply gs'), `${item.pdfMarkup.subtype} vectorAppearance must not emit /Multiply gs`);
  }

  // Test fallback lineWidth (1.5) when o.width is undefined on line markup
  const noWidthUnderline = { ...underline, width: undefined };
  assert.equal(spyDraw(noWidthUnderline).lw, 1.5);
  assert.ok(api.itemSvg(noWidthUnderline, book, renderer, svgCtx, 'ul-nw').includes('stroke-width="1.5"'));
  assert.ok(api.vectorAppearance(noWidthUnderline, renderer).includes('1.5 w'));

  const hlSvg = api.itemSvg(highlight, book, renderer, svgCtx, highlight.id);
  assert.ok(hlSvg.includes('style="mix-blend-mode:multiply"'));
  assert.ok(hlSvg.includes('fill-rule="evenodd"'));

  const hlPdfOps = api.vectorAppearance(highlight, renderer);
  assert.ok(hlPdfOps.includes('/Multiply gs'));
  assert.ok(hlPdfOps.endsWith('\nf*'));
}

// 4. End-to-end PDF export & re-import round-trip for all 4 TextMarkup subtypes
{
  const src = await PDFDocument.create();
  const p = src.addPage([500, 500]);
  const subtypes = ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'];
  subtypes.forEach((subtype, idx) => {
    const y = 400 - idx * 60;
    const ref = src.context.register(
      src.context.obj({
        Type: 'Annot',
        Subtype: subtype,
        P: p.ref,
        Rect: [50, y, 250, y + 20],
        QuadPoints: [50, y, 250, y, 250, y + 20, 50, y + 20], // non-standard CCW order
        F: 4,
        C: [0.1, 0.4, 0.9],
        ...(subtype === 'Highlight' ? { CA: 0.35 } : {}),
      }),
    );
    p.node.addAnnot(ref);
  });

  const srcBytes = await src.save();
  const book = api.newBook('Markup RoundTrip');
  book.resources.src = { type: 'pdf', mime: 'application/pdf', name: 'markup.pdf', data: api.encode(srcBytes) };
  const pdfDoc = await getDocument({ data: srcBytes.slice(), standardFontDataUrl: fonts }).promise;
  book.pages = await api.importPdfPages(pdfDoc, 'src', 'markup.pdf', book);
  await pdfDoc.loadingTask.destroy();

  assert.equal(book.pages[0].items.length, 4);
  for (const subtype of subtypes) {
    const item = book.pages[0].items.find(o => o.pdfMarkup?.subtype === subtype);
    assert.ok(item, `expected imported ${subtype}`);
    assert.equal(item.pdfNative, undefined, `${subtype} must import as native Penbook stroke, not pdfNative preview`);
    assertQuadPointsInBounds(item);
    if (subtype === 'Highlight') {
      assert.ok(item.frozenInk?.length === 1);
      assert.equal(item.opacity, 0.35);
    } else {
      assert.equal(item.frozenInk, undefined);
      assert.equal(item.opacity, 1);
    }
  }

  const pdfs = new api.PDFs(p => p);
  const exported = await pdfs.export(book, book.pages, renderer, 'all');
  const reDoc = await getDocument({ data: exported.slice(), standardFontDataUrl: fonts }).promise;
  const rePage = await reDoc.getPage(1);
  const reAnnots = await rePage.getAnnotations();
  assert.deepEqual(
    reAnnots.map(a => a.subtype).sort(),
    subtypes.slice().sort(),
  );
  for (const a of reAnnots) {
    assert.equal(a.quadPoints?.length, 8, `${a.subtype} exported QuadPoints should have 8 numbers`);
  }
  await reDoc.loadingTask.destroy();
  await pdfs.clear();
}

console.log('PASS: pdf-markup canonical quads, Highlight/Underline/StrikeOut/Squiggly import, Canvas/SVG/PDF rendering, and round-trip.');
