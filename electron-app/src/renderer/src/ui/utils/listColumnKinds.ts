// Restyle stage 3 — column width policy. A list column declares its data kind; the
// CSS in global.css (`table.list-table [data-col-kind]`) then sizes the column by its
// data instead of its header. Narrow kinds also carry a `title` so the truncated
// header stays discoverable on hover.
//
// Usage in a page that renders its own <th>/<td>:
//   <th {...listHeaderKindProps(col.kind, col.label)}>…</th>
//   <td {...listCellKindProps(col.kind)}>…</td>

export type ListColumnKind = 'flag' | 'num' | 'date' | 'name' | 'text' | 'thumbs';

const NARROW_KINDS: ReadonlySet<ListColumnKind> = new Set<ListColumnKind>(['flag', 'num', 'date']);

export type ListHeaderKindProps = { 'data-col-kind'?: ListColumnKind; title?: string };
export type ListCellKindProps = { 'data-col-kind'?: ListColumnKind };

export function listHeaderKindProps(kind: ListColumnKind | undefined, label: string): ListHeaderKindProps {
  if (!kind) return {};
  return NARROW_KINDS.has(kind) ? { 'data-col-kind': kind, title: label } : { 'data-col-kind': kind };
}

export function listCellKindProps(kind: ListColumnKind | undefined): ListCellKindProps {
  return kind ? { 'data-col-kind': kind } : {};
}
