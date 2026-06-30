import React from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';

/** Атрибуты строки: стандартные HTML + произвольные `data-*` (для выделения и т.п.). */
export type VirtualTableRowProps = React.HTMLAttributes<HTMLTableRowElement> & {
  [key: `data-${string}`]: string | undefined;
};

/**
 * Виртуализированное тело таблицы поверх существующей разметки `list-table`.
 *
 * Рендерит только видимое окно строк (+overscan) внутри обычного `<table>`,
 * сохраняя sticky `<thead>` и колоночную раскладку (spacer-`<tr>` сверху/снизу
 * резервируют высоту вне окна; высота строк измеряется динамически).
 *
 * Данные (сортировка/фильтрация) остаются за вызывающей страницей и работают
 * по ВСЕМУ набору — компонент отвечает только за рендер окна.
 */
export function VirtualTable(props: {
  /** Ref на скролл-контейнер (элемент с overflow:auto), внутри которого живёт таблица. */
  scrollElementRef: React.RefObject<HTMLElement | null>;
  /** Полное число строк (всего, не только видимых). */
  count: number;
  /** `<thead>` таблицы (со sticky-заголовками и сортировкой). */
  header: React.ReactNode;
  /** Рендер ячеек строки по индексу — возвращает `<td>…</td>` (без обёртки `<tr>`). */
  renderCells: (index: number) => React.ReactNode;
  /** Стабильный ключ строки по индексу. */
  getRowKey: (index: number) => string;
  /** Доп. атрибуты строки (style/className/onClick/data-*) по индексу. */
  getRowProps?: (index: number) => VirtualTableRowProps;
  /** Число колонок (для colSpan спейсеров и пустого состояния). */
  colCount: number;
  /** Стартовая оценка высоты строки (px). По умолчанию 48. */
  estimateSize?: number;
  /** Сколько строк рендерить за пределами окна с каждой стороны. По умолчанию 12. */
  overscan?: number;
  tableClassName?: string;
  /** Что показать, когда строк нет. */
  emptyState?: React.ReactNode;
}) {
  const {
    scrollElementRef,
    count,
    header,
    renderCells,
    getRowKey,
    getRowProps,
    colCount,
    estimateSize = 48,
    overscan = 12,
    tableClassName = 'list-table',
    emptyState,
  } = props;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1]!.end : 0;

  // NB: no `overflow` here — an overflow!=visible wrapper would become the sticky
  // containing block and trap the sticky <th>, detaching it from the real scroll
  // container (scrollElementRef). Keep this div a plain visual frame.
  return (
    <div style={{ border: '1px solid #e5e7eb' }}>
      <table className={tableClassName}>
        {header}
        <tbody>
          {count === 0 ? (
            <tr>
              <td style={{ padding: 10, color: '#6b7280' }} colSpan={colCount}>
                {emptyState ?? 'Ничего не найдено'}
              </td>
            </tr>
          ) : (
            <>
              {paddingTop > 0 && (
                <tr aria-hidden="true" style={{ height: paddingTop }}>
                  <td style={{ padding: 0, border: 'none' }} colSpan={colCount} />
                </tr>
              )}
              {virtualItems.map((vi) => (
                <tr
                  key={getRowKey(vi.index)}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  {...(getRowProps?.(vi.index) ?? {})}
                >
                  {renderCells(vi.index)}
                </tr>
              ))}
              {paddingBottom > 0 && (
                <tr aria-hidden="true" style={{ height: paddingBottom }}>
                  <td style={{ padding: 0, border: 'none' }} colSpan={colCount} />
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
