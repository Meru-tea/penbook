import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export * from './src/library-index';
      export { newBook, newPage, item } from './src/model';
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
const { LibraryIndex, buildLibraryEntry, newBook, newPage, item } = mod;

// Build fixture notebooks, including one with a large base64 PDF resource and rich searchable text
const base64Sentinel = 'JVBERi0xLjQK' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkw'.repeat(64);

const bookA = newBook('Physics Lecture Notes', 'cornell', 'paged');
bookA.tags = ['Science', 'Optics'];
bookA.cover = '#315b91';
bookA.coverStyle = 'classic';
bookA.spineColor = '#18233d';
bookA.hasCover = true;
const pageA1 = newPage('cornell');
pageA1.title = 'Wave Interference';
pageA1.tags = ['Diffraction'];
pageA1.color = '#fffef0';
pageA1.spacing = 32;
pageA1.pdfText = 'Huygens Principle Explained';
pageA1.ocr = 'Handwritten Derivation';
const textItem = item('text', 10, 20, 120, 40, '#000000');
textItem.text = 'Double Slit Experiment';
const tableItem = item('table', 10, 80, 200, 100, '#000000');
tableItem.rows = 2;
tableItem.columns = 2;
tableItem.cells = [
  ['Wavelength', 'Lambda'],
  ['Frequency', 'Hertz'],
];
pageA1.items.push(textItem, tableItem);
const pageA2 = newPage('ruled');
pageA2.title = 'Quantum Lab';
bookA.pages = [pageA1, pageA2];
bookA.resources = {
  'res-pdf-1': {
    type: 'pdf',
    name: 'optics.pdf',
    mime: 'application/pdf',
    data: base64Sentinel,
    size: base64Sentinel.length,
  },
};

const bookB = newBook('Infinite Canvas Board', 'dots', 'infinite');
bookB.hasCover = false;
bookB.pages[0].color = '#f4f5f7';
bookB.pages[0].spacing = 24;
bookB.bookmarks = [
  { id: 'bm-1', title: 'Architecture Overview', x: 100, y: 200, zoom: 1 },
  { id: 'bm-2', title: 'Sprint Roadmap', x: 500, y: 400, zoom: 0.8 },
];

const bookC = newBook('Daily Sketchbook', 'blank', 'paged');

const store = new Map([
  ['Notes/Physics.penbook', { mtime: 1000, size: 5000, content: JSON.stringify(bookA) }],
  ['Boards/System.penbook', { mtime: 2000, size: 1200, content: JSON.stringify(bookB) }],
  ['Sketch/Daily.penbook', { mtime: 3000, size: 800, content: JSON.stringify(bookC) }],
]);

const makeFileList = () =>
  Array.from(store.entries()).map(([path, data]) => ({
    path,
    stat: { mtime: data.mtime, size: data.size },
  }));

// 1. buildLibraryEntry searchText & zero base64 resources check
{
  const directEntry = buildLibraryEntry('Notes/Physics.penbook', 1000, 5000, bookA);
  for (const token of [
    'physics lecture notes',
    'science',
    'optics',
    'wave interference',
    'diffraction',
    'huygens principle explained',
    'handwritten derivation',
    'double slit experiment',
    'wavelength',
    'lambda',
    'frequency',
    'hertz',
    'quantum lab',
  ]) {
    assert.ok(directEntry.searchText.includes(token), `searchText missing token: ${token}`);
  }
  const serialized = JSON.stringify(directEntry);
  assert.ok(!serialized.includes(base64Sentinel), 'entry must not retain base64 resource payload');
  assert.ok(!serialized.includes('JVBERi0xLjQK'), 'entry must not retain PDF base64 prefix');
  assert.ok(!('resources' in directEntry), 'entry must not have resources property');
  assert.equal(directEntry.pageCount, 2);
  assert.equal(directEntry.isInfinite, false);
  assert.equal(directEntry.firstPagePaper, 'cornell');
  assert.equal(directEntry.firstPageColor, '#fffef0');
  assert.equal(directEntry.firstPageSpacing, 32);
  assert.equal(directEntry.coverStyle, 'classic');
  assert.equal(directEntry.spineColor, '#18233d');
  assert.equal(directEntry.hasCover, true);
}

// 2. First scan reads all files once; second scan with unchanged mtime/size triggers 0 readFile calls
const index = new LibraryIndex();
const readCalls = [];
const mockRead = async file => {
  readCalls.push(file.path);
  return store.get(file.path).content;
};

const first = await index.getEntries(makeFileList(), mockRead);
assert.equal(first.length, 3);
assert.deepEqual(readCalls.sort(), [
  'Boards/System.penbook',
  'Notes/Physics.penbook',
  'Sketch/Daily.penbook',
]);

