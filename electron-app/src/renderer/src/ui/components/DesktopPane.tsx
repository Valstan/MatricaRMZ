import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DESKTOP_CELL_H,
  DESKTOP_CELL_W,
  desktopAddFolder,
  desktopDeleteFolder,
  desktopEmptyTrash,
  desktopFolderShortcuts,
  desktopLayoutGrid,
  desktopMoveToFolder,
  desktopMoveToFolderMany,
  desktopMoveToTrash,
  desktopMoveToTrashMany,
  desktopRenameFolder,
  desktopRenameShortcut,
  desktopRestoreFromTrash,
  desktopSetPositions,
  desktopSurfaceShortcuts,
  desktopTileMetrics,
  desktopTrashShortcuts,
  type DesktopPlacement,
  type DesktopShortcut,
  type DesktopTileMetrics,
  type UserUiProfileDesktop,
} from '@matricarmz/shared';

import { theme } from '../theme.js';
import { useConfirm } from './ConfirmContext.js';

// MIME-тип DnD внутри рабочего стола: сторонние перетаскивания (файлы из
// проводника, текст) им не прикидываются и молча игнорируются.
const DND_SHORTCUT = 'application/x-matrica-desktop-shortcut';

/** Отступ полотна от краёв зоны. Он же вычитается при подсчёте числа колонок. */
const PAD = 12;

type CtxMenu =
  | { kind: 'shortcut'; id: string; x: number; y: number; inTrash: boolean }
  | { kind: 'folder'; id: string; x: number; y: number }
  | { kind: 'trash'; x: number; y: number }
  | { kind: 'surface'; x: number; y: number };

type Lasso = { x0: number; y0: number; x1: number; y1: number };

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true;
}

/**
 * «Рабочий стол» — правая зона экрана «чат + рабочий стол» (этап 5 пакета
 * 2026-08-19б): ярлыки-ссылки, папки окном поверх, корзина в правом нижнем углу.
 * Всё состояние живёт снаружи (ключ `desktop` в ui_profile_json) — компонент
 * получает снимок и репортит изменения через onChange.
 *
 * Раскладка (этап C): плитки лежат в СЕТКЕ, координата хранится в ячейках. Число колонок
 * плавает вместе с разделителем, поэтому нарисованное место считает `desktopLayoutGrid` —
 * плитка, чья ячейка в текущей ширине не существует, показывается на свободном месте, но
 * сохранённую координату не теряет: иначе одно движение разделителя переписало бы стол на
 * всех машинах пользователя (запись профиля = две строки в ledger, грабля M79).
 */
