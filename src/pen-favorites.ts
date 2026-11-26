import { Setting } from 'obsidian';
import { popover } from './dialogs';
import { PEN_ICONS, icon, pathIcon } from './icons';
import { Pen, StrokeStyle, clone, uid } from './model';
import { panelHeader, row, section } from './panels';

export interface PenFavorite {
  id: string;
  name: string;
  pen: Pen;
  color: string;
  width: number;
  style: StrokeStyle;
}

export interface PenFavoritesDockOptions {
  favorites: PenFavorite[];
  current: { tool: string; pen: Pen; color: string; width: number; style: StrokeStyle };
  onSelect: (fav: PenFavorite) => void;
  onSaveCurrent: () => void;
  onUpdate: (next: PenFavorite[]) => void;
  onOpenColor?: (current: string, apply: (c: string) => void) => void;
}

export const MAX_PEN_FAVORITES = 6;

export const DEFAULT_PEN_FAVORITES: PenFavorite[] = [
  { id: 'fav-black-fountain', name: '黑钢笔', pen: 'fountain', color: '#000000', width: 2.5, style: 'solid' },
  { id: 'fav-red-fountain', name: '红重点笔', pen: 'fountain', color: '#d93025', width: 2.5, style: 'solid' },
  { id: 'fav-blue-ballpoint', name: '蓝笔记笔', pen: 'ballpoint', color: '#1a73e8', width: 2.5, style: 'solid' },
  { id: 'fav-yellow-highlighter', name: '黄荧光笔', pen: 'highlighter', color: '#facc15', width: 14, style: 'solid' },
];

const VALID_PENS = new Set<Pen>(['ballpoint', 'fountain', 'brush', 'pencil', 'highlighter']);
const VALID_STYLES = new Set<StrokeStyle>(['solid', 'dashed', 'dotted']);
const PEN_LABELS: Record<Pen, string> = {
  fountain: '钢笔',
  ballpoint: '圆珠笔',
  brush: '画笔',
  pencil: '铅笔',
  highlighter: '荧光笔',
};

function normalizeColor(color: string): string {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  return c;
}

function sanitizeFavorite(raw: unknown): PenFavorite | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.pen !== 'string' || !VALID_PENS.has(obj.pen as Pen)) return null;
  if (typeof obj.color !== 'string' || !obj.color.trim()) return null;
  if (typeof obj.width !== 'number' || !Number.isFinite(obj.width) || obj.width <= 0) return null;

  const pen = obj.pen as Pen;
  const style: StrokeStyle = typeof obj.style === 'string' && VALID_STYLES.has(obj.style as StrokeStyle)
    ? (obj.style as StrokeStyle)
    : 'solid';
  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : uid();
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : PEN_LABELS[pen];
  const width = Math.round(Math.max(0.5, Math.min(50, obj.width)) * 100) / 100;

  return { id, name, pen, color: normalizeColor(obj.color), width, style };
}

function sanitizeEntries(list?: PenFavorite[]): PenFavorite[] {
  if (!Array.isArray(list)) return [];
  const result: PenFavorite[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const clean = sanitizeFavorite(entry);
    if (!clean) continue;
    let id = clean.id;
    while (seen.has(id)) id = uid();
    seen.add(id);
    result.push({ ...clean, id });
    if (result.length >= MAX_PEN_FAVORITES) break;
  }
  return result;
}

export function normalizePenFavorites(list?: PenFavorite[]): PenFavorite[] {
  const cleaned = sanitizeEntries(list);
  return cleaned.length ? cleaned : clone(DEFAULT_PEN_FAVORITES);
}

export function isFavoriteActive(
  fav: PenFavorite,
  current: { pen: Pen; color: string; width: number; style: StrokeStyle },
): boolean {
  return (
    fav.pen === current.pen
    && normalizeColor(fav.color) === normalizeColor(current.color)
    && Math.abs(fav.width - current.width) <= 0.05
    && fav.style === current.style
  );
}

export function upsertPenFavorite(list: PenFavorite[], fav: PenFavorite): PenFavorite[] {
  const cleanList = sanitizeEntries(list);
  const cleanFav = sanitizeFavorite(fav);
  if (!cleanFav) return cleanList;

  const index = cleanList.findIndex(item => item.id === cleanFav.id);
  if (index >= 0) {
    const next = cleanList.map((item, i) => (i === index ? cleanFav : { ...item }));
    return next;
  }
  if (cleanList.length >= MAX_PEN_FAVORITES) {
    return cleanList;
  }
  return [...cleanList, cleanFav];
}

export function removePenFavorite(list: PenFavorite[], id: string): PenFavorite[] {
  const cleanList = sanitizeEntries(list);
  const next = cleanList.filter(item => item.id !== id);
  // Keep at least one favorite slot in the dock so the user always has an active preset.
  if (!next.length && cleanList.length) return cleanList;
  return next;
}

