import {
  App,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Plugin,
  TFile,
  normalizePath,
  parseLinktext,
} from 'obsidian';
import { Notebook, Page, ViewportBookmark, isInfiniteBook, parseBook } from './model';
import { Rect, clampInfiniteZoom, contentBounds, renderInfiniteExportCanvas } from './infinite';
import { PDFs } from './pdf';
import { Renderer } from './render';
import { icon } from './icons';

export type EmbedTarget =
  | { mode: 'paged'; page: Page; pageIndex: number }
  | { mode: 'infinite'; page: Page; bookmark?: ViewportBookmark; region: Rect };

export interface EmbedCacheEntry {
  mtime: number;
  dataUrl: string;
  width: number;
  height: number;
  label: string;
  targetId?: string;
  isInfinite: boolean;
}

export interface EmbedPluginHost {
  app: App;
  asset: (path: string) => string;
  registerMarkdownPostProcessor: Plugin['registerMarkdownPostProcessor'];
  registerMarkdownCodeBlockProcessor: Plugin['registerMarkdownCodeBlockProcessor'];
  registerEvent: Plugin['registerEvent'];
  register: Plugin['register'];
}

const DEFAULT_INFINITE_REGION: Rect = { x: -400, y: -300, w: 800, h: 600 };
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_DIM = 1800;

function cleanSubpath(subpath?: string): string {
  return (subpath ?? '').trim().replace(/^#/, '').trim();
}

export function resolveEmbedTarget(book: Notebook, subpath?: string): EmbedTarget {
  const needle = cleanSubpath(subpath);
  if (isInfiniteBook(book)) {
    const page = book.pages[0];
    const bookmarks = book.bookmarks ?? [];
    let bookmark: ViewportBookmark | undefined;
    if (needle) {
      const lower = needle.toLowerCase();
      bookmark =
        bookmarks.find(bm => bm.id === needle) ??
        bookmarks.find(bm => bm.title.trim() === needle) ??
        bookmarks.find(bm => bm.title.trim().toLowerCase() === lower);
    }
    if (bookmark) {
      const z = clampInfiniteZoom(bookmark.zoom);
      return {
        mode: 'infinite',
        page,
        bookmark,
        region: {
          x: bookmark.x - 420 / z,
          y: bookmark.y - 300 / z,
          w: 840 / z,
          h: 600 / z,
        },
      };
    }
    return {
      mode: 'infinite',
      page,
      region: contentBounds(page.items, 48) ?? { ...DEFAULT_INFINITE_REGION },
    };
  }

  if (needle) {
    const byId = book.pages.findIndex(p => p.id === needle);
    if (byId >= 0) return { mode: 'paged', page: book.pages[byId], pageIndex: byId };

    const numMatch = /^p?(\d+)$/i.exec(needle);
    if (numMatch) {
      const idx = Number.parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < book.pages.length) {
        return { mode: 'paged', page: book.pages[idx], pageIndex: idx };
      }
    }

    const byExactTitle = book.pages.findIndex(p => p.title.trim() === needle);
    if (byExactTitle >= 0) return { mode: 'paged', page: book.pages[byExactTitle], pageIndex: byExactTitle };

    const lower = needle.toLowerCase();
    const byTitle = book.pages.findIndex(p => p.title.trim().toLowerCase() === lower);
    if (byTitle >= 0) return { mode: 'paged', page: book.pages[byTitle], pageIndex: byTitle };
  }

  return { mode: 'paged', page: book.pages[0], pageIndex: 0 };
}

export function formatEmbedLink(filePath: string, targetId?: string): string {
  const cleanTarget = targetId?.trim().replace(/^#/, '');
  return `![[${filePath}${cleanTarget ? '#' + cleanTarget : ''}]]`;
}

async function canvasToPngDataUrl(
  canvas: HTMLCanvasElement,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const width = canvas.width;
  const height = canvas.height;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob(blob => {
          if (!blob) {
            try {
              resolve(canvas.toDataURL('image/png'));
            } catch (error) {
              reject(error);
            }
            return;
          }
          if (typeof FileReader === 'function') {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error ?? new Error('无法读取预览图片'));
            reader.readAsDataURL(blob);
          } else {
            try {
              resolve(canvas.toDataURL('image/png'));
            } catch (error) {
              reject(error);
            }
          }
        }, 'image/png');
      } else {
        resolve(canvas.toDataURL('image/png'));
      }
    });
    return { dataUrl, width, height };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

class PenbookEmbedChild extends MarkdownRenderChild {
  private trackedPath: string;