export function DesktopPane(props: {
  desktop: UserUiProfileDesktop;
  onChange: (next: UserUiProfileDesktop) => void;
  /** Открыть ярлык (deep-link). Ярлык без link просто ничего не делает. */
  onOpenLink: (link: unknown, shortcutId: string) => void;
  /** Шаг размера плитки по рейтингу использования. Нет ответа — сегодняшний вид (0). */
  stepOf?: Record<string, number>;
}) {
  const { confirm, promptText } = useConfirm();
  const { desktop, onChange } = props;
  const tileStep = useCallback((shortcutId: string) => props.stepOf?.[shortcutId] ?? 0, [props.stepOf]);

  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [lasso, setLasso] = useState<Lasso | null>(null);
  /** Куда ляжет плитка, если отпустить здесь. Показывается маркером на самой ячейке. */
  const [dropCell, setDropCell] = useState<{ col: number; row: number } | null>(null);
  const [cols, setCols] = useState(1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** Что именно тащим. Внутри одного рендерера ref надёжнее dataTransfer: тот отдаёт
   *  значения только в drop-событии, а подсветка нужна уже на dragover. */
  const dragIdsRef = useRef<string[]>([]);
  const dragAnchorRef = useRef<string | null>(null);

  // Контекстное меню закрывается любым кликом/Escape — как системное.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const openFolder = openFolderId ? desktop.folders.find((f) => f.id === openFolderId) ?? null : null;
  const surface = desktopSurfaceShortcuts(desktop);
  const trash = desktopTrashShortcuts(desktop);

  // Сколько колонок влезает. Ширина зоны плавает вместе с разделителем «чат | стол»,
  // поэтому считаем по факту, а не по константе.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setCols(Math.max(1, Math.floor((el.clientWidth - PAD * 2) / DESKTOP_CELL_W)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const grid = useMemo(
    () =>
      desktopLayoutGrid({
        folderIds: desktop.folders.map((f) => f.id),
        shortcuts: surface.map((s) => ({
          id: s.id,
          ...(s.pos ? { pos: s.pos } : {}),
          cells: desktopTileMetrics(tileStep(s.id)).cells,
        })),
        cols,
      }),
    [desktop.folders, surface, cols, tileStep],
  );
  const placeById = useMemo(() => new Map(grid.shortcuts.map((p) => [p.id, p])), [grid]);

  const menuPos = useCallback((e: React.MouseEvent) => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }, []);

  // ─── выделение ────────────────────────────────────────────────────────────
  const clearSelection = useCallback(() => setSelected((prev) => (prev.size === 0 ? prev : new Set())), []);

  function selectOne(id: string, additive: boolean) {
    setSelected((prev) => {
      if (!additive) return prev.size === 1 && prev.has(id) ? prev : new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function trashSelection() {
    const ids = [...selected].filter((id) => desktop.shortcuts.some((s) => s.id === id && s.deletedAt == null));
    if (ids.length === 0) return;
    const next = desktopMoveToTrashMany(desktop, ids, Date.now());
    if (next === desktop) return;
    clearSelection();
    onChange(next);
  }

  // Delete и Escape — только когда фокус внутри стола: тот же Delete в чате не должен
  // сносить ярлыки, а стол живёт на одном экране с полем ввода сообщения.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (isTypingTarget(active)) return;
      if (!rootRef.current?.contains(active)) return;
      if (e.key === 'Escape') {
        if (openFolderId) setOpenFolderId(null);
        clearSelection();
        return;
      }
      if (e.key === 'Delete' && selected.size > 0) {
        e.preventDefault();
        void trashSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ─── перетаскивание ───────────────────────────────────────────────────────
  function startDrag(e: React.DragEvent, shortcutId: string) {
    // Тащат невыделенное — выделение переезжает на него: иначе жест «схватил и потянул»
    // молча перенёс бы не то, что оператор видит выделенным.
    const ids = selected.has(shortcutId) ? [...selected] : [shortcutId];
    if (!selected.has(shortcutId)) setSelected(new Set([shortcutId]));
    dragIdsRef.current = ids;
    dragAnchorRef.current = shortcutId;
    e.dataTransfer.setData(DND_SHORTCUT, shortcutId);
    e.dataTransfer.effectAllowed = 'move';
  }

  function endDrag() {
    setDragOverTarget(null);
    setDropCell(null);
    dragIdsRef.current = [];
    dragAnchorRef.current = null;
  }

  /** Кого тащим: ref-сессия, а в дегенеративном случае — единственный id из dataTransfer. */
  function draggedIds(e: React.DragEvent): string[] {
    if (dragIdsRef.current.length > 0) return dragIdsRef.current;
    const id = e.dataTransfer.getData(DND_SHORTCUT);
    return id ? [id] : [];
  }

  function allowDrop(e: React.DragEvent, target: string) {
    if (!e.dataTransfer.types.includes(DND_SHORTCUT)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverTarget(target);
  }

  function cellFromPoint(clientX: number, clientY: number): { col: number; row: number } | null {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const col = Math.floor((clientX - r.left) / DESKTOP_CELL_W);
    const row = Math.floor((clientY - r.top) / DESKTOP_CELL_H);
    return { col: Math.min(Math.max(col, 0), cols - 1), row: Math.max(row, 0) };
  }

  /** Дроп на свободное место: перенос с координатой, возврат из корзины, выход из папки. */
  function dropOnSurface(e: React.DragEvent) {
    e.preventDefault();
    const ids = draggedIds(e);
    const anchor = dragAnchorRef.current ?? ids[0] ?? null;
    endDrag();
    if (ids.length === 0 || !anchor) return;
    const cell = cellFromPoint(e.clientX, e.clientY);
    if (!cell) return;

    const byId = new Map(desktop.shortcuts.map((s) => [s.id, s]));
    let next = desktop;
    for (const id of ids) {
      const s = byId.get(id);
      if (!s) continue;
      if (s.deletedAt != null) next = desktopRestoreFromTrash(next, id);
      else if (s.folderId != null) next = desktopMoveToFolder(next, id, null);
    }

    // Остальные едут за якорем, сохраняя взаимное расположение.
    const anchorPlace = placeById.get(anchor);
    const updates: Array<{ id: string; pos: { col: number; row: number } }> = [];
    for (const id of ids) {
      if (!byId.has(id)) continue;
      const from = placeById.get(id);
      const pos =
        from && anchorPlace
          ? {
              col: Math.min(Math.max(from.col + (cell.col - anchorPlace.col), 0), cols - 1),
              row: Math.max(from.row + (cell.row - anchorPlace.row), 0),
            }
          : cell;
      updates.push({ id, pos });
    }

    // Занятые ячейки: у чужой плитки, стоявшей здесь, координата снимается — она уедет
    // потоком на свободное место. Иначе две плитки хранили бы одну ячейку, и кто из них
    // останется на месте, решал бы порядок массива.
    const taken = new Set<string>();
    for (const u of updates) {
      const cells = desktopTileMetrics(tileStep(u.id)).cells;
      for (let i = 0; i < cells; i += 1) taken.add(`${u.pos.row}:${u.pos.col + i}`);
    }
    const moving = new Set(ids);
    const displaced = next.shortcuts.map((s) => {
      if (moving.has(s.id) || !s.pos) return s;
      const cells = desktopTileMetrics(tileStep(s.id)).cells;
      let hit = false;
      for (let i = 0; i < cells; i += 1) if (taken.has(`${s.pos.row}:${s.pos.col + i}`)) hit = true;
      if (!hit) return s;
      const { pos: _pos, ...rest } = s;
      return rest;
    });
    if (displaced.some((s, i) => s !== next.shortcuts[i])) next = { ...next, shortcuts: displaced };

    next = desktopSetPositions(next, updates);
    if (next !== desktop) onChange(next);
  }

  // ─── лассо ────────────────────────────────────────────────────────────────
  function pointFromEvent(clientX: number, clientY: number): { x: number; y: number } | null {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  function onSurfacePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    // Клик пришёл по плитке — это выделение, а не рамка.
    if ((e.target as HTMLElement).closest('[data-desktop-shortcut],[data-desktop-folder]')) return;
    const start = pointFromEvent(e.clientX, e.clientY);
    if (!start) return;
    if (!e.ctrlKey && !e.metaKey) clearSelection();
    // Фокус на зону: без него оконные Delete/Escape не поймут, что оператор в столе.
    rootRef.current?.focus({ preventScroll: true });
    const base = e.ctrlKey || e.metaKey ? new Set(selected) : new Set<string>();
    setLasso({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });

    const move = (ev: PointerEvent) => {
      const p = pointFromEvent(ev.clientX, ev.clientY);
      if (!p) return;
      const box = { x0: start.x, y0: start.y, x1: p.x, y1: p.y };
      setLasso(box);
      const left = Math.min(box.x0, box.x1);
      const right = Math.max(box.x0, box.x1);
      const top = Math.min(box.y0, box.y1);
      const bottom = Math.max(box.y0, box.y1);
      const hit = new Set(base);
      for (const place of grid.shortcuts) {
        const m = desktopTileMetrics(tileStep(place.id));
        const tl = tileOrigin(place, m);
        if (tl.left < right && tl.left + m.width > left && tl.top < bottom && tl.top + m.height > top) hit.add(place.id);
      }
      setSelected(hit);
    };
    const up = () => {
      setLasso(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  async function deleteFolderWithConfirm(folderId: string) {
    const folder = desktop.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const count = desktopFolderShortcuts(desktop, folderId).length;
    const ok = await confirm({
      title: 'Удалить папку?',
      detail:
        count > 0
          ? `Папка «${folder.name}» будет удалена, её ярлыки (${count}) переедут в корзину.`
          : `Папка «${folder.name}» пуста и будет удалена.`,
      confirmLabel: 'Удалить папку',
    });
    if (!ok) return;
    if (openFolderId === folderId) setOpenFolderId(null);
    onChange(desktopDeleteFolder(desktop, folderId, Date.now()));
  }

  async function emptyTrashWithConfirm() {
    if (trash.length === 0) return;
    const ok = await confirm({
      title: 'Очистить корзину?',
      detail: `Ярлыки в корзине (${trash.length}) будут удалены окончательно.`,
      confirmLabel: 'Очистить',
    });
    if (!ok) return;
    setTrashOpen(false);
    onChange(desktopEmptyTrash(desktop));
  }

  async function createFolder() {
    const name = await promptText({
      title: 'Новая папка',
      placeholder: 'Название папки',
      confirmLabel: 'Создать',
      validate: (v) => (v.trim() ? null : 'Введите название'),
    });
    if (!name || !name.trim()) return;
    onChange(desktopAddFolder(desktop, { id: crypto.randomUUID(), name: name.trim() }, Date.now()));
  }

  async function renameFolder(folderId: string) {
    const folder = desktop.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const name = await promptText({
      title: 'Переименовать папку',
      placeholder: folder.name,
      confirmLabel: 'Сохранить',
      validate: (v) => (v.trim() ? null : 'Введите название'),
    });
    if (!name || !name.trim()) return;
    onChange(desktopRenameFolder(desktop, folderId, name));
  }

  // Подпись ярлыка замораживается при создании (крошки раздела на тот момент) —
  // переименование единственный способ её поправить (этап B).
  async function renameShortcut(shortcutId: string) {
    const shortcut = desktop.shortcuts.find((x) => x.id === shortcutId);
    if (!shortcut) return;
    const label = await promptText({
      title: 'Переименовать ярлык',
      placeholder: shortcut.label,
      confirmLabel: 'Сохранить',
      validate: (v) => (v.trim() ? null : 'Введите название'),
    });
    if (!label || !label.trim()) return;
    onChange(desktopRenameShortcut(desktop, shortcutId, label));
  }

  /** Левый верхний угол плитки внутри её ячеек — плитка уже́ ячейки и центрируется в них. */
  function tileOrigin(place: DesktopPlacement, m: DesktopTileMetrics): { left: number; top: number } {
    return {
      left: place.col * DESKTOP_CELL_W + Math.round((place.cells * DESKTOP_CELL_W - m.width) / 2),
      top: place.row * DESKTOP_CELL_H + Math.round((DESKTOP_CELL_H - m.height) / 2),
    };
  }

  function shortcutTile(s: DesktopShortcut, opts: { inTrash?: boolean; place?: DesktopPlacement } = {}) {
    const m = desktopTileMetrics(tileStep(s.id));
    const on = selected.has(s.id);
    const box: React.CSSProperties = opts.place
      ? { position: 'absolute', ...tileOrigin(opts.place, m), width: m.width, height: m.height }
      : { width: m.width };
    return (
      <button
        key={s.id}
        type="button"
        draggable
        data-desktop-shortcut={s.id}
        {...(on ? { 'data-desktop-selected': '1' } : {})}
        onDragStart={(e) => startDrag(e, s.id)}
        onDragEnd={endDrag}
        onClick={(e) => selectOne(s.id, e.ctrlKey || e.metaKey)}
        onDoubleClick={() => {
          if (s.link != null) props.onOpenLink(s.link, s.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!selected.has(s.id)) setSelected(new Set([s.id]));
          setCtxMenu({ kind: 'shortcut', id: s.id, inTrash: opts.inTrash ?? false, ...menuPos(e) });
        }}
        title={s.link != null ? `${s.label} — двойной клик откроет раздел` : s.label}
        style={{
          ...box,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          padding: '10px 4px',
          border: `1px solid ${on ? theme.colors.borderStrong : 'transparent'}`,
          borderRadius: 10,
          background: on ? theme.colors.surface2 : 'transparent',
          color: theme.colors.text,
          cursor: 'pointer',
          overflow: 'hidden',
        }}
      >
        <span style={{ fontSize: m.icon, lineHeight: `${m.iconLine}px` }} aria-hidden="true">
          {s.icon}
        </span>
        <span
          style={{
            fontSize: m.label,
            lineHeight: `${m.labelLine}px`,
            textAlign: 'center',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            wordBreak: 'break-word',
          }}
        >
          {s.label}
        </span>
      </button>
    );
  }

  function folderTile(place: DesktopPlacement, name: string) {
    const folderId = place.id;
    const count = desktopFolderShortcuts(desktop, folderId).length;
    const hot = dragOverTarget === `folder:${folderId}`;
    const m = desktopTileMetrics(0);
    return (
      <button
        key={folderId}
        type="button"
        data-desktop-folder={folderId}
        onDoubleClick={() => setOpenFolderId(folderId)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ kind: 'folder', id: folderId, ...menuPos(e) });
        }}
        onDragOver={(e) => allowDrop(e, `folder:${folderId}`)}
        onDragLeave={() => setDragOverTarget((t) => (t === `folder:${folderId}` ? null : t))}
        onDrop={(e) => {
          // stopPropagation обязателен: без него дроп всплывёт к полотну и ярлык уедет не в
          // папку, а на свободное место — корневой обработчик доиграет поверх этого.
          e.preventDefault();
          e.stopPropagation();
          const ids = draggedIds(e);
          endDrag();
          if (ids.length === 0) return;
          const next = desktopMoveToFolderMany(desktop, ids, folderId);
          if (next !== desktop) onChange(next);
        }}
        title={`${name} — двойной клик откроет папку`}
        style={{
          position: 'absolute',
          ...tileOrigin(place, m),
          width: m.width,
          height: m.height,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          padding: '10px 4px',
          border: `1px solid ${hot ? theme.colors.borderStrong : 'transparent'}`,
          borderRadius: 10,
          background: hot ? theme.colors.surface2 : 'transparent',
          color: theme.colors.text,
          cursor: 'pointer',
          overflow: 'hidden',
        }}
      >
        <span style={{ fontSize: m.icon, lineHeight: `${m.iconLine}px` }} aria-hidden="true">
          📁
        </span>
        <span style={{ fontSize: m.label, lineHeight: `${m.labelLine}px`, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: m.width - 8 }}>
          {name}
          {count > 0 ? ` (${count})` : ''}
        </span>
      </button>
    );
  }

  const trashHot = dragOverTarget === 'trash';
  const lassoBox = lasso
    ? {
        left: Math.min(lasso.x0, lasso.x1),
        top: Math.min(lasso.y0, lasso.y1),
        width: Math.abs(lasso.x1 - lasso.x0),
        height: Math.abs(lasso.y1 - lasso.y0),
      }
    : null;

  return (
    <div
      ref={rootRef}
      data-desktop-pane
      tabIndex={-1}
      onContextMenu={(e) => {
        // ПКМ по свободному месту — меню поверхности («Создать папку»).
        e.preventDefault();
        clearSelection();
        setCtxMenu({ kind: 'surface', ...menuPos(e) });
      }}
      style={{
        position: 'relative',
        height: '100%',
        minWidth: 0,
        overflow: 'hidden',
        outline: 'none',
      }}
    >
      {/* Полотно сетки: папки в начале, ярлыки — по своим ячейкам */}
      <div
        ref={scrollRef}
        style={{ height: '100%', overflowY: 'auto', padding: PAD }}
        onPointerDown={onSurfacePointerDown}
        onDragOver={(e) => {
          allowDrop(e, 'surface');
          if (!e.defaultPrevented) return;
          const cell = cellFromPoint(e.clientX, e.clientY);
          setDropCell((prev) => (prev && cell && prev.col === cell.col && prev.row === cell.row ? prev : cell));
        }}
        onDragLeave={() => setDropCell(null)}
        onDrop={dropOnSurface}
      >
        <div
          ref={canvasRef}
          data-desktop-canvas
          style={{
            position: 'relative',
            width: cols * DESKTOP_CELL_W,
            height: Math.max(grid.rows, 1) * DESKTOP_CELL_H,
            minHeight: '100%',
          }}
        >
          {grid.folders.map((p) => folderTile(p, desktop.folders.find((f) => f.id === p.id)?.name ?? ''))}
          {surface.map((s) => {
            const place = placeById.get(s.id);
            return place ? shortcutTile(s, { place }) : null;
          })}
          {desktop.folders.length === 0 && surface.length === 0 && (
            <div style={{ position: 'absolute', top: 4, left: 4, color: theme.colors.muted, fontSize: 13, padding: 16, maxWidth: 420 }}>
              Рабочий стол пуст. Кнопка «На рабочий стол» в МЕНЮ добавит сюда ярлык текущего раздела;
              ПКМ по свободному месту — создать папку.
            </div>
          )}
          {dropCell && (
            <div
              data-desktop-drop-marker
              style={{
                position: 'absolute',
                left: dropCell.col * DESKTOP_CELL_W,
                top: dropCell.row * DESKTOP_CELL_H,
                width: DESKTOP_CELL_W,
                height: DESKTOP_CELL_H,
                border: `1px dashed ${theme.colors.borderStrong}`,
                borderRadius: 10,
                pointerEvents: 'none',
              }}
            />
          )}
          {lassoBox && (
            <div
              data-desktop-lasso
              style={{
                position: 'absolute',
                ...lassoBox,
                border: `1px solid ${theme.colors.borderStrong}`,
                background: theme.colors.surface2,
                opacity: 0.35,
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      </div>

      {/* Корзина — постоянный элемент, правый нижний угол */}
      <button
        type="button"
        data-desktop-trash
        onClick={() => setTrashOpen((v) => trash.length > 0 && !v)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ kind: 'trash', ...menuPos(e) });
        }}
        onDragOver={(e) => allowDrop(e, 'trash')}
        onDragLeave={() => setDragOverTarget((t) => (t === 'trash' ? null : t))}
        onDrop={(e) => {
          // Как и у папки: без stopPropagation дроп доиграет полотном и ярлык вернётся на стол.
          e.preventDefault();
          e.stopPropagation();
          const ids = draggedIds(e);
          endDrag();
          if (ids.length === 0) return;
          const next = desktopMoveToTrashMany(desktop, ids, Date.now());
          if (next !== desktop) {
            clearSelection();
            onChange(next);
          }
        }}
        title={trash.length > 0 ? `Корзина: ${trash.length}. Клик — показать содержимое, ПКМ — очистить.` : 'Корзина пуста. Перетащите сюда ярлык, чтобы удалить.'}
        style={{
          position: 'absolute',
          right: 16,
          bottom: 12,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
          padding: '8px 12px',
          borderRadius: 10,
          border: `1px solid ${trashHot ? theme.colors.borderStrong : theme.colors.border}`,
          background: trashHot ? theme.colors.surface2 : theme.colors.surface,
          color: theme.colors.text,
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 26 }} aria-hidden="true">
          {trash.length > 0 ? '🗑️' : '🗑'}
        </span>
        <span style={{ fontSize: 11, color: theme.colors.muted }}>Корзина{trash.length > 0 ? ` (${trash.length})` : ''}</span>
      </button>

      {/* Содержимое корзины — всплывашка над кнопкой; ярлык можно утащить обратно на стол */}
      {trashOpen && trash.length > 0 && (
        <div
          style={{
            position: 'absolute',
            right: 16,
            bottom: 78,
            width: 320,
            maxHeight: '55%',
            overflowY: 'auto',
            border: `1px solid ${theme.colors.border}`,
            borderRadius: 12,
            background: theme.colors.surface,
            boxShadow: theme.colors.chatMenuShadow,
            padding: 8,
            zIndex: 5,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 6px 8px' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Корзина</span>
            <button
              type="button"
              onClick={() => setTrashOpen(false)}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: theme.colors.muted }}
              title="Закрыть"
            >
              ✕
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>{trash.map((s) => shortcutTile(s, { inTrash: true }))}</div>
          <div style={{ fontSize: 11, color: theme.colors.muted, padding: '6px 6px 2px' }}>
            Перетащите ярлык на стол, чтобы вернуть; ПКМ по корзине — очистить.
          </div>
        </div>
      )}

      {/* Окно папки поверх стола, ≈¾ зоны */}
      {openFolder && (
        <div
          data-desktop-folder-window
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.25)',
            zIndex: 6,
          }}
          onClick={() => setOpenFolderId(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              // Внутри окна папки меню поверхности стола не нужно.
              e.preventDefault();
              e.stopPropagation();
            }}
            style={{
              width: '75%',
              height: '75%',
              display: 'flex',
              flexDirection: 'column',
              border: `1px solid ${theme.colors.border}`,
              borderRadius: 14,
              background: theme.colors.surface,
              boxShadow: theme.colors.chatMenuShadow,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 14px',
                borderBottom: `1px solid ${theme.colors.border}`,
                background: theme.colors.surface2,
              }}
            >
              <span style={{ fontWeight: 700 }}>📁 {openFolder.name}</span>
              <button
                type="button"
                data-desktop-folder-close
                onClick={() => setOpenFolderId(null)}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, color: theme.colors.muted }}
                title="Закрыть папку"
              >
                ✕
              </button>
            </div>
            <div
              // Подсказка ниже обещает приём ярлыков — значит окно обязано быть приёмником:
              // иначе дроп всплывал бы к полотну и ярлык уезжал на стол вместо папки.
              onDragOver={(e) => allowDrop(e, `folder:${openFolder.id}`)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const ids = draggedIds(e);
                endDrag();
                if (ids.length === 0) return;
                const next = desktopMoveToFolderMany(desktop, ids, openFolder.id);
                if (next !== desktop) onChange(next);
              }}
              style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 4, padding: 12 }}
            >
              {desktopFolderShortcuts(desktop, openFolder.id).map((s) => shortcutTile(s))}
              {desktopFolderShortcuts(desktop, openFolder.id).length === 0 && (
                <div style={{ color: theme.colors.muted, fontSize: 13, padding: 10 }}>
                  Папка пуста. Перетащите сюда ярлыки со стола.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Контекстное меню */}
      {ctxMenu && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: Math.min(ctxMenu.x, (rootRef.current?.clientWidth ?? 400) - 220),
            top: Math.min(ctxMenu.y, (rootRef.current?.clientHeight ?? 300) - 140),
            minWidth: 200,
            border: `1px solid ${theme.colors.chatMenuBorder}`,
            borderRadius: 10,
            background: theme.colors.chatMenuBg,
            boxShadow: theme.colors.chatMenuShadow,
            padding: 4,
            zIndex: 10,
          }}
        >
          {ctxMenu.kind === 'surface' && (
            <CtxItem
              label="📁 Создать папку"
              onClick={() => {
                setCtxMenu(null);
                void createFolder();
              }}
            />
          )}
          {ctxMenu.kind === 'shortcut' && (
            <>
              {(() => {
                const s = desktop.shortcuts.find((x) => x.id === ctxMenu.id);
                return s?.link != null ? (
                  <CtxItem
                    label="↗ Открыть"
                    onClick={() => {
                      setCtxMenu(null);
                      props.onOpenLink(s.link, s.id);
                    }}
                  />
                ) : null;
              })()}
              {ctxMenu.inTrash ? (
                <CtxItem
                  label="↩ Вернуть на стол"
                  onClick={() => {
                    setCtxMenu(null);
                    onChange(desktopRestoreFromTrash(desktop, ctxMenu.id));
                  }}
                />
              ) : (
                <>
                  <CtxItem
                    label="✏️ Переименовать"
                    onClick={() => {
                      setCtxMenu(null);
                      void renameShortcut(ctxMenu.id);
                    }}
                  />
                  <CtxItem
                    label={selected.size > 1 ? `🗑 Удалить выделенные (${selected.size})` : '🗑 Удалить (в корзину)'}
                    onClick={() => {
                      setCtxMenu(null);
                      if (selected.size > 1 && selected.has(ctxMenu.id)) void trashSelection();
                      else onChange(desktopMoveToTrash(desktop, ctxMenu.id, Date.now()));
                    }}
                  />
                </>
              )}
            </>
          )}
          {ctxMenu.kind === 'folder' && (
            <>
              <CtxItem
                label="↗ Открыть папку"
                onClick={() => {
                  setCtxMenu(null);
                  setOpenFolderId(ctxMenu.id);
                }}
              />
              <CtxItem
                label="✏️ Переименовать"
                onClick={() => {
                  setCtxMenu(null);
                  void renameFolder(ctxMenu.id);
                }}
              />
              <CtxItem
                label="🗑 Удалить папку"
                onClick={() => {
                  setCtxMenu(null);
                  void deleteFolderWithConfirm(ctxMenu.id);
                }}
              />
            </>
          )}
          {ctxMenu.kind === 'trash' && (
            <CtxItem
              label={trash.length > 0 ? `🧹 Очистить корзину (${trash.length})` : '🧹 Корзина пуста'}
              onClick={() => {
                setCtxMenu(null);
                void emptyTrashWithConfirm();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CtxItem(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 12px',
        border: 'none',
        borderRadius: 8,
        background: 'transparent',
        color: theme.colors.text,
        fontSize: 13,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = theme.colors.surface2;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      {props.label}
    </button>
  );
}