function formatWidth(width: number): string {
  const rounded = Math.round(width * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function openFavoritePopover(
  anchor: HTMLElement,
  fav: PenFavorite,
  favorites: PenFavorite[],
  opts: PenFavoritesDockOptions,
): void {
  popover(anchor, (panel, close) => {
    panel.addClass('pb-fav-popover');
    panelHeader(panel, '编辑常用笔', close);

    let draftName = fav.name;
    let draftColor = fav.color;

    const infoGroup = section(panel);
    new Setting(infoGroup)
      .setName('名称')
      .addText(text => {
        text.setValue(draftName).onChange(value => {
          draftName = value;
        });
        text.inputEl.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const updated: PenFavorite = { ...fav, name: draftName.trim() || fav.name, color: draftColor };
            opts.onUpdate(upsertPenFavorite(favorites, updated));
            close();
          }
        });
      });

    if (opts.onOpenColor) {
      const colorSetting = new Setting(infoGroup).setName('颜色');
      colorSetting.addButton(b => {
        b.setButtonText(draftColor);
        b.buttonEl.style.borderLeft = `12px solid ${draftColor}`;
        b.onClick(() => {
          opts.onOpenColor?.(draftColor, nextColor => {
            draftColor = nextColor;
            b.setButtonText(nextColor);
            b.buttonEl.style.borderLeft = `12px solid ${nextColor}`;
          });
        });
      });
    }

    const actionsGroup = section(panel, '操作');
    row(actionsGroup, '用当前笔覆盖', () => {
      const updated: PenFavorite = {
        ...fav,
        name: draftName.trim() || fav.name,
        pen: opts.current.pen,
        color: opts.current.color,
        width: opts.current.width,
        style: opts.current.style,
      };
      opts.onUpdate(upsertPenFavorite(favorites, updated));
      close();
    });

    if (favorites.length > 1) {
      row(actionsGroup, '删除此常用笔', () => {
        opts.onUpdate(removePenFavorite(favorites, fav.id));
        close();
      }, '', undefined, true);
    }

    row(actionsGroup, '恢复默认预设', () => {
      opts.onUpdate(clone(DEFAULT_PEN_FAVORITES));
      close();
    });

    new Setting(panel)
      .addButton(b => b.setButtonText('取消').onClick(close))
      .addButton(b => b.setButtonText('保存').setCta().onClick(() => {
        const updated: PenFavorite = {
          ...fav,
          name: draftName.trim() || fav.name,
          color: draftColor,
        };
        opts.onUpdate(upsertPenFavorite(favorites, updated));
        close();
      }));
  });
}

export function renderPenFavoritesDock(container: HTMLElement, opts: PenFavoritesDockOptions): HTMLElement {
  const favorites = normalizePenFavorites(opts.favorites);
  const dock = container.createDiv('pb-fav-dock');
  dock.setAttribute('role', 'group');
  dock.setAttribute('aria-label', '常用笔');

  for (const fav of favorites) {
    const active = opts.current.tool === 'pen' && isFavoriteActive(fav, opts.current);
    const label = `${fav.name} · ${PEN_LABELS[fav.pen]} ${formatWidth(fav.width)}px`;
    const btn = dock.createEl('button', {
      cls: 'pb-button pb-fav-pill',
      attr: {
        title: `${label}（右键或长按编辑）`,
        'aria-label': label,
        'aria-pressed': String(active),
      },
    });
    btn.toggleClass('is-active', active);

    pathIcon(btn, PEN_ICONS[fav.pen] ?? PEN_ICONS.fountain, 16);
    const dot = btn.createSpan('pb-fav-dot');
    dot.style.background = fav.color;
    const widthEl = btn.createSpan({ cls: 'pb-fav-width', text: formatWidth(fav.width) });
    widthEl.dataset.style = fav.style;

    let holdTimer: number | undefined;
    let startX = 0;
    let startY = 0;
    let longPressed = false;

    const clearHold = () => {
      if (holdTimer !== undefined) {
        window.clearTimeout(holdTimer);
        holdTimer = undefined;
      }
    };

    btn.addEventListener('pointerdown', e => {
      if (e.button === 2) return;
      clearHold();
      longPressed = false;
      startX = e.clientX;
      startY = e.clientY;
      holdTimer = window.setTimeout(() => {
        holdTimer = undefined;
        longPressed = true;
        openFavoritePopover(btn, fav, favorites, opts);
      }, 500);
    });

    btn.addEventListener('pointermove', e => {
      if (holdTimer !== undefined && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) {
        clearHold();
      }
    });

    btn.addEventListener('pointerup', clearHold);
    btn.addEventListener('pointercancel', clearHold);

    btn.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      clearHold();
      openFavoritePopover(btn, fav, favorites, opts);
    });

    btn.addEventListener('click', e => {
      if (longPressed) {
        e.preventDefault();
        e.stopPropagation();
        longPressed = false;
        return;
      }
      opts.onSelect(fav);
    });
  }

  if (favorites.length < MAX_PEN_FAVORITES) {
    const addBtn = dock.createEl('button', {
      cls: 'pb-button pb-fav-add',
      attr: {
        title: '将当前笔设为常用',
        'aria-label': '将当前笔设为常用',
      },
    });
    icon(addBtn, 'plus', 16);
    addBtn.addEventListener('click', () => opts.onSaveCurrent());
  }

  return dock;
}
