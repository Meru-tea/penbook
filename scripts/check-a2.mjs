import assert from 'node:assert/strict';
import { build } from 'esbuild';

const combined = await build({
  stdin: {
    contents: `
      export * from './src/shape-connectors';
      export { item, stroke } from './src/model';
    `,
    loader: 'ts',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});

const mod = await import('data:text/javascript;base64,' + Buffer.from(combined.outputFiles[0].text).toString('base64'));
const {
  CONNECTABLE_SHAPES,
  isScribbleGesture,
  findScribbleTargets,
  adjustSnappedShape,
  getShapeAnchors,
  findNearestAnchor,
  computeConnectorPoints,
  updateBoundConnectors,
  clearDanglingBindings,
  item,
  stroke,
} = mod;

const approx = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// 1. isScribbleGesture: true for zig-zags, false for straight lines, circles, loops, normal text strokes
{
  // Zig-zag scribble across 80x40
  const zigzag = [];
  for (let i = 0; i < 16; i++) {
    zigzag.push([100 + i * 5, i % 2 === 0 ? 100 : 145, 0.5]);
  }
  assert.equal(isScribbleGesture(zigzag, 1), true, 'sharp zig-zag should be detected as scribble');

  // Sinusoidal/rounded scribble
  const waveScribble = [];
  for (let i = 0; i < 25; i++) {
    const t = (i / 24) * Math.PI * 5;
    waveScribble.push([100 + i * 3, 120 + Math.sin(t) * 28, 0.5]);
  }
  assert.equal(isScribbleGesture(waveScribble, 1), true, 'rapid back-and-forth wave scribble should be detected');

  // Zoomed out scribble (diagonal >= 18/zoom)
  const zoomedOut = zigzag.map(([x, y, p]) => [x * 4, y * 4, p]);
  assert.equal(isScribbleGesture(zoomedOut, 0.25), true, 'zoomed-out scribble should scale with zoom');

  // Straight line
  const linePts = Array.from({ length: 15 }, (_, i) => [i * 10, i * 4, 0.5]);
  assert.equal(isScribbleGesture(linePts, 1), false, 'straight line must not trigger scribble');

  // Circle
  const circlePts = Array.from({ length: 33 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return [200 + Math.cos(a) * 45, 200 + Math.sin(a) * 45, 0.5];
  });
  assert.equal(isScribbleGesture(circlePts, 1), false, 'circle must not trigger scribble');

  // Triangle
  const trianglePts = [];
  const tv = [[100, 100], [180, 100], [140, 170], [100, 100]];
  for (let seg = 0; seg < 3; seg++) {
    for (let k = 0; k < 6; k++) {
      const t = k / 6;
      trianglePts.push([tv[seg][0] + (tv[seg + 1][0] - tv[seg][0]) * t, tv[seg][1] + (tv[seg + 1][1] - tv[seg][1]) * t, 0.5]);
    }
  }
  trianglePts.push([100, 100, 0.5]);
  assert.equal(isScribbleGesture(trianglePts, 1), false, 'triangle must not trigger scribble');

  // Loop / cursive 'e'
  const loopPts = Array.from({ length: 24 }, (_, i) => {
    const t = (i / 23) * Math.PI * 2.2;
    return [100 + i * 2.2 + Math.cos(t) * 16, 120 - Math.sin(t) * 20, 0.5];
  });
  assert.equal(isScribbleGesture(loopPts, 1), false, 'cursive loop must not trigger scribble');

  // Normal handwriting 'L' + 'S'
  const letterL = [
    ...Array.from({ length: 8 }, (_, i) => [50, 50 + i * 6, 0.5]),
    ...Array.from({ length: 8 }, (_, i) => [50 + i * 5, 92, 0.5]),
  ];
  assert.equal(isScribbleGesture(letterL, 1), false, 'letter L must not trigger scribble');

  const letterS = Array.from({ length: 22 }, (_, i) => {
    const t = i / 21;
    return [100 + Math.sin(t * Math.PI * 2) * 16, 50 + t * 44, 0.5];
  });
  assert.equal(isScribbleGesture(letterS, 1), false, 'letter S must not trigger scribble');

  // Too tiny / too few points
  assert.equal(isScribbleGesture(zigzag.slice(0, 6), 1), false, 'too few points');
  assert.equal(isScribbleGesture(zigzag.map(([x, y, p]) => [100 + (x - 100) * 0.1, 100 + (y - 100) * 0.1, p]), 1), false, 'too tiny');
}

// 2. findScribbleTargets: hits overlapping strokes, ignores distant and locked strokes
{
  const scribble = Array.from({ length: 14 }, (_, i) => [100 + i * 6, i % 2 === 0 ? 100 : 140, 0.5]);
  const hitStroke = stroke([[90, 120, 0.5], [190, 120, 0.5]], '#111111', 3, 'ballpoint');
  const lockedStroke = { ...stroke([[90, 125, 0.5], [190, 125, 0.5]], '#111111', 3, 'ballpoint'), locked: true };
  const distantStroke = stroke([[500, 500, 0.5], [600, 520, 0.5]], '#111111', 3, 'ballpoint');
  const nonStroke = { ...item('shape', 90, 100, 80, 40, '#111111'), shape: 'rectangle' };

  const targets = findScribbleTargets(scribble, [hitStroke, lockedStroke, distantStroke, nonStroke], 6);
  assert.deepEqual(targets.map(t => t.id), [hitStroke.id]);
}

// 3. getShapeAnchors: handles unrotated and rotated shapes accurately
{
  assert.equal(CONNECTABLE_SHAPES.has('rectangle'), true);
  assert.equal(CONNECTABLE_SHAPES.has('ellipse'), true);
  assert.equal(CONNECTABLE_SHAPES.has('line'), false);

  const rect = { ...item('shape', 100, 100, 80, 40, '#000'), shape: 'rectangle', rotation: 90 };
  const anchors = Object.fromEntries(getShapeAnchors(rect).map(a => [a.anchor, a]));
  // Center is (140, 120). Top (0,-20) rotated 90 deg CW -> (160, 120) with normal (1, 0)
  approx(anchors.center.x, 140);
  approx(anchors.center.y, 120);
  approx(anchors.top.x, 160);
  approx(anchors.top.y, 120);
  approx(anchors.top.nx, 1);
  approx(anchors.top.ny, 0);
  approx(anchors.right.x, 140);
  approx(anchors.right.y, 160);
  approx(anchors.right.nx, 0);
  approx(anchors.right.ny, 1);

  const hit = findNearestAnchor([157, 121], [rect], 12);
  assert.ok(hit);
  assert.equal(hit.item.id, rect.id);
  assert.equal(hit.anchor, 'top');

  // Triangle anchors snap onto triangle boundary
  const tri = { ...item('shape', 0, 0, 100, 80, '#000'), shape: 'triangle' };
  const triAnchors = Object.fromEntries(getShapeAnchors(tri).map(a => [a.anchor, a]));
  approx(triAnchors.top.x, 50);
  approx(triAnchors.top.y, 0);
  approx(triAnchors.bottom.x, 50);
  approx(triAnchors.bottom.y, 80);
  assert.ok(triAnchors.right.x > 50 && triAnchors.right.x <= 100);
}

// 4. computeConnectorPoints: straight, elbow, curved
{
  const straight = computeConnectorPoints([0, 0], [100, 50], 'straight');
  assert.equal(straight.length, 2);
  assert.deepEqual(straight[0].slice(0, 2), [0, 0]);
  assert.deepEqual(straight[1].slice(0, 2), [100, 50]);

  const elbowZ = computeConnectorPoints([0, 0], [100, 60], 'elbow', [1, 0], [-1, 0]);
  assert.equal(elbowZ.length, 4);
  for (let i = 1; i < elbowZ.length; i++) {
    const dx = Math.abs(elbowZ[i][0] - elbowZ[i - 1][0]);
    const dy = Math.abs(elbowZ[i][1] - elbowZ[i - 1][1]);
    assert.ok(dx < 1e-6 || dy < 1e-6, 'elbow segments must be orthogonal');
  }

  const elbowL = computeConnectorPoints([0, 0], [100, 60], 'elbow', [1, 0], [0, -1]);
  assert.equal(elbowL.length, 3);
  assert.deepEqual(elbowL[1].slice(0, 2), [100, 0]);

  const curved = computeConnectorPoints([0, 0], [100, 80], 'curved', [1, 0], [-1, 0]);
  assert.ok(curved.length >= 10);
  assert.deepEqual(curved[0].slice(0, 2), [0, 0]);
  assert.deepEqual(curved.at(-1).slice(0, 2), [100, 80]);
}

// 5. adjustSnappedShape: arrow endpoints + bindings & 45-degree snap; rectangle/ellipse resize
{
  const boxA = { ...item('shape', 100, 100, 80, 60, '#111'), shape: 'rectangle' };
  const boxB = { ...item('shape', 300, 100, 80, 60, '#111'), shape: 'ellipse' };
  const snappedArrow = {
    ...item('shape', 178, 128, 40, 10, '#111'),
    shape: 'arrow',
    points: [[0, 0, 0.5], [40, 10, 0.5]],
  };

  // Drag arrow from boxA.right (180, 130) to boxB.left (300, 130)
  const boundArrow = adjustSnappedShape(snappedArrow, [177, 131, 0.5], [297, 129, 0.5], [boxA, boxB], 1);
  assert.deepEqual(boundArrow.startBinding, { itemId: boxA.id, anchor: 'right' });
  assert.deepEqual(boundArrow.endBinding, { itemId: boxB.id, anchor: 'left' });
  approx(boundArrow.x, 180);
  approx(boundArrow.y, 130);
  approx(boundArrow.w, 120);

  // Drag arrow end freely near 45 degrees without nearby anchor
  const angledArrow = adjustSnappedShape(snappedArrow, [0, 0, 0.5], [100, 103, 0.5], [boxA, boxB], 1);
  assert.equal(angledArrow.endBinding, undefined);
  const endWorldX = angledArrow.x + angledArrow.points[1][0];
  const endWorldY = angledArrow.y + angledArrow.points[1][1];
  approx(endWorldX, endWorldY, 1e-3);

  // Resize snapped rectangle & ellipse
  const snappedRect = { ...item('shape', 100, 100, 80, 60, '#111'), shape: 'rectangle' };
  const resizedRect = adjustSnappedShape(snappedRect, [100, 100, 0.5], [60, 40, 0.5], [], 1);
  assert.equal(resizedRect.shape, 'rectangle');
  assert.ok(resizedRect.w > snappedRect.w && resizedRect.h > snappedRect.h);
  approx(resizedRect.bw, resizedRect.w);
  approx(resizedRect.bh, resizedRect.h);

  const snappedEllipse = { ...item('shape', 200, 200, 60, 60, '#111'), shape: 'ellipse' };
  const resizedEllipse = adjustSnappedShape(snappedEllipse, [200, 230, 0.5], [170, 230, 0.5], [], 1);
  assert.equal(resizedEllipse.shape, 'ellipse');
  approx(resizedEllipse.w, 120);
  approx(resizedEllipse.h, 120);
}

// 6. updateBoundConnectors & clearDanglingBindings
{
  const shapeA = { ...item('shape', 0, 0, 100, 80, '#111'), shape: 'rectangle', rotation: 0 };
  const shapeB = { ...item('shape', 250, 20, 100, 80, '#111'), shape: 'rectangle', rotation: 0 };
  const arrow = {
    ...item('shape', 100, 40, 150, 20, '#111'),
    shape: 'arrow',
    points: [[0, 0, 0.5], [150, 20, 0.5]],
    startBinding: { itemId: shapeA.id, anchor: 'right' },
    endBinding: { itemId: shapeB.id, anchor: 'left' },
    connectorRoute: 'straight',
  };

  // Move and rotate shapeB
  shapeB.x = 320;
  shapeB.y = 140;
  shapeB.rotation = 90;
  const updated = updateBoundConnectors([shapeA, shapeB, arrow], new Set([shapeB.id]));
  assert.deepEqual(updated, [arrow.id]);

  // Verify arrow endpoints match shapeA.right (100, 40) and rotated shapeB.left
  const expectedBLeft = getShapeAnchors(shapeB).find(a => a.anchor === 'left');
  const actualStart = [arrow.x + arrow.points[0][0], arrow.y + arrow.points[0][1]];
  const actualEnd = [arrow.x + arrow.points[1][0], arrow.y + arrow.points[1][1]];
  approx(actualStart[0], 100);
  approx(actualStart[1], 40);
  approx(actualEnd[0], expectedBLeft.x);
  approx(actualEnd[1], expectedBLeft.y);

  // Deleting shapeB clears dangling endBinding
  clearDanglingBindings([shapeA, arrow]);
  assert.ok(arrow.startBinding);
  assert.equal(arrow.endBinding, undefined);
}

console.log('check-a2: all assertions passed');
