import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { PopupLayer, useAnchoredPopup } from './PopupLayer.js';

/**
 * Ряд кнопок списка (владелец 08.09.2026 — одна строка; владелец 24.11.2026, промт КАРМАНА #118
 * — «все управляющие кнопки прижать влево, и если они выходят за правый край — переносить их
 * влево»).
 *
 * Ряд прижат ВЛЕВО и переносится на вторую строку: кнопка, не поместившаяся по ширине, уезжает
 * на следующую строку, а не за правый край окна (на планшете справа кнопки уходили за край, и
 * оператору приходилось прокручивать экран). Меню «⋯» осталось как запасной путь для ряда, который
 * не влезает в ДВЕ строки: выше двух строк тулбар съедал бы высоту списка (решение владельца
 * 08.09.2026) и прятал таблицу под собой.
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
/**
 * Сколько строк занимает ряд. Две — потому что выше тулбар съедал бы высоту списка
 * и прятал таблицу под собой (решение владельца 08.09.2026). Всё, что не влезает
 * в две строки, уходит в меню «⋯» — но «⋯» стоит СЛЕВА, рядом с кнопками.
 */
const MAX_ROWS = 2;

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

  const rowRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const [measured, setMeasured] = useState<{
    signature: string;
    widths: Record<string, number>;
    pinned: Record<string, boolean>;
  } | null>(null);
  // Тот же замер и та же функция замера — но «нативно», без перерисовки: ими пользуется
  // ResizeObserver, когда ряд оживает (вкладка открыта, окно переехало).
  const measuredRef = useRef<typeof measured>(null);
  const measureRef = useRef<() => void>(() => {});
  const [rowWidth, setRowWidth] = useState(0);
  // Подпись замера — состав ряда И ширина окна: поле поиска адаптивно (на узком экране
  // оно мельче), и без перезамера кэш ширин после изменения размера окна врал бы
  // (план #119, п.17).
  const signature = `${items.map((it) => it.key).join('|')}@${rowWidth}`;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Кнопка «⋯» стоит в конце ряда — но ряд прижат влево, поэтому и «⋯» у левого края
  // (владелец 24.11.2026: «⋯» — слева). Меню «Ещё кнопки» уезжает порталом в body:
  // тулбар липкий и со своим z-index, внутри него меню оказывалось под соседней
  // шапкой (PopupLayer). Меню раскрывается вправо от кнопки — справа от неё пусто.
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  const popup = useAnchoredPopup(menuOpen, menuAnchor, { align: 'left' });

  const setItemRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) itemRefs.current.set(key, el);
    else itemRefs.current.delete(key);
  }, []);

  const measuring = measured?.signature !== signature;

  // Замер ширин элементов ряда. Вынесен в функцию, потому что мерять надо дважды: при смене
  // состава ряда и тогда, когда ряд измерился, пока вкладка была скрыта (см. ниже).
  const measureItems = useCallback(() => {
    // Этот состав ряда уже меряли — повторный замер дал бы нули (спрятанные элементы из
    // ряда убраны) и сломал бы счётку переполнения.
    if (measuredRef.current?.signature === signature) return;
    const row = rowRef.current;
    if (!row || row.clientWidth <= 0) return;
    const widths: Record<string, number> = {};
    const pinned: Record<string, boolean> = {};
    for (const it of items) {
      const el = itemRefs.current.get(it.key);
      const live = el ? Math.ceil(el.getBoundingClientRect().width) : 0;
      // Элемент, уехавший в меню, в DOM не лежит — его ширина нулевая. Прежнюю мерку
      // сохраняем: иначе пересчёт счёл бы его бесплатным, и ряд «схлопнул» бы в одну кнопку.
      const prev = measuredRef.current?.widths[it.key] ?? 0;
      widths[it.key] = live > 0 ? live : prev;
      pinned[it.key] = el
        ? Boolean(el.querySelector('[data-toolbar-pin]'))
        : Boolean(measuredRef.current?.pinned[it.key]);
    }
    if (items.length > 0 && Object.values(widths).every((w) => w <= 0)) return;
    const next = { signature, widths, pinned };
    measuredRef.current = next;
    setMeasured(next);
  }, [items, signature]);

  useEffect(() => {
    measureRef.current = measureItems;
  }, [measureItems]);

  useLayoutEffect(() => {
    if (!measuring) return;
    // Скрытая вкладка отдаёт нулевые ширины, а кэш пишется один раз на состав ряда: замер
    // «в темноте» навсегда сделал бы ряд шириной 0, и в меню не уезжало бы ничего. Пока ряд
    // не на экране — не запоминаем; как только вкладка станет видимой, ряд получит размер —
    // и тогда мы перемерим (это делает ResizeObserver ниже).
    measureItems();
  }, [measuring, measureItems]);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    setRowWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setRowWidth(el.clientWidth);
      // Ряд измерился, пока вкладка была скрыта: кэша нет, а лишние кнопки без него просто
      // срезаются краем окна — и до них нельзя добраться. Ряд получил размер (вкладка
      // открылась или окно переехало) — меряем по-настоящему.
      measureRef.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const hiddenKeys = useMemo(() => {
    const empty = new Set<string>();
    if (measuring || rowWidth <= 0 || !measured) return empty;
    const widthOf = (key: string) => measured.widths[key] ?? 0;
    let needed = items.reduce((sum, it) => sum + widthOf(it.key), 0) + GAP * Math.max(0, items.length - 1);
    // Ряд переносится на вторую строку (владелец 24.11.2026) — но не выше: тулбар выше
    // двух строк съедал бы высоту списка. Всё, что в две строки не влезает, уходит в меню.
    const budget = rowWidth * MAX_ROWS;
    if (needed <= budget) return empty;
    const hidden = new Set<string>();
    needed += GAP + MENU_WIDTH;
    // Приоритет ЯВНЫЙ: с конца ряда (самое младшее) — в меню «⋯» первым. Раньше это
    // читалось как «кнопки исчезли», теперь они рядом, в меню слева от ряда.
    for (let i = items.length - 1; i >= 0 && needed > budget; i -= 1) {
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
      if (target && popup.node?.contains(target)) return;
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
  }, [menuOpen, popup.node]);

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
        // Ряд прижат влево (владелец 24.11.2026) и переносится на вторую строку:
        // кнопка, не поместившаяся по ширине, уходит влево-вниз, а не за правый край.
        justifyContent: 'flex-start',
        flex: '0 0 auto',
        flexWrap: 'wrap',
        rowGap: GAP,
        // Обрезки больше нет: перенесённая на вторую строку кнопка иначе срезалась бы
        // краем ряда (и была бы недоступна).
        overflow: 'visible',
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
        <div
          ref={(el) => {
            menuRef.current = el;
            setMenuAnchor(el);
          }}
          style={{ position: 'relative', flex: '0 0 auto' }}
        >
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
            <PopupLayer>
            <div
              role="menu"
              data-toolbar-overflow-menu
              ref={popup.ref}
              style={{
                ...popup.style,
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
            </PopupLayer>
          )}
        </div>
      )}
    </div>
  );
}
