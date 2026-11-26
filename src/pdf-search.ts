import { Item, Notebook, Page } from './model';
import type { PDFs } from './pdf';
import { itemAABB } from './infinite';

export type PdfSearchRect = { x: number; y: number; w: number; h: number };

export type PdfSearchMatch = {
  pageIndex: number;
  pageId: string;
  itemId?: string;
  rects: PdfSearchRect[];
  snippet: string;
  text: string;
};

export type TextRun = { str: string; x: number; y: number; w: number; h: number };

export interface PdfSearchViewport {
  width: number;
  height: number;
  transform: number[];
}

export interface PdfSearchControllerOptions {
  getStage?: () => HTMLElement | undefined;
  stage?: HTMLElement;
  getBook: () => Notebook;
  getPdfs: () => PDFs;
  onChange?: (matches: readonly PdfSearchMatch[], activeIndex: number) => void;
  onNavigate?: (match: PdfSearchMatch, activeIndex: number) => void;
  onClose?: () => void;
}

const DEFAULT_CROP = { x: 0, y: 0, w: 1, h: 1 };
const SEARCHABLE_ITEM_KINDS = new Set<Item['kind']>(['text', 'sticky', 'link', 'shape', 'table']);

function buildSnippet(text: string, start: number, end: number, contextChars = 28): string {
  const s = Math.max(0, start - contextChars);
  const e = Math.min(text.length, end + contextChars);
  const raw = text.slice(s, e).replace(/\s+/g, ' ').trim();
  return `${s > 0 ? '…' : ''}${raw}${e < text.length ? '…' : ''}`;
}

function findOffsets(haystack: string, query: string, caseSensitive: boolean): Array<[number, number]> {
  if (!query || !query.trim()) return [];
  const source = caseSensitive ? haystack : haystack.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle) return [];
  const hits: Array<[number, number]> = [];
  let from = 0;
  while (from <= source.length - needle.length) {
    const idx = source.indexOf(needle, from);
    if (idx < 0) break;
    hits.push([idx, idx + needle.length]);
    from = idx + Math.max(1, needle.length);
  }
  return hits;
}

/**
 * Extracts PDF.js text items into page-space bounding rects `[0..page.width, 0..page.height]`,
 * accounting for viewport transform (rotation), page backgroundCrop, and rotated/vertical runs.
 */
export function extractPageTextRuns(
  textItems: readonly any[],
  vp: PdfSearchViewport,
  page: Pick<Page, 'width' | 'height' | 'backgroundCrop'>,
): TextRun[] {
  const m = vp.transform;
  if (!Array.isArray(m) || m.length < 6 || vp.width <= 0 || vp.height <= 0) return [];
  const crop = page.backgroundCrop ?? DEFAULT_CROP;
  if (crop.w <= 0 || crop.h <= 0) return [];
  const scaleX = page.width / (vp.width * crop.w);
  const scaleY = page.height / (vp.height * crop.h);
  const runs: TextRun[] = [];

  for (const t of textItems) {
    if (!t || typeof t !== 'object' || typeof t.str !== 'string' || !t.str.length) continue;
    const a: number[] = Array.isArray(t.transform) && t.transform.length >= 6 ? t.transform : [1, 0, 0, 1, 0, 0];
    const len01 = Math.hypot(a[0], a[1]);
    const len23 = Math.hypot(a[2], a[3]);
    const rawHeight = Number.isFinite(t.height) && t.height > 0 ? Number(t.height) : 0;
    const rawWidth = Number.isFinite(t.width) && t.width > 0 ? Number(t.width) : 0;

    // Vertical text direction ('ttb') without rotated matrix uses height as advance and width as glyph thickness.
    const isTtb = t.dir === 'ttb' && Math.abs(a[1]) < 1e-6 && Math.abs(a[2]) < 1e-6 && rawHeight > rawWidth;
    let ux: number, uy: number, vx: number, vy: number, adv: number, asc: number;
    if (isTtb) {
      ux = 0;
      uy = -1;
      vx = 1;
      vy = 0;
      adv = rawHeight;
      asc = rawWidth || len01 || 12;
    } else {
      ux = len01 > 1e-6 ? a[0] / len01 : 1;
      uy = len01 > 1e-6 ? a[1] / len01 : 0;
      if (len23 > 1e-6) {
        vx = a[2] / len23;
        vy = a[3] / len23;
      } else {
        vx = -uy;
        vy = ux;
      }
      asc = len23 > 1e-6 ? len23 : (rawHeight || (len01 > 1e-6 ? len01 : 12));
      adv = rawWidth > 0 ? rawWidth : (t.str.trim() ? Math.max(len01, asc * t.str.length * 0.5) : 0);
    }

    const ox = a[4];
    const oy = a[5];
    const corners: [number, number][] = [
      [ox, oy],
      [ox + ux * adv, oy + uy * adv],
      [ox + ux * adv + vx * asc, oy + uy * adv + vy * asc],
      [ox + vx * asc, oy + vy * asc],
    ];

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of corners) {
      const vxPt = m[0] * px + m[2] * py + m[4];
      const vyPt = m[1] * px + m[3] * py + m[5];
      if (vxPt < minX) minX = vxPt;
      if (vyPt < minY) minY = vyPt;
      if (vxPt > maxX) maxX = vxPt;
      if (vyPt > maxY) maxY = vyPt;
    }

    const x = (minX - crop.x * vp.width) * scaleX;
    const y = (minY - crop.y * vp.height) * scaleY;
    const w = (maxX - minX) * scaleX;
    const h = (maxY - minY) * scaleY;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (page.backgroundCrop && (x + w <= 0 || x >= page.width || y + h <= 0 || y >= page.height)) continue;
    runs.push({ str: t.str, x, y, w, h });
  }
  return runs;
}