  constructor(
    private manager: PenbookEmbedManager,
    containerEl: HTMLElement,
    private file: TFile,
    private subpath: string,
    private sourcePath: string,
  ) {
    super(containerEl);
    this.trackedPath = file.path;
  }

  onload(): void {
    this.manager.trackChild(this, this.trackedPath);
    const app = this.manager.hostApp;
    if (app) {
      this.registerEvent(
        app.vault.on('modify', changed => {
          if (changed === this.file || changed.path === this.file.path) {
            void this.refresh();
          }
        }),
      );
      this.registerEvent(
        app.vault.on('rename', (changed, oldPath) => {
          if (changed === this.file || oldPath === this.trackedPath) {
            this.manager.retrackChild(this, oldPath, this.file.path);
            this.trackedPath = this.file.path;
          }
        }),
      );
    }
    void this.refresh();
  }

  loadFile(): Promise<void> {
    return this.refresh();
  }

  refresh(): Promise<void> {
    return this.manager.renderEmbedInto(this.containerEl, this.file, this.subpath, this.sourcePath);
  }

  onunload(): void {
    this.manager.untrackChild(this, this.trackedPath);
  }
}

interface CacheRecord {
  entry: EmbedCacheEntry;
  bytes: number;
  path: string;
}

export class PenbookEmbedManager {
  private renderer = new Renderer();
  private pdfs?: PDFs;
  private plugin?: EmbedPluginHost;
  private cache = new Map<string, CacheRecord>();
  private cacheBytes = 0;
  private inFlight = new Map<string, Promise<EmbedCacheEntry>>();
  private mountedByPath = new Map<string, Set<PenbookEmbedChild>>();
  private activeChildren = new Set<PenbookEmbedChild>();
  private containerEpochs = new WeakMap<HTMLElement, number>();
  private unregisterEmbed?: () => void;
  private registered = false;
  private disposed = false;

  constructor(plugin?: EmbedPluginHost) {
    if (plugin) {
      this.plugin = plugin;
      this.pdfs = new PDFs(p => plugin.asset(p));
    }
  }

