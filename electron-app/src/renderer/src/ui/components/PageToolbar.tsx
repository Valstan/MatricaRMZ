import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useViewportClamp } from '../hooks/useViewportClamp.js';

/**
 * Ряд кнопок списка в ОДНУ строку (владелец 08.09.2026): что не поместилось по ширине —
 * уезжает в выпадающее меню справа, а не переносится второй строкой. Перенос съедал высоту
 * у самого списка и на узком окне прятал таблицу под тулбаром.
 *
 * Ширины замеряются один раз на состав ряда: первый проход рисует все элементы, `useLayoutEffect`
 * снимает их ширины ДО отрисовки на экране (поэтому мигания нет), дальше по ним считается, что
 * влезает. Пересчёт по ширине контейнера — из кэша, без повторного замера: спрятанный элемент
 * имеет нулевую ширину, и повторный замер схлопнул бы ряд в одну кнопку.
 */

/**
 * Обёртка «не убирать в меню»: поиск и его спутники должны остаться в строке всегда.
 *
 * Признак ставится РАЗМЕТКОЙ, а не типом компонента: сравнение `child.type === ToolbarPin`
 * ломается на горячей перезагрузке (Fast Refresh подменяет функцию, и закреплённых не
 * остаётся вовсе — в меню уезжает и поиск) и на минификации имён. `display: contents`
 * означает, что обёртка не участвует в раскладке — ряд считается ровно как без неё.
 */
export function ToolbarPin(props: { children: React.ReactNode }) {
  return (
    <span data-toolbar-pin style={{ display: 'contents' }}>
      {props.children}
    </span>
  );
}

const GAP = 8;
/** Ширина кнопки «⋯» вместе с зазором — резерв, чтобы она сама не оказалась за краем. */
const MENU_WIDTH = 46;

type ToolbarItem = { key: string; node: React.ReactNode };

export function PageToolbar(props: { children: React.ReactNode; className?: string }) {
  const items: ToolbarItem[] = useMemo(
    () =>
      React.Children.toArray(props.children)
        .filter((child) => child !== null && child !== undefined && child !== '')
        .map((child, index) => ({
          key: React.isValidElement(child) && child.key != null ? String(child.key) : `i${index}`,
          node: child,
        })),
    [props.children],
  );
  const signature = items.map((it) => it.key).join('|');

  const rowRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const [measured, setMeasured] = useState<{
    signature: string;
    widths: Record<string, number>;
    pinned: Record<string, boolean>;
  } | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Кнопка «⋯» по определению стоит у правого края — панель обязана вернуться в экран.
  const clamp = useViewportClamp(menuOpen);

  const setItemRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) itemRefs.current.set(key, el);
    else itemRefs.current.delete(key);
  }, []);

  const measuring = measured?.signature !== signature;

  useLayoutEffect(() => {
    if (!measuring) return;
    // Скрытая вкладка отдаёт нулевые ширины, а кэш пишется один раз на состав ряда: замер
    // «в темноте» навсегда сделал бы ряд шириной 0, и в меню не уезжало бы ничего. Пока ряд
    // не на экране — не запоминаем; эффект перезапустится, когда вкладка станет видимой.
    const row = rowRef.current;
    if (!row || row.clientWidth <= 0) return;
    const widths: Record<string, number> = {};
    const pinned: Record<string, boolean> = {};
    for (const it of items) {
      const el = itemRefs.current.get(it.key);
      widths[it.key] = el ? Math.ceil(el.getBoundingClientRect().width) : 0;
      pinned[it.key] = Boolean(el?.querySelector('[data-toolbar-pin]'));
    }
    if (items.length > 0 && Object.values(widths).every((w) => w <= 0)) return;
    setMeasured({ signature, widths, pinned });
  }, [measuring, signature, items]);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    setRowWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setRowWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const hiddenKeys = useMemo(() => {
    const empty = new Set<string>();
    if (measuring || rowWidth <= 0 || !measured) return empty;
    const widthOf = (key: string) => measured.widths[key] ?? 0;
    let needed = items.reduce((sum, it) => sum + widthOf(it.key), 0) + GAP * Math.max(0, items.length - 1);
    if (needed <= rowWidth) return empty;
    const hidden = new Set<string>();
    needed += GAP + MENU_WIDTH;
    for (let i = items.length - 1; i >= 0 && needed > rowWidth; i -= 1) {
      const it = items[i];
      if (!it || measured.pinned[it.key]) continue;
      hidden.add(it.key);
      needed -= widthOf(it.key) + GAP;
    }
    return hidden;
  }, [measuring, rowWidth, measured, items]);

  useEffect(() => {
    if (hiddenKeys.size === 0) setMenuOpen(false);
  }, [hiddenKeys]);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(ev: PointerEvent) {
      const target = ev.target as Node | null;
      if (target && menuRef.current && menuRef.current.contains(target)) return;
      setMenuOpen(false);
    }
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setMenuOpen(false);
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const hiddenItems = items.filter((it) => hiddenKeys.has(it.key));

  return (
    <div
      ref={rowRef}
      className={props.className ? `mx-page-toolbar ${props.className}` : 'mx-page-toolbar'}
      data-page-toolbar
      style={{
        display: 'flex',
        gap: GAP,
        alignItems: 'center',
        flex: '0 0 auto',
        flexWrap: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {/* Уехавший в меню элемент из строки убирается совсем, а не прячется стилем: иначе диалоги
          и всплывающие панели, живущие внутри кнопок, оказались бы на экране в двух копиях. */}
      {items
        .filter((it) => !hiddenKeys.has(it.key))
        .map((it) => (
          <div key={it.key} ref={(el) => setItemRef(it.key, el)} style={{ flex: '0 0 auto' }}>
            {it.node}
          </div>
        ))}
      {hiddenItems.length > 0 && (
        <div ref={menuRef} style={{ position: 'relative', marginLeft: 'auto', flex: '0 0 auto' }}>
          <button
            type="button"
            data-toolbar-overflow
            onClick={() => setMenuOpen((v) => !v)}
            title={`Ещё кнопки (${hiddenItems.length}) — не поместились в строку`}
            aria-label={`Ещё кнопки: ${hiddenItems.length}`}
            style={{
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              role="menu"
              data-toolbar-overflow-menu
              ref={clamp.ref}
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                right: 0,
                zIndex: 50,
                ...clamp.style,
                display: 'grid',
                gap: 6,
                justifyItems: 'stretch',
                minWidth: 200,
                maxHeight: 420,
                overflowY: 'auto',
                padding: 8,
                background: 'var(--surface)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
              }}
            >
              {hiddenItems.map((it) => (
                <div key={it.key} onClick={() => setMenuOpen(false)}>
                  {it.node}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