function needsVirtualSpace(prev: TextRun, curr: TextRun): boolean {
  if (!prev.str || !curr.str) return false;
  if (/\s$/.test(prev.str) || /^\s/.test(curr.str)) return false;
  const lineTol = Math.max(prev.h, curr.h) * 0.5;
  const prevCenterY = prev.y + prev.h / 2;
  const currCenterY = curr.y + curr.h / 2;
  if (Math.abs(currCenterY - prevCenterY) > lineTol) return true;
  const gap = curr.x - (prev.x + prev.w);
  const spaceThreshold = Math.max(1.5, Math.min(prev.h, curr.h) * 0.18);
  return gap > spaceThreshold;
}

/**
 * Finds query matches across joined TextRuns (including cross-run phrases) and maps
 * matched character offsets back to proportional sub-rects in each involved run.
 */
export function findMatchesInRuns(
  runs: readonly TextRun[],
  query: string,
  pageIndex: number,
  pageId: string,
  caseSensitive = false,
): PdfSearchMatch[] {
  if (!runs.length || !query || !query.trim()) return [];
  const segments: Array<{ run: TextRun; start: number; end: number }> = [];
  let fullText = '';
  let prev: TextRun | undefined;

  for (const run of runs) {
    if (!run.str) continue;
    if (prev && needsVirtualSpace(prev, run)) {
      fullText += ' ';
    }
    const start = fullText.length;
    fullText += run.str;
    const end = fullText.length;
    segments.push({ run, start, end });
    prev = run;
  }

  const hits = findOffsets(fullText, query, caseSensitive);
  if (!hits.length) return [];

  const matches: PdfSearchMatch[] = [];
  for (const [mStart, mEnd] of hits) {
    const rects: PdfSearchRect[] = [];
    for (const seg of segments) {
      if (seg.end <= mStart || seg.start >= mEnd) continue;
      const localStart = Math.max(0, mStart - seg.start);
      const localEnd = Math.min(seg.run.str.length, mEnd - seg.start);
      if (localEnd <= localStart) continue;
      const len = seg.run.str.length;
      const f0 = localStart / len;
      const f1 = localEnd / len;
      if (seg.run.w > 0 && seg.run.h > 0) {
        rects.push({
          x: seg.run.x + seg.run.w * f0,
          y: seg.run.y,
          w: Math.max(0.5, seg.run.w * (f1 - f0)),
          h: seg.run.h,
        });
      }
    }
    if (!rects.length) continue;
    matches.push({
      pageIndex,
      pageId,
      rects,
      snippet: buildSnippet(fullText, mStart, mEnd),
      text: fullText.slice(mStart, mEnd),
    });
  }
  return matches;
}

/**
 * Searches text-bearing notebook items (`text`, `sticky`, `link`, `shape`, `table`)
 * across both paged and infinite canvas notebooks, returning `itemAABB` rects and `itemId`.
 */