  get hostApp(): App | undefined {
    return this.plugin?.app;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  mountedCount(filePath?: string): number {
    if (filePath !== undefined) return this.mountedByPath.get(filePath)?.size ?? 0;
    return this.activeChildren.size;
  }

  trackChild(child: PenbookEmbedChild, filePath: string): void {
    this.activeChildren.add(child);
    let set = this.mountedByPath.get(filePath);
    if (!set) {
      set = new Set();
      this.mountedByPath.set(filePath, set);
    }
    set.add(child);
  }

  retrackChild(child: PenbookEmbedChild, oldPath: string, newPath: string): void {
    const oldSet = this.mountedByPath.get(oldPath);
    if (oldSet) {
      oldSet.delete(child);
      if (!oldSet.size) this.mountedByPath.delete(oldPath);
    }
    if (this.activeChildren.has(child)) {
      let nextSet = this.mountedByPath.get(newPath);
      if (!nextSet) {
        nextSet = new Set();
        this.mountedByPath.set(newPath, nextSet);
      }
      nextSet.add(child);
    }
  }

  untrackChild(child: PenbookEmbedChild, filePath: string): void {
    this.activeChildren.delete(child);
    const set = this.mountedByPath.get(filePath);
    if (set) {
      set.delete(child);
      if (!set.size) this.mountedByPath.delete(filePath);
    }
  }

  register(plugin: EmbedPluginHost): void {
    this.disposed = false;
    this.plugin = plugin;
    if (!this.pdfs) this.pdfs = new PDFs(p => plugin.asset(p));
    if (this.registered) return;
    this.registered = true;

    plugin.registerMarkdownPostProcessor((el, ctx) => {
      this.processMarkdown(el, ctx);
    });

    plugin.registerMarkdownCodeBlockProcessor('penbook', (source, el, ctx) => {
      this.renderCodeBlock(source, el, ctx);
    });

    const registry = (plugin.app as unknown as {
      embedRegistry?: {
        registerExtension?: (ext: string, creator: unknown) => (() => void) | void;
        unregisterExtension?: (ext: string) => void;
        unregisterExtensions?: (exts: string[]) => void;
      };
    }).embedRegistry;

    if (registry?.registerExtension) {
      const creator = (
        context: { containerEl: HTMLElement; sourcePath?: string },
        file: TFile,
        subpath = '',
      ) => new PenbookEmbedChild(this, context.containerEl, file, subpath, context.sourcePath ?? '');
      const dispose = registry.registerExtension('penbook', creator);
      const unregister = () => {
        if (this.unregisterEmbed !== unregister) return;
        this.unregisterEmbed = undefined;
        if (typeof dispose === 'function') {
          dispose();
        } else if (typeof registry.unregisterExtensions === 'function') {
          registry.unregisterExtensions(['penbook']);
        } else if (typeof registry.unregisterExtension === 'function') {
          registry.unregisterExtension('penbook');
        }
      };
      this.unregisterEmbed = unregister;
      plugin.register(unregister);
    }

    plugin.register(() => {
      void this.unload();
    });
  }

  private processMarkdown(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const app = this.plugin?.app;
    if (!app || this.disposed) return;

    const embeds: HTMLElement[] = [];
    if (typeof el.matches === 'function' && el.matches('.internal-embed[src]')) {
      embeds.push(el);
    }
    if (typeof el.querySelectorAll === 'function') {
      el.querySelectorAll<HTMLElement>('.internal-embed[src]').forEach(node => {
        if (!embeds.includes(node)) embeds.push(node);
      });
    }

    for (const embedEl of embeds) {
      if (embedEl.classList?.contains('pb-embed-host')) continue;
      const rawSrc = embedEl.getAttribute('src')?.trim();
      if (!rawSrc) continue;
      const { path, subpath } = parseLinktext(rawSrc);
      const cleanPath = path.split('|')[0].trim();
      if (!cleanPath) continue;
      const dest = app.metadataCache.getFirstLinkpathDest(cleanPath, ctx.sourcePath);
      if (!(dest instanceof TFile) || dest.extension !== 'penbook') continue;
      const child = new PenbookEmbedChild(this, embedEl, dest, cleanSubpath(subpath), ctx.sourcePath);
      ctx.addChild(child);
    }
  }

  renderCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const app = this.plugin?.app;
    if (!app || this.disposed) return;

    const raw = source.trim().replace(/^!?\[\[/, '').replace(/\]\]$/, '').trim();
    const { path, subpath } = parseLinktext(raw);
    const cleanPath = path.split('|')[0].trim();
    const dest = cleanPath
      ? (app.metadataCache.getFirstLinkpathDest(cleanPath, ctx.sourcePath)
        ?? (() => {
          const abstract = app.vault.getAbstractFileByPath(normalizePath(cleanPath));
          return abstract instanceof TFile ? abstract : null;
        })())
      : null;

    if (!dest || dest.extension !== 'penbook') {
      el.empty();
      el.createDiv({ cls: 'pb-embed-error', text: '找不到 Penbook 笔记本' });
      return;
    }

    const child = new PenbookEmbedChild(this, el, dest, cleanSubpath(subpath), ctx.sourcePath);
    ctx.addChild(child);
  }

  async renderEmbedInto(
    container: HTMLElement,
    file: TFile,
    subpath: string,
    _sourcePath: string,
  ): Promise<void> {
    const app = this.plugin?.app;
    if (!app || this.disposed) return;

    const epoch = (this.containerEpochs.get(container) ?? 0) + 1;
    this.containerEpochs.set(container, epoch);
    const normSubpath = cleanSubpath(subpath);
    const mtime = file.stat?.mtime ?? 0;
    const key = `${file.path}:${mtime}:${normSubpath}`;

    try {
      let entry = this.getCache(key);
      if (!entry) {
        let task = this.inFlight.get(key);
        if (!task) {
          task = this.renderCacheEntry(app, file, normSubpath, mtime)
            .then(rendered => {
              if (!this.disposed) this.setCache(key, file.path, rendered);
              return rendered;
            })
            .finally(() => {
              if (this.inFlight.get(key) === task) this.inFlight.delete(key);
            });
          this.inFlight.set(key, task);
        }
        entry = await task;
      }

      if (this.disposed || this.containerEpochs.get(container) !== epoch) return;
      this.renderCard(container, file, entry, app);
    } catch {
      if (this.disposed || this.containerEpochs.get(container) !== epoch) return;
      container.empty();
      container.addClass('pb-embed-host');
      const errCard = container.createDiv({ cls: 'pb-embed-card pb-embed-error' });
      errCard.createSpan({ text: `无法渲染 Penbook 预览：${file.basename}` });
    }
  }

  private renderCard(container: HTMLElement, file: TFile, entry: EmbedCacheEntry, app: App): void {
    container.empty();
    container.addClass('pb-embed-host');

    const card = container.createDiv({ cls: 'pb-embed-card' });
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `打开 ${entry.label}`);

    const header = card.createDiv({ cls: 'pb-embed-header' });
    const badge = header.createSpan({ cls: 'pb-embed-badge' });
    icon(badge, entry.isInfinite ? 'infinite' : 'notebook', 14);
    badge.createSpan({ cls: 'pb-embed-title', text: entry.label });

