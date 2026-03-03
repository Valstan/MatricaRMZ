import { escapeHtml, openPrintPreview } from './printPreview.js';

export type ListContextColumn<T> = {
  title: string;
  value: (row: T) => string;
};

export type ListContextMenuActionItem = {
  id: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
};

function normalizeCell(value: unknown): string {
  if (value == null) return '—';
  const text = String(value).trim();
  return text || '—';
}

export function buildRowsText<T>(rows: T[], columns: Array<ListContextColumn<T>>): string {
  return rows
    .map((row) => columns.map((column) => `${column.title}: ${normalizeCell(column.value(row))}`).join(' | '))
    .join('\n');
}

export function buildRowsTableHtml<T>(rows: T[], columns: Array<ListContextColumn<T>>): string {
  const head = columns.map((column) => `<th>${escapeHtml(column.title)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(normalizeCell(column.value(row)))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export async function copyRowsToClipboard<T>(rows: T[], columns: Array<ListContextColumn<T>>) {
  const text = buildRowsText(rows, columns);
  await navigator.clipboard.writeText(text);
}

export function printRowsPreview<T>(args: {
  title: string;
  sectionTitle: string;
  rows: T[];
  columns: Array<ListContextColumn<T>>;
}) {
  openPrintPreview({
    title: args.title,
    sections: [{ id: 'rows', title: args.sectionTitle, html: buildRowsTableHtml(args.rows, args.columns) }],
  });
}

export function buildCopyRowsStatus(rowCount: number): string {
  return rowCount > 1 ? `Скопировано строк: ${rowCount}` : 'Строка скопирована';
}

export function buildDeleteRowsStatus(args: {
  failedCount: number;
  deletedCount: number;
  deletedManyLabel: string;
  deletedSingleLabel?: string;
}): string {
  if (args.failedCount > 0) return `Удаление с ошибками: ${args.failedCount}`;
  if (args.deletedCount > 1) return `Удалено ${args.deletedManyLabel}: ${args.deletedCount}`;
  return args.deletedSingleLabel ?? 'Удалено';
}

export function buildDeleteConfirmMessage(args: {
  selectedCount: number;
  selectedManyLabel: string;
  singleLabel: string;
}): string {
  if (args.selectedCount > 1) return `Удалить ${args.selectedManyLabel} (${args.selectedCount})?`;
  return `Удалить ${args.singleLabel}?`;
}

export function resolveMenuRows<T>(targetIds: string[], rowById: ReadonlyMap<string, T>): T[] {
  return targetIds.map((id) => rowById.get(id)).filter((row): row is T => Boolean(row));
}

export function buildListContextMenuItems<T>(args: {
  rows: T[];
  bulk: boolean;
  canDelete: boolean;
  getId: (row: T) => string;
  onSelect: (id: string) => void;
  onPrint: (rows: T[]) => void;
  onCopy: (rows: T[]) => void | Promise<void>;
  onDelete: (ids: string[]) => void | Promise<void>;
  onClearSelection: () => void;
}): ListContextMenuActionItem[] {
  if (!args.rows.length) return [];
  if (args.bulk) {
    const count = args.rows.length;
    return [
      { id: 'print-selected', label: `Распечатать выделенные (${count})`, onClick: () => args.onPrint(args.rows) },
      { id: 'copy-selected', label: `Скопировать выделенные (${count})`, onClick: () => void args.onCopy(args.rows) },
      {
        id: 'delete-selected',
        label: `Удалить выделенные (${count})`,
        danger: true,
        disabled: !args.canDelete,
        onClick: () => void args.onDelete(args.rows.map((row) => args.getId(row))),
      },
      { id: 'clear-selected', label: 'Снять выделение', onClick: args.onClearSelection },
    ];
  }
  const row = args.rows[0];
  return [
    { id: 'select-row', label: 'Выделить', onClick: () => args.onSelect(args.getId(row)) },
    { id: 'print-row', label: 'Распечатать', onClick: () => args.onPrint([row]) },
    { id: 'copy-row', label: 'Скопировать', onClick: () => void args.onCopy([row]) },
    {
      id: 'delete-row',
      label: 'Удалить',
      danger: true,
      disabled: !args.canDelete,
      onClick: () => void args.onDelete([args.getId(row)]),
    },
  ];
}

