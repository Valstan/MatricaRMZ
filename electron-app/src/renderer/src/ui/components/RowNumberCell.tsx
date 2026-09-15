import React from 'react';

/**
 * Колонка «№» — крайняя левая, нумеруется при каждом построении списка и НЕ сохраняется
 * (владелец 15.09.2026). Живёт вне `useColumnLayout`: её нельзя скрыть или переставить.
 * `data-col-kind="rownum"` — CSS схлопывает её до контента, `useAdaptiveListTables`
 * пропускает при замере ширин.
 */
export function RowNumberHeaderCell(props: { style?: React.CSSProperties; className?: string }) {
  return (
    <th data-col-kind="rownum" className={props.className} style={props.style} title="Номер строки в списке" aria-label="Номер строки">
      №
    </th>
  );
}

/** `n: null` — строка без номера (черновик, заголовок группы): ячейка есть, номера нет. */
export function RowNumberCell(props: { n: number | null; style?: React.CSSProperties }) {
  return (
    <td data-col-kind="rownum" style={props.style}>
      {props.n ?? ''}
    </td>
  );
}
