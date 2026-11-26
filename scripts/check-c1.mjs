import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const obsidianStubPlugin = {
  name: 'obsidian-stub',
  setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'obsidian-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({
      contents: `
        export class Component {
          _cleanups = [];
          _children = [];
          load() { this.onload?.(); }
          unload() {
            this.onunload?.();
            for (const c of this._cleanups.splice(0)) c();
            for (const ch of this._children.splice(0)) ch.unload?.();
          }
          register(cb) { this._cleanups.push(cb); }
          registerEvent(ref) { this.register(() => ref?.unload?.()); }
          addChild(ch) { this._children.push(ch); ch.load?.(); return ch; }
        }
        export class MarkdownRenderChild extends Component {
          constructor(containerEl) { super(); this.containerEl = containerEl; }
        }
        export class TFile {
          constructor(path = '', mtime = 1) {
            this.path = path;
            this.extension = path.split('.').pop() || '';
            this.basename = path.split('/').pop().replace(/\\.[^.]+$/, '');
            this.stat = { mtime, ctime: mtime, size: 100 };
          }
        }
        export const normalizePath = p => String(p).replace(/\\\\/g, '/').replace(/\\/+/g, '/');
        export const parseLinktext = link => {
          const i = String(link).indexOf('#');
          return i < 0 ? { path: link, subpath: '' } : { path: link.slice(0, i), subpath: link.slice(i) };
        };
        export const addIcon = () => {};
      `,
      loader: 'js',
    }));
    b.onLoad({ filter: /[/\\]pdf\.worker\.mjs$/ }, () => ({ contents: '', loader: 'text' }));
    b.onLoad({ filter: /\.svg$/ }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
  },
};