    const openBtn = header.createEl('button', {
      cls: 'pb-embed-open clickable-icon',
      attr: { type: 'button', 'aria-label': `打开 ${entry.label}` },
    });
    icon(openBtn, 'move', 14);

    const preview = card.createDiv({ cls: 'pb-embed-preview' });
    preview.createEl('img', {
      cls: 'pb-embed-img',
      attr: {
        src: entry.dataUrl,
        alt: entry.label,
        width: String(entry.width),
        height: String(entry.height),
      },
    });

    const openAndJump = async (newLeaf = false) => {
      const leaf = app.workspace.getLeaf(newLeaf);
      await leaf.openFile(file);
      const view = leaf.view as unknown as {
        goToId?: (id: string) => void;
        goToBookmarkId?: (id: string) => void;
      } | null;
      if (view && entry.targetId) {
        if (entry.isInfinite && typeof view.goToBookmarkId === 'function') {
          view.goToBookmarkId(entry.targetId);
        } else if (typeof view.goToId === 'function') {
          view.goToId(entry.targetId);
        }
      }
    };

    const handleClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void openAndJump(e.ctrlKey || e.metaKey || e.button === 1);
    };

    card.addEventListener('click', handleClick);
    openBtn.addEventListener('click', handleClick);
    card.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        void openAndJump(e.ctrlKey || e.metaKey);
      }
    });
  }

  private async renderCacheEntry(
    app: App,
    file: TFile,
    normSubpath: string,
    mtime: number,
  ): Promise<EmbedCacheEntry> {
    if (!this.pdfs) {
      const assetFn = this.plugin?.asset ? (p: string) => this.plugin!.asset(p) : (p: string) => p;
      this.pdfs = new PDFs(assetFn);
    }

    const raw = await app.vault.read(file);
    const book = parseBook(raw);
    const target = resolveEmbedTarget(book, normSubpath);

    const rw = target.mode === 'paged' ? target.page.width : Math.max(10, target.region.w);
    const rh = target.mode === 'paged' ? target.page.height : Math.max(10, target.region.h);
    const scale = Math.max(0.2, Math.min(1.5, MAX_PREVIEW_DIM / Math.max(rw, rh)));

    const canvas =
      target.mode === 'infinite'
        ? await renderInfiniteExportCanvas(target.page, book, this.renderer, target.region, scale, 'all')
        : await this.pdfs.canvas(target.page, book, this.renderer, scale, 'all');

    const { dataUrl, width, height } = await canvasToPngDataUrl(canvas);
    const isInfinite = target.mode === 'infinite';
    const subLabel = isInfinite
      ? (target.bookmark ? (target.bookmark.title.trim() || '视角书签') : '无界笔记')
      : (target.page.title.trim() || `第 ${target.pageIndex + 1} 页`);
    const label = `${book.title} · ${subLabel}`;
    const targetId = isInfinite ? target.bookmark?.id : target.page.id;

    return { mtime, dataUrl, width, height, label, targetId, isInfinite };
  }

  private getCache(key: string): EmbedCacheEntry | undefined {
    const rec = this.cache.get(key);
    if (!rec) return undefined;
    this.cache.delete(key);
    this.cache.set(key, rec);
    return rec.entry;
  }

  private setCache(key: string, filePath: string, entry: EmbedCacheEntry): void {
    for (const [k, rec] of this.cache) {
      if (rec.path === filePath && rec.entry.mtime !== entry.mtime) {
        this.cache.delete(k);
        this.cacheBytes -= rec.bytes;
      }
    }
    const existing = this.cache.get(key);
    if (existing) {
      this.cache.delete(key);
      this.cacheBytes -= existing.bytes;
    }
    const bytes = Math.max(1024, entry.dataUrl.length * 2);
    if (bytes > MAX_CACHE_BYTES) return;
    this.cache.set(key, { entry, bytes, path: filePath });
    this.cacheBytes += bytes;

    while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheBytes > MAX_CACHE_BYTES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      if (oldest) this.cacheBytes -= oldest.bytes;
    }
  }

  async unload(): Promise<void> {
    this.disposed = true;
    this.registered = false;
    this.inFlight.clear();
    this.cache.clear();
    this.cacheBytes = 0;
    for (const child of [...this.activeChildren]) {
      child.unload();
    }
    this.activeChildren.clear();
    this.mountedByPath.clear();
    this.unregisterEmbed?.();
    this.unregisterEmbed = undefined;
    this.renderer.clear();
    await this.pdfs?.clear();
  }
}