export function findItemTextMatches(
  items: readonly Item[],
  query: string,
  pageIndex: number,
  pageId: string,
  caseSensitive = false,
): PdfSearchMatch[] {
  if (!items.length || !query || !query.trim()) return [];
  const matches: PdfSearchMatch[] = [];

  for (const o of items) {
    if (!SEARCHABLE_ITEM_KINDS.has(o.kind)) continue;
    const box = itemAABB(o, 0);
    if (o.kind === 'table') {
      for (const row of o.cells ?? []) {
        for (const cell of row) {
          if (!cell) continue;
          for (const [s, e] of findOffsets(cell, query, caseSensitive)) {
            matches.push({
              pageIndex,
              pageId,
              itemId: o.id,
              rects: [box],
              snippet: buildSnippet(cell, s, e),
              text: cell.slice(s, e),
            });
          }
        }
      }
      continue;
    }

    const content = o.kind === 'link'
      ? [o.text, o.target].filter((v): v is string => Boolean(v && v.trim())).join(' ')
      : (o.text ?? '');
    if (!content) continue;
    for (const [s, e] of findOffsets(content, query, caseSensitive)) {
      matches.push({
        pageIndex,
        pageId,
        itemId: o.id,
        rects: [box],
        snippet: buildSnippet(content, s, e),
        text: content.slice(s, e),
      });
    }
  }
  return matches;
}

/**
 * Renders search match highlights onto `ctx` in world/page coordinate space for `pageId`.
 */