const infEntry = first.find(e => e.path === 'Boards/System.penbook');
assert.ok(infEntry);
assert.equal(infEntry.isInfinite, true);
assert.equal(infEntry.bookmarkCount, 2);
assert.ok(infEntry.searchText.includes('architecture overview'));
assert.ok(infEntry.searchText.includes('sprint roadmap'));

readCalls.length = 0;
const second = await index.getEntries(makeFileList(), mockRead);
assert.equal(second.length, 3);
assert.equal(readCalls.length, 0, 'second scan with unchanged mtime/size must perform 0 readFile calls');

// 3. Modifying mtime re-reads ONLY the modified file
const updatedBookC = { ...bookC, title: 'Updated Sketchbook' };
store.set('Sketch/Daily.penbook', { mtime: 3001, size: 800, content: JSON.stringify(updatedBookC) });
readCalls.length = 0;
const afterMtime = await index.getEntries(makeFileList(), mockRead);
assert.deepEqual(readCalls, ['Sketch/Daily.penbook']);
assert.equal(afterMtime.find(e => e.path === 'Sketch/Daily.penbook')?.title, 'Updated Sketchbook');

// Modifying size (even with same mtime) re-reads ONLY the modified file
const resizedBookB = { ...bookB, title: 'Resized Canvas Board' };
store.set('Boards/System.penbook', { mtime: 2000, size: 1205, content: JSON.stringify(resizedBookB) });
readCalls.length = 0;
const afterSize = await index.getEntries(makeFileList(), mockRead);
assert.deepEqual(readCalls, ['Boards/System.penbook']);
assert.equal(afterSize.find(e => e.path === 'Boards/System.penbook')?.title, 'Resized Canvas Board');

// 4. Deleting a file prunes it cleanly, and rename() moves cache entry cleanly without re-reading
store.delete('Sketch/Daily.penbook');
const physicsData = store.get('Notes/Physics.penbook');
store.delete('Notes/Physics.penbook');
store.set('Archive/Physics.penbook', physicsData);
index.rename('Notes/Physics.penbook', 'Archive/Physics.penbook');

readCalls.length = 0;
const afterRenameAndDelete = await index.getEntries(makeFileList(), mockRead);
assert.equal(readCalls.length, 0, 'rename() + delete should not require re-reading unchanged renamed file');
assert.equal(afterRenameAndDelete.length, 2);
assert.equal(index.get('Notes/Physics.penbook'), undefined);
assert.equal(index.get('Sketch/Daily.penbook'), undefined);
assert.equal(index.get('Archive/Physics.penbook')?.title, 'Physics Lecture Notes');

// 5. invalidate() forces re-read of that file only
index.invalidate('Boards/System.penbook');
readCalls.length = 0;
await index.getEntries(makeFileList(), mockRead);
assert.deepEqual(readCalls, ['Boards/System.penbook']);

// 6. Invalid / corrupted .penbook file is skipped cleanly without crashing
store.set('Broken/Corrupt.penbook', { mtime: 9999, size: 42, content: '{not valid json' });
const withCorrupt = await index.getEntries(makeFileList(), mockRead);
assert.equal(withCorrupt.length, 2);
store.delete('Broken/Corrupt.penbook');
await index.getEntries(makeFileList(), mockRead);

// 7. Disk cache save + load into fresh instance yields 0 readFile calls, and corrupted cache is ignored
let savedJson = '';
await index.save(async data => {
  savedJson = data;
});
assert.ok(!savedJson.includes(base64Sentinel), 'persisted disk cache must not contain base64 resources');
const parsedSaved = JSON.parse(savedJson);
assert.equal(parsedSaved.version, 1);
assert.equal(parsedSaved.entries.length, 2);

const warmIndex = new LibraryIndex();
await warmIndex.load(async () => savedJson);
readCalls.length = 0;
const warmEntries = await warmIndex.getEntries(makeFileList(), mockRead);
assert.equal(warmEntries.length, 2);
assert.equal(readCalls.length, 0, 'warm cache load must avoid all readFile calls');

const corruptCacheIndex = new LibraryIndex();
await corruptCacheIndex.load(async () => '{bad json');
await corruptCacheIndex.load(async () => JSON.stringify({ version: 999, entries: [] }));
await corruptCacheIndex.load(async () => { throw new Error('disk missing'); });
assert.equal(corruptCacheIndex.size, 0);

console.log(JSON.stringify({
  libraryIndexTestsPassed: true,
  entriesVerified: warmEntries.length,
  warmReadCalls: readCalls.length,
}));
