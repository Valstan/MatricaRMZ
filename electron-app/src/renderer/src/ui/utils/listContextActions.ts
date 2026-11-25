import { escapeHtml, openPrintPreview } from './printPreview.js';
import type { ObjectActionDeclaration } from './objectActions.js';

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

/**
 * Объявление действия списка.
 *
 * Список **объявляет**, что он умеет, — и меню собирается из объявления. Раньше шаблон
 * был жёстким: «печать» и «копирование» были обязательными параметрами, «удаление»
 * присутствовало всегда и лишь гасло (серый пункт). По заказу владельца (промт КАРМАНА #67)
 * в меню должно быть ровно то, что список реально умеет: недоступного пункта не должно
 * быть ВООБЩЕ, а новое действие списка обязано попадать в меню само.
 *
 * Тип — общий для всей программы (`objectActions.ts`): списки и карточки объявляют
 * действия ОДНИМ способом, иначе «мёртвая кнопка» лечится в одном месте и остаётся в
 * другом (промт КАРМАНА #124 — гибкий модуль действий по объекту).
 */
export type ListActionDeclaration<T> = ObjectActionDeclaration<T[]>;

/**
 * Стандартные объявления действий. Подписи и правила — ОДНИ на всю программу: список
 * объявляет, что умеет, и берёт готовую формулировку. Расхождение подписей между
 * списками — это расхождение поведения, а правило здесь как раз про «везде одинаково».
 */
export function listPrintAction<T>(args: {
  available: boolean;
  print: (rows: T[]) => void;
}): ListActionDeclaration<T> {
  return {
    id: 'print',
    label: 'Распечатать',
    bulkLabel: 'Распечатать выделенные',
    available: args.available,
    scope: 'both',
    run: (rows) => args.print(rows),
  };
}

export function listCopyAction<T>(args: {
  available: boolean;
  copy: (rows: T[]) => void | Promise<void>;
}): ListActionDeclaration<T> {
  return {
    id: 'copy',
    label: 'Скопировать',
    bulkLabel: 'Скопировать выделенные',
    available: args.available,
    scope: 'both',
    run: (rows) => void args.copy(rows),
  };
}

export function listDeleteAction<T>(args: {
  available: boolean;
  remove: (ids: string[]) => void | Promise<void>;
  getId: (row: T) => string;
}): ListActionDeclaration<T> {
  return {
    id: 'delete',
    label: 'Удалить',
    bulkLabel: 'Удалить выделенные',
    available: args.available,
    scope: 'both',
    danger: true,
    run: (rows) => void args.remove(rows.map((row) => args.getId(row))),
  };
}

export type ListContextMenuBuilderArgs<T> = {
  /** Строки, к которым открыто меню (одна или пачка). */
  rows: T[];
  /** Меню открыто на пачке выделенных строк, а не на одной. */
  bulk: boolean;
  /** Объявленные списком действия. */
  actions: Array<ListActionDeclaration<T>>;
  getId: (row: T) => string;
  /** «Выделить строку» — есть, когда список умеет выделять одиночную строку. */
  onSelect?: (id: string) => void;
  /** «Снять выделение». */
  onClearSelection?: () => void;
  /** Есть ли выделение вообще (пункт «Снять выделение» показываем только тогда). */
  hasSelection?: boolean;
};

/**
 * Собирает меню строки списка из объявленных действий.
 *
 * Правила (заказ владельца, промт #67):
 *  - недоступное действие в меню отсутствует (не гасится);
 *  - «удалить» появляется только там, где список умеет удалять и есть право;
 *  - одно объявление обслуживает и одиночную строку, и пачку (`scope`);
 *  - счётчик пачки добавляется автоматически.
 */
export function buildListContextMenuItems<T>(args: ListContextMenuBuilderArgs<T>): ListContextMenuActionItem[] {
  if (!args.rows.length) return [];
  const count = args.rows.length;
  const items: ListContextMenuActionItem[] = [];

  if (!args.bulk && args.onSelect) {
    const row = args.rows[0]!;
    items.push({ id: 'select-row', label: 'Выделить', onClick: () => args.onSelect?.(args.getId(row)) });
  }

  for (const action of args.actions) {
    if (!action.available) continue;
    const scope = action.scope ?? 'both';
    if (args.bulk ? scope === 'single' : scope === 'bulk') continue;
    const label = args.bulk
      ? `${action.bulkLabel ?? action.label} (${count})`
      : action.label;
    items.push({
      id: action.id,
      label,
      ...(action.danger ? { danger: true } : {}),
      onClick: () => void action.run(args.rows),
    });
  }

  if (args.onClearSelection && (args.hasSelection ?? count > 1)) {
    items.push({ id: 'clear-selected', label: 'Снять выделение', onClick: args.onClearSelection });
  }

  return items;
}

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

/**
 * Правый клик по полю ввода внутри строки — это НЕ меню списка.
 *
 * В списках с редактируемыми ячейками (справочник цехов, инвентаризация склада)
 * нативное меню браузера нужно оператору: вставить значение из буфера, вырезать
 * фрагмент. Если перехватить его меню списка, вставка из буфера пропадёт.
 *
 * Правило одно на программу — проверка живёт в ките, а не в каждой странице.
 */
export function isListEditingTarget(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

