import { Notebook, Paper, isInfiniteBook, parseBook } from './model';

export interface LibraryEntry {
  path: string;
  mtime: number;
  size: number;
  title: string;
  isInfinite: boolean;
  cover: string;
  coverStyle?: string;
  spineColor?: string;
  hasCover?: boolean;
  pageCount: number;
  bookmarkCount: number;
  firstPagePaper: Paper;
  firstPageColor: string;
  firstPageSpacing: number;
  searchText: string;
}

export interface LibraryFileRef {
  path: string;
  stat: { mtime: number; size: number };
}

interface SerializedLibraryIndex {
  version: 1;
  entries: LibraryEntry[];
}

const CACHE_VERSION = 1;

/** Extract lightweight metadata and lowercase search text from a parsed notebook without retaining resources. */
export function buildLibraryEntry(path: string, mtime: number, size: number, book: Notebook): LibraryEntry {
  const parts: string[] = [];
  const push = (value?: string) => {
    if (value) parts.push(value);
  };

  push(book.title);
  for (const tag of book.tags ?? []) push(tag);
  for (const bm of book.bookmarks ?? []) push(bm.title);

  for (const page of book.pages) {
    push(page.title);
    for (const tag of page.tags ?? []) push(tag);
    push(page.pdfText);
    push(page.ocr);
    for (const item of page.items ?? []) {
      push(item.text);
      if (item.cells) {
        for (const row of item.cells) {
          for (const cell of row) push(cell);
        }
      }
    }
  }

  const firstPage = book.pages[0];
  const entry: LibraryEntry = {
    path,
    mtime,
    size,
    title: book.title,
    isInfinite: isInfiniteBook(book),
    cover: book.cover,
    pageCount: book.pages.length,
    bookmarkCount: book.bookmarks?.length ?? 0,
    firstPagePaper: firstPage?.paper ?? 'ruled',
    firstPageColor: firstPage?.color ?? '#ffffff',
    firstPageSpacing: firstPage?.spacing ?? 28,
    searchText: parts.join(' ').toLowerCase(),
  };

  if (book.coverStyle !== undefined) entry.coverStyle = book.coverStyle;
  if (book.spineColor !== undefined) entry.spineColor = book.spineColor;
  if (book.hasCover !== undefined) entry.hasCover = book.hasCover;
  return entry;
}

function sanitizeEntry(raw: unknown): LibraryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.path !== 'string' || !r.path ||
    typeof r.mtime !== 'number' || !Number.isFinite(r.mtime) ||
    typeof r.size !== 'number' || !Number.isFinite(r.size) ||
    typeof r.title !== 'string' ||
    typeof r.isInfinite !== 'boolean' ||
    typeof r.cover !== 'string' ||
    typeof r.pageCount !== 'number' || !Number.isFinite(r.pageCount) ||
    typeof r.bookmarkCount !== 'number' || !Number.isFinite(r.bookmarkCount) ||
    typeof r.firstPagePaper !== 'string' ||
    typeof r.firstPageColor !== 'string' ||
    typeof r.firstPageSpacing !== 'number' || !Number.isFinite(r.firstPageSpacing) ||
    typeof r.searchText !== 'string'
  ) {
    return null;
  }
  if (r.coverStyle !== undefined && typeof r.coverStyle !== 'string') return null;
  if (r.spineColor !== undefined && typeof r.spineColor !== 'string') return null;
  if (r.hasCover !== undefined && typeof r.hasCover !== 'boolean') return null;

  const entry: LibraryEntry = {
    path: r.path,
    mtime: r.mtime,
    size: r.size,
    title: r.title,
    isInfinite: r.isInfinite,
    cover: r.cover,
    pageCount: r.pageCount,
    bookmarkCount: r.bookmarkCount,
    firstPagePaper: r.firstPagePaper as Paper,
    firstPageColor: r.firstPageColor,
    firstPageSpacing: r.firstPageSpacing,
    searchText: r.searchText,
  };
  if (r.coverStyle !== undefined) entry.coverStyle = r.coverStyle;
  if (r.spineColor !== undefined) entry.spineColor = r.spineColor;
  if (r.hasCover !== undefined) entry.hasCover = r.hasCover;
  return entry;
}

/** Incremental mtime/size-keyed metadata index for `.penbook` files in the vault. */
export class LibraryIndex {
  private entries = new Map<string, LibraryEntry>();
  private _dirty = false;

  get dirty(): boolean {
    return this._dirty;
  }

  get size(): number {
    return this.entries.size;
  }

  get(path: string): LibraryEntry | undefined {
    return this.entries.get(path);
  }

  clear(): void {
    this.entries.clear();
    this._dirty = false;
  }

  async load(readCache: () => Promise<string | null | undefined>): Promise<void> {
    try {
      const raw = await readCache();
      if (!raw) return;
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (!parsed || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
        return;
      }
      this.entries.clear();
      for (const item of parsed.entries) {
        const clean = sanitizeEntry(item);
        if (clean) this.entries.set(clean.path, clean);
      }
      this._dirty = false;
    } catch {
      // Ignore missing or corrupted cache and continue with empty/in-memory state.
    }
  }

  async save(writeCache: (data: string) => Promise<void>): Promise<void> {
    const payload: SerializedLibraryIndex = {
      version: CACHE_VERSION,
      entries: Array.from(this.entries.values()),
    };
    await writeCache(JSON.stringify(payload));
    this._dirty = false;
  }

  async getEntries<T extends LibraryFileRef>(
    files: readonly T[],
    readFile: (file: T) => Promise<string>,
  ): Promise<LibraryEntry[]> {
    const livePaths = new Set(files.map(f => f.path));
    for (const key of this.entries.keys()) {
      if (!livePaths.has(key)) {
        this.entries.delete(key);
        this._dirty = true;
      }
    }

    const result: LibraryEntry[] = [];
    for (const file of files) {
      const cached = this.entries.get(file.path);
      if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
        result.push(cached);
        continue;
      }
      try {
        const raw = await readFile(file);
        const book = parseBook(raw);
        const entry = buildLibraryEntry(file.path, file.stat.mtime, file.stat.size, book);
        this.entries.set(file.path, entry);
        this._dirty = true;
        result.push(entry);
      } catch {
        // Invalid files remain skipped without crashing the library modal.
        if (this.entries.delete(file.path)) this._dirty = true;
      }
    }
    return result;
  }

  invalidate(path: string): void {
    if (this.entries.delete(path)) this._dirty = true;
  }

  rename(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const existing = this.entries.get(oldPath);
    if (this.entries.delete(oldPath)) this._dirty = true;
    if (existing) {
      this.entries.set(newPath, { ...existing, path: newPath });
      this._dirty = true;
    } else if (this.entries.delete(newPath)) {
      this._dirty = true;
    }
  }
}