export function drawSearchHighlights(
  ctx: CanvasRenderingContext2D,
  matches: readonly PdfSearchMatch[],
  activeIndex: number,
  pageId: string,
  zoom: number,
): void {
  if (!matches.length) return;
  const safeZoom = Math.max(0.1, Number.isFinite(zoom) ? zoom : 1);
  ctx.save();

  const drawRects = (m: PdfSearchMatch, active: boolean) => {
    ctx.fillStyle = active ? 'rgba(249, 115, 22, 0.52)' : 'rgba(250, 204, 21, 0.38)';
    if (active) {
      ctx.strokeStyle = 'rgba(234, 88, 12, 0.95)';
      ctx.lineWidth = 1.5 / safeZoom;
    }
    for (const r of m.rects) {
      if (r.w <= 0 || r.h <= 0) continue;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      if (active) ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
  };

  for (let i = 0; i < matches.length; i++) {
    if (i === activeIndex || matches[i].pageId !== pageId) continue;
    drawRects(matches[i], false);
  }
  const active = activeIndex >= 0 && activeIndex < matches.length ? matches[activeIndex] : undefined;
  if (active && active.pageId === pageId) {
    drawRects(active, true);
  }
  ctx.restore();
}

function pageRunCacheKey(page: Page): string {
  return JSON.stringify([
    page.id,
    page.width,
    page.height,
    page.background?.resource ?? '',
    page.background?.page ?? 0,
    page.backgroundRotation ?? 0,
    page.backgroundCrop ?? null,
  ]);
}

/**
 * Manages cached PDF text extraction, incremental async search across `book.pages`,
 * cancellation via `AbortController`, and the floating `.pb-search-bar` UI inside `.pb-stage`.
 */
export class PdfSearchController {
  private runCache = new Map<string, TextRun[]>();
  private matches: PdfSearchMatch[] = [];
  private activeIndex = -1;
  private query = '';
  private caseSensitive = false;
  private opened = false;
  private destroyed = false;
  private searchEpoch = 0;
  private abortController?: AbortController;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private userNavigated = false;

  private bar?: HTMLElement;
  private input?: HTMLInputElement;
  private countEl?: HTMLElement;
  private caseBtn?: HTMLButtonElement;
  private prevBtn?: HTMLButtonElement;
  private nextBtn?: HTMLButtonElement;

  constructor(private options: PdfSearchControllerOptions) {}

  isOpen(): boolean {
    return this.opened;
  }

  getMatches(): readonly PdfSearchMatch[] {
    return this.matches;
  }

  getActiveIndex(): number {
    return this.activeIndex;
  }

  getActiveMatch(): PdfSearchMatch | undefined {
    return this.activeIndex >= 0 && this.activeIndex < this.matches.length
      ? this.matches[this.activeIndex]
      : undefined;
  }

  getQuery(): string {
    return this.query;
  }

  isCaseSensitive(): boolean {
    return this.caseSensitive;
  }

  setCaseSensitive(value: boolean): void {
    if (this.caseSensitive === value) return;
    this.caseSensitive = value;
    this.syncCaseButton();
    if (this.query.trim()) void this.search(this.query);
  }

  mount(stage?: HTMLElement): void {
    if (this.destroyed) return;
    const host = stage ?? this.options.getStage?.() ?? this.options.stage;
    if (!host) return;
    const bar = this.ensureBar();
    if (bar.parentElement !== host) {
      host.prepend(bar);
    }
    this.syncUi();
  }

  open(initialQuery?: string): void {
    if (this.destroyed) return;
    this.opened = true;
    this.mount();
    if (initialQuery !== undefined) {
      this.query = initialQuery;
      if (this.input) this.input.value = initialQuery;
    }
    this.syncUi();
    this.input?.focus({ preventScroll: true });
    this.input?.select();
    if (this.query.trim()) {
      void this.search(this.query);
    }
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.cancelPending();
    this.matches = [];
    this.activeIndex = -1;
    this.syncUi();
    this.options.onChange?.(this.matches, this.activeIndex);
    this.options.onClose?.();
  }

  clearCache(pageId?: string): void {
    if (!pageId) {
      this.runCache.clear();
      return;
    }
    const prefix = JSON.stringify([pageId]).slice(0, -1) + ',';
    for (const key of this.runCache.keys()) {
      if (key.startsWith(prefix)) this.runCache.delete(key);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.opened = false;
    this.cancelPending();
    this.runCache.clear();
    this.matches = [];
    this.activeIndex = -1;
    this.bar?.remove();
    this.bar = undefined;
    this.input = undefined;
    this.countEl = undefined;
    this.caseBtn = undefined;
    this.prevBtn = undefined;
    this.nextBtn = undefined;
  }

  next(): PdfSearchMatch | undefined {
    if (!this.matches.length) return undefined;
    this.userNavigated = true;
    this.activeIndex = (this.activeIndex + 1) % this.matches.length;
    this.syncCounter();
    const match = this.matches[this.activeIndex];
    this.options.onChange?.(this.matches, this.activeIndex);
    this.options.onNavigate?.(match, this.activeIndex);
    return match;
  }

  prev(): PdfSearchMatch | undefined {
    if (!this.matches.length) return undefined;
    this.userNavigated = true;
    this.activeIndex = (this.activeIndex - 1 + this.matches.length) % this.matches.length;
    this.syncCounter();
    const match = this.matches[this.activeIndex];
    this.options.onChange?.(this.matches, this.activeIndex);
    this.options.onNavigate?.(match, this.activeIndex);
    return match;
  }

  async search(query = this.query): Promise<PdfSearchMatch[]> {
    if (this.destroyed) return [];
    this.query = query;
    if (this.input && this.input.value !== query) this.input.value = query;
    this.cancelPending();
    this.userNavigated = false;

    if (!query || !query.trim()) {
      this.matches = [];
      this.activeIndex = -1;
      this.syncCounter();
      this.options.onChange?.(this.matches, this.activeIndex);
      return [];
    }

    const epoch = ++this.searchEpoch;
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    const book = this.options.getBook();
    const pdfs = this.options.getPdfs();
    const caseSensitive = this.caseSensitive;

    this.matches = [];
    this.activeIndex = -1;
    this.syncCounter();
    this.options.onChange?.(this.matches, this.activeIndex);

    for (let i = 0; i < book.pages.length; i++) {
      if (signal.aborted || this.destroyed || epoch !== this.searchEpoch) return this.matches;
      const page = book.pages[i];
      const pageHits: PdfSearchMatch[] = [];

      const bg = page.background;
      if (bg && book.resources[bg.resource]?.type === 'pdf') {
        const cacheKey = pageRunCacheKey(page);
        let runs = this.runCache.get(cacheKey);
        if (!runs) {
          try {
            runs = await pdfs.withDocument(bg.resource, book, async pdf => {
              if (signal.aborted || this.destroyed || epoch !== this.searchEpoch) return [];
              const pdfPage = await pdf.getPage((bg.page ?? 0) + 1);
              try {
                if (signal.aborted || this.destroyed || epoch !== this.searchEpoch) return [];
                const vp = pdfPage.getViewport({
                  scale: 1,
                  rotation: (pdfPage.rotate + (page.backgroundRotation ?? 0)) % 360,
                });
                const content = await pdfPage.getTextContent();
                return extractPageTextRuns(content.items, vp, page);
              } finally {
                pdfPage.cleanup();
              }
            });
            if (!signal.aborted && !this.destroyed && epoch === this.searchEpoch) {
              this.runCache.set(cacheKey, runs);
            }
          } catch (error) {
            if (error instanceof Error && ['AbortError', 'RenderingCancelledException'].includes(error.name)) {
              return this.matches;
            }
            console.warn('Penbook PDF search failed on page', i, error);
            runs = [];
          }
        }
        if (signal.aborted || this.destroyed || epoch !== this.searchEpoch) return this.matches;
        if (runs.length) {
          pageHits.push(...findMatchesInRuns(runs, query, i, page.id, caseSensitive));
        }
      }

      pageHits.push(...findItemTextMatches(page.items, query, i, page.id, caseSensitive));

      if (pageHits.length) {
        const hadNone = this.activeIndex < 0;
        this.matches.push(...pageHits);
        if (hadNone && !this.userNavigated) {
          this.activeIndex = 0;
        }
        this.syncCounter();
        this.options.onChange?.(this.matches, this.activeIndex);
        if (hadNone && this.activeIndex === 0) {
          this.options.onNavigate?.(this.matches[0], 0);
        }
      }

      if (i % 8 === 7) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }

    if (!signal.aborted && !this.destroyed && epoch === this.searchEpoch) {
      this.syncCounter();
      this.options.onChange?.(this.matches, this.activeIndex);
    }
    return this.matches;
  }

  private cancelPending(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private scheduleInputSearch(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.abortController?.abort();
    this.abortController = undefined;
    const value = this.input?.value ?? '';
    this.query = value;
    if (!value.trim()) {
      void this.search('');
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.search(this.query);
    }, 90);
  }

  private ensureBar(): HTMLElement {
    if (this.bar) return this.bar;
    const bar = document.createElement('div');
    bar.className = 'pb-search-bar';
    bar.setAttribute('role', 'search');
    bar.setAttribute('aria-label', '文档内搜索');

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'pb-search-input';
    input.placeholder = '搜索 PDF 与笔记文本…';
    input.setAttribute('aria-label', '搜索 PDF 与笔记文本');
    input.value = this.query;
    input.addEventListener('input', () => this.scheduleInputSearch());
    input.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) this.prev();
        else this.next();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        input.focus({ preventScroll: true });
        input.select();
      }
    });

    const countEl = document.createElement('span');
    countEl.className = 'pb-search-count';
    countEl.setAttribute('aria-live', 'polite');

    const caseBtn = document.createElement('button');
    caseBtn.type = 'button';
    caseBtn.className = 'pb-button pb-search-case';
    caseBtn.textContent = 'Aa';
    caseBtn.title = '区分大小写';
    caseBtn.setAttribute('aria-label', '区分大小写');
    caseBtn.addEventListener('click', () => {
      this.setCaseSensitive(!this.caseSensitive);
      input.focus({ preventScroll: true });
    });

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'pb-button pb-search-prev';
    prevBtn.textContent = '↑';
    prevBtn.title = '上一个匹配 (Shift+Enter)';
    prevBtn.setAttribute('aria-label', '上一个匹配');
    prevBtn.addEventListener('click', () => this.prev());

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'pb-button pb-search-next';
    nextBtn.textContent = '↓';
    nextBtn.title = '下一个匹配 (Enter)';
    nextBtn.setAttribute('aria-label', '下一个匹配');
    nextBtn.addEventListener('click', () => this.next());

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pb-button pb-search-close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭搜索 (Escape)';
    closeBtn.setAttribute('aria-label', '关闭搜索');
    closeBtn.addEventListener('click', () => this.close());

    bar.addEventListener('pointerdown', e => e.stopPropagation());
    bar.append(input, countEl, caseBtn, prevBtn, nextBtn, closeBtn);

    this.bar = bar;
    this.input = input;
    this.countEl = countEl;
    this.caseBtn = caseBtn;
    this.prevBtn = prevBtn;
    this.nextBtn = nextBtn;
    return bar;
  }

  private syncCaseButton(): void {
    if (!this.caseBtn) return;
    this.caseBtn.classList.toggle('is-active', this.caseSensitive);
    this.caseBtn.setAttribute('aria-pressed', String(this.caseSensitive));
  }

  private syncCounter(): void {
    const total = this.matches.length;
    const current = total > 0 && this.activeIndex >= 0 ? this.activeIndex + 1 : 0;
    if (this.countEl) {
      this.countEl.textContent = `${current} / ${total}`;
    }
    if (this.prevBtn) this.prevBtn.disabled = total === 0;
    if (this.nextBtn) this.nextBtn.disabled = total === 0;
  }

  private syncUi(): void {
    if (this.bar) {
      this.bar.hidden = !this.opened;
      this.bar.classList.toggle('is-open', this.opened);
    }
    this.syncCaseButton();
    this.syncCounter();
  }
}