const bundle = await build({
  stdin: {
    contents: `
      export * from './src/embed';
      export { newBook, newPage, item } from './src/model';
      export { contentBounds } from './src/infinite';
      export { TFile } from 'obsidian';
    `,
    loader: 'ts',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [obsidianStubPlugin],
});

const mod = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const { resolveEmbedTarget, formatEmbedLink, PenbookEmbedManager, newBook, newPage, item, contentBounds, TFile } = mod;

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// 1. formatEmbedLink tests
{
  assert.equal(formatEmbedLink('Notes/Math.penbook'), '![[Notes/Math.penbook]]');
  assert.equal(formatEmbedLink('Notes/Math.penbook', ''), '![[Notes/Math.penbook]]');
  assert.equal(formatEmbedLink('Notes/Math.penbook', '   '), '![[Notes/Math.penbook]]');
  assert.equal(formatEmbedLink('Notes/Math.penbook', 'page-2'), '![[Notes/Math.penbook#page-2]]');
  assert.equal(formatEmbedLink('Notes/Math.penbook', '#bm-1'), '![[Notes/Math.penbook#bm-1]]');
}

// 2. resolveEmbedTarget - paged mode
{
  const book = newBook('Physics', 'ruled', 'paged');
  const p1 = { ...newPage('ruled'), id: 'id-cover', title: 'Cover' };
  const p2 = { ...newPage('grid'), id: 'id-kinematics', title: '  Kinematics  ' };
  const p3 = { ...newPage('dots'), id: 'id-optics', title: 'Optics & Waves' };
  book.pages = [p1, p2, p3];

  // Default fallback
  assert.deepEqual(resolveEmbedTarget(book), { mode: 'paged', page: p1, pageIndex: 0 });
  assert.deepEqual(resolveEmbedTarget(book, ''), { mode: 'paged', page: p1, pageIndex: 0 });
  assert.deepEqual(resolveEmbedTarget(book, '#'), { mode: 'paged', page: p1, pageIndex: 0 });
  assert.deepEqual(resolveEmbedTarget(book, 'nonexistent'), { mode: 'paged', page: p1, pageIndex: 0 });

  // Match by page.id
  assert.deepEqual(resolveEmbedTarget(book, 'id-kinematics'), { mode: 'paged', page: p2, pageIndex: 1 });
  assert.deepEqual(resolveEmbedTarget(book, '#id-optics'), { mode: 'paged', page: p3, pageIndex: 2 });

  // Match by 1-based page number ('3', 'p3')
  assert.deepEqual(resolveEmbedTarget(book, '2'), { mode: 'paged', page: p2, pageIndex: 1 });
  assert.deepEqual(resolveEmbedTarget(book, '3'), { mode: 'paged', page: p3, pageIndex: 2 });
  assert.deepEqual(resolveEmbedTarget(book, 'p2'), { mode: 'paged', page: p2, pageIndex: 1 });
  assert.deepEqual(resolveEmbedTarget(book, 'P3'), { mode: 'paged', page: p3, pageIndex: 2 });
  assert.deepEqual(resolveEmbedTarget(book, '#p3'), { mode: 'paged', page: p3, pageIndex: 2 });

  // Out-of-range page numbers fall back to page 0
  assert.deepEqual(resolveEmbedTarget(book, '0'), { mode: 'paged', page: p1, pageIndex: 0 });
  assert.deepEqual(resolveEmbedTarget(book, '4'), { mode: 'paged', page: p1, pageIndex: 0 });
  assert.deepEqual(resolveEmbedTarget(book, 'p99'), { mode: 'paged', page: p1, pageIndex: 0 });

  // Match by page.title (trimmed, case-insensitive)
  assert.deepEqual(resolveEmbedTarget(book, 'Kinematics'), { mode: 'paged', page: p2, pageIndex: 1 });
  assert.deepEqual(resolveEmbedTarget(book, '  kinematics '), { mode: 'paged', page: p2, pageIndex: 1 });
  assert.deepEqual(resolveEmbedTarget(book, 'optics & waves'), { mode: 'paged', page: p3, pageIndex: 2 });
}

// 3. resolveEmbedTarget - infinite mode
{
  const emptyInf = newBook('Empty Board', 'dots', 'infinite');
  const tEmpty = resolveEmbedTarget(emptyInf);
  assert.equal(tEmpty.mode, 'infinite');
  assert.equal(tEmpty.bookmark, undefined);
  assert.deepEqual(tEmpty.region, { x: -400, y: -300, w: 800, h: 600 });

  const inf = newBook('Mind Map', 'grid', 'infinite');
  inf.pages[0].items.push(
    { ...item('sticky', -200, -100, 120, 80, '#000'), text: 'A' },
    { ...item('text', 300, 200, 180, 90, '#000'), text: 'B' },
  );
  inf.bookmarks = [
    { id: 'bm-overview', title: 'Overview', x: 100, y: 50, zoom: 1 },
    { id: 'bm-detail', title: '  Detail Zone  ', x: -500, y: 300, zoom: 2 },
  ];

  // Bookmark by id
  const tBmId = resolveEmbedTarget(inf, 'bm-overview');
  assert.equal(tBmId.mode, 'infinite');
  assert.equal(tBmId.bookmark?.id, 'bm-overview');
  approx(tBmId.region.x, 100 - 420);
  approx(tBmId.region.y, 50 - 300);
  approx(tBmId.region.w, 840);
  approx(tBmId.region.h, 600);

  // Bookmark by title (trimmed, case-insensitive)
  const tBmTitle = resolveEmbedTarget(inf, 'detail zone');
  assert.equal(tBmTitle.mode, 'infinite');
  assert.equal(tBmTitle.bookmark?.id, 'bm-detail');
  approx(tBmTitle.region.x, -500 - 420 / 2);
  approx(tBmTitle.region.y, 300 - 300 / 2);
  approx(tBmTitle.region.w, 840 / 2);
  approx(tBmTitle.region.h, 600 / 2);

  // Non-empty infinite board without bookmark match falls back to contentBounds(items, 48)
  const expectedBounds = contentBounds(inf.pages[0].items, 48);
  const tFallback = resolveEmbedTarget(inf, 'missing-bookmark');
  assert.equal(tFallback.mode, 'infinite');
  assert.equal(tFallback.bookmark, undefined);
  assert.deepEqual(tFallback.region, expectedBounds);
}

// 4. PenbookEmbedManager: cache, mtime invalidation, markdown/codeblock/embedRegistry, modify refresh, unload
{
  const makeEl = (tag = 'div', attrs = {}) => {
    const classes = new Set();
    const listeners = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      attributes: { ...attrs },
      style: {},
      classList: {
        add: (...c) => c.forEach(x => classes.add(x)),
        remove: (...c) => c.forEach(x => classes.delete(x)),
        contains: c => classes.has(c),
      },
      addClass(c) { classes.add(c); },
      empty() { this.children = []; },
      createDiv(opts = {}) {
        const d = makeEl('div', opts.attr || {});
        if (opts.cls) opts.cls.split(/\s+/).filter(Boolean).forEach(c => d.addClass(c));
        if (opts.text) d.textContent = opts.text;
        this.children.push(d);
        return d;
      },
      createSpan(opts = {}) {
        const s = makeEl('span', opts.attr || {});
        if (opts.cls) opts.cls.split(/\s+/).filter(Boolean).forEach(c => s.addClass(c));
        if (opts.text) s.textContent = opts.text;
        this.children.push(s);
        return s;
      },
      createEl(t, opts = {}) {
        const c = makeEl(t, opts.attr || {});
        if (opts.cls) opts.cls.split(/\s+/).filter(Boolean).forEach(x => c.addClass(x));
        if (opts.text) c.textContent = opts.text;
        this.children.push(c);
        return c;
      },
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      matches(sel) { return sel === '.internal-embed[src]' && classes.has('internal-embed') && 'src' in this.attributes; },
      querySelectorAll(sel) {
        const out = [];
        const walk = node => {
          for (const ch of node.children) {
            if (ch.matches?.(sel)) out.push(ch);
            walk(ch);
          }
        };
        walk(this);
        return out;
      },
      addEventListener(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(fn);
      },
      dispatch(ev, payload = { preventDefault() {}, stopPropagation() {} }) {
        for (const fn of listeners.get(ev) ?? []) fn(payload);
      },
    };
    return el;
  };

  let createdCanvases = [];
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') {
        const c = {
          width: 0,
          height: 0,
          getContext: () => ({
            save() {}, restore() {}, setTransform() {}, translate() {}, scale() {},
            clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
            stroke() {}, fill() {}, arc() {}, rect() {}, clip() {}, setLineDash() {},
            fillText() {}, drawImage() {}, createPattern: () => null,
          }),
          toDataURL: () => 'data:image/png;base64,ZmFrZQ==',
          toBlob: cb => cb(null),
        };
        createdCanvases.push(c);
        return c;
      }
      return makeEl(tag);
    },
    createElementNS: () => makeEl('svg'),
  };

  const sampleBook = newBook('Study Guide', 'ruled', 'paged');
  sampleBook.pages[0].title = 'Intro';
  const infBook = newBook('Board', 'dots', 'infinite');
  infBook.bookmarks = [{ id: 'bm-1', title: 'Cluster A', x: 0, y: 0, zoom: 1 }];
  let readCount = 0;
  let openedJump = null;
  const vaultListeners = new Map();
  const mockFile = new TFile('Notes/Study.penbook', 1000);
  const infFile = new TFile('Notes/Board.penbook', 1000);
  const mdFile = new TFile('Notes/Other.md', 1000);

  const registeredExtensions = new Map();
  let unregistered = false;
  let postProcessor = null;
  let codeBlockHandler = null;
  const pluginCleanups = [];

  const mockPlugin = {
    app: {
      vault: {
        read: async file => {
          readCount++;
          return JSON.stringify(file === infFile ? infBook : sampleBook);
        },
        on: (ev, cb) => {
          if (!vaultListeners.has(ev)) vaultListeners.set(ev, new Set());
          vaultListeners.get(ev).add(cb);
          return { unload: () => vaultListeners.get(ev)?.delete(cb) };
        },
        getAbstractFileByPath: () => null,
      },
      metadataCache: {
        getFirstLinkpathDest: linkpath => {
          if (linkpath === 'Notes/Study.penbook' || linkpath === 'Study.penbook') return mockFile;
          if (linkpath === 'Notes/Board.penbook' || linkpath === 'Board.penbook') return infFile;
          if (linkpath === 'Other.md') return mdFile;
          return null;
        },
      },
      workspace: {
        getLeaf: () => ({
          openFile: async () => {},
          view: {
            goToId: id => { openedJump = { kind: 'paged', id }; },
            goToBookmarkId: id => { openedJump = { kind: 'infinite', id }; },
          },
        }),
      },
      embedRegistry: {
        registerExtension: (ext, creator) => {
          registeredExtensions.set(ext, creator);
          return () => { unregistered = true; registeredExtensions.delete(ext); };
        },
      },
    },
    asset: p => `app://local/${p}`,
    registerMarkdownPostProcessor: fn => { postProcessor = fn; return fn; },
    registerMarkdownCodeBlockProcessor: (lang, fn) => { if (lang === 'penbook') codeBlockHandler = fn; return fn; },
    registerEvent: () => {},
    register: cb => pluginCleanups.push(cb),
  };

  const manager = new PenbookEmbedManager(mockPlugin);
  manager.register(mockPlugin);
  assert.ok(postProcessor);
  assert.ok(codeBlockHandler);
  assert.ok(registeredExtensions.has('penbook'));

  // Render embed twice at same mtime -> 1 vault.read (cache hit on second call)
  const container1 = makeEl('div');
  await manager.renderEmbedInto(container1, mockFile, '1', 'note.md');
  assert.equal(readCount, 1);
  assert.equal(manager.cacheSize, 1);
  assert.equal(createdCanvases[0].width, 1);
  assert.equal(createdCanvases[0].height, 1);

  const card = container1.children[0];
  assert.ok(card.classList.contains('pb-embed-card'));
  const img = card.children[1].children[0];
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.attributes.src, 'data:image/png;base64,ZmFrZQ==');
  const titleSpan = card.children[0].children[0].children[1];
  assert.equal(titleSpan.textContent, 'Study Guide · Intro');

  // Click card triggers goToId
  card.dispatch('click');
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(openedJump, { kind: 'paged', id: sampleBook.pages[0].id });

  const container2 = makeEl('div');
  await manager.renderEmbedInto(container2, mockFile, '1', 'note.md');
  assert.equal(readCount, 1);

  // Update mtime -> cache miss + stale mtime pruned
  mockFile.stat.mtime = 2000;
  await manager.renderEmbedInto(container2, mockFile, '1', 'note.md');
  assert.equal(readCount, 2);
  assert.equal(manager.cacheSize, 1);

  // Infinite bookmark embed -> goToBookmarkId
  const infContainer = makeEl('div');
  await manager.renderEmbedInto(infContainer, infFile, 'bm-1', 'note.md');
  assert.equal(readCount, 3);
  assert.equal(infContainer.children[0].children[0].children[0].children[1].textContent, 'Board · Cluster A');
  infContainer.children[0].dispatch('click');
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(openedJump, { kind: 'infinite', id: 'bm-1' });

  // Markdown post-processor mounts .internal-embed[src] for .penbook and ignores .md
  const root = makeEl('div');
  const pbEmbed = root.createSpan({ cls: 'internal-embed', attr: { src: 'Notes/Study.penbook#1' } });
  const mdEmbed = root.createSpan({ cls: 'internal-embed', attr: { src: 'Other.md' } });
  const postChildren = [];
  postProcessor(root, { sourcePath: 'index.md', addChild: ch => { postChildren.push(ch); ch.load(); } });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(postChildren.length, 1);
  assert.ok(pbEmbed.classList.contains('pb-embed-host'));
  assert.ok(!mdEmbed.classList.contains('pb-embed-host'));
  postChildren[0].unload();

  // Code block processor mounts live embed child and reports missing files cleanly
  const cbHost = makeEl('div');
  const cbChildren = [];
  codeBlockHandler('Notes/Study.penbook#1', cbHost, { sourcePath: 'index.md', addChild: ch => { cbChildren.push(ch); ch.load(); } });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(cbChildren.length, 1);
  assert.ok(cbHost.children[0].classList.contains('pb-embed-card'));
  cbChildren[0].unload();

  const missingHost = makeEl('div');
  codeBlockHandler('missing.penbook', missingHost, { sourcePath: 'index.md', addChild: () => {} });
  assert.ok(missingHost.children[0].classList.contains('pb-embed-error'));

  // Test embedRegistry creator & modify auto-refresh
  const creator = registeredExtensions.get('penbook');
  const embedHost = makeEl('div');
  const embedChild = creator({ containerEl: embedHost, sourcePath: 'Canvas.canvas' }, mockFile, '1');
  embedChild.load();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(manager.mountedCount(mockFile.path), 1);
  assert.equal(readCount, 3); // served from mtime=2000 cache

  mockFile.stat.mtime = 3000;
  for (const cb of vaultListeners.get('modify') ?? []) cb(mockFile);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(readCount, 4);

  // Bounded LRU eviction at maxEntries = 32
  for (let i = 0; i < 36; i++) {
    const f = new TFile(`Notes/Extra-${i}.penbook`, 100);
    await manager.renderEmbedInto(makeEl('div'), f, '1', 'note.md');
  }
  assert.equal(manager.cacheSize, 32);

  // Unload cleans cache, unregisters extension, disposes mounted children
  await manager.unload();
  assert.equal(manager.cacheSize, 0);
  assert.equal(manager.mountedCount(), 0);
  assert.equal(unregistered, true);
}

console.log(JSON.stringify({ c1TestsPassed: true }));
