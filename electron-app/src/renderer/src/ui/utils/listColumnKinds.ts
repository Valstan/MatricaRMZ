// Restyle stage 3 — column width policy. A list column declares its data kind; the
// CSS in global.css (`table.list-table [data-col-kind]`) then sizes the column by its
// data instead of its header. Every header carries a `title` so the truncated
// header stays discoverable on hover.
//
// Usage in a page that renders its own <th>/<td>:
//   <th {...listHeaderKindProps(col.kind, col.label)}>…</th>
//   <td {...listCellKindProps(col.kind)}>…</td>

export type ListColumnKind = 'flag' | 'num' | 'date' | 'name' | 'text' | 'thumbs';

export type ListHeaderKindProps = { 'data-col-kind'?: ListColumnKind; title?: string };
export type ListCellKindProps = { 'data-col-kind'?: ListColumnKind };

/**
 * Заголовок обрезается в одну строку (владелец 08.09.2026), поэтому полную подпись несёт
 * `title` у ЛЮБОГО вида колонки, а не только у узких: обрезанным теперь может оказаться
 * заголовок любой ширины.
 */
export function listHeaderKindProps(kind: ListColumnKind | undefined, label: string): ListHeaderKindProps {
  return kind ? { 'data-col-kind': kind, title: label } : { title: label };
}

export function listCellKindProps(kind: ListColumnKind | undefined): ListCellKindProps {
  return kind ? { 'data-col-kind': kind } : {};
}
