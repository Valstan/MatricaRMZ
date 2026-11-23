import { useMemo, useState } from 'react';
import type React from 'react';

import type { ListContextMenuItem } from '../../components/ListContextMenu.js';
import { useListBehaviorSettings } from '../../hooks/useListBehaviorSettings.js';
import { useListSelection } from '../../hooks/useListSelection.js';
import {
  buildListContextMenuItems,
  buildCopyRowsStatus,
  copyRowsToClipboard,
  listCopyAction,
  listPrintAction,
  resolveMenuRows,
  type ListActionDeclaration,
  type ListContextColumn,
} from '../../utils/listContextActions.js';
import { reactNodeToText } from '../../utils/listPrintColumns.js';

/**
 * Общая обвязка отчётных списков — кита «Списки по одним правилам» (промт КАРМАНА #67, D-248).
 *
 * Три отчёта-списка («Двигатели», «Сейчас на заводе», «Этапы работ») устроены одинаково:
 * панель ступеней, группировка, виртуализированная таблица. Правила поведения (выделение,
 * контур, меню) должны быть у них **одни и те же** — иначе «везде одинаково» снова
 * разъедется по копиям. Поэтому китовые куски живут здесь, а страница даёт только свои
 * данные: строки и колонки.
 *
 * Сам кит (`useListSelection`, `useListBehaviorSettings`, `ListLassoLayer`,
 * `utils/listContextActions.ts`) не трогаем — он общий на всю программу.
 */

/** Колонка отчёта в виде, который нужен киту: подпись и текст ячейки. */
export type ReportListColumn<T> = {
  id: string;
  label: string;
  render: (row: T) => React.ReactNode;
  /** Явный текст ячейки, если из разметки он получается плохим. */
  printValue?: (row: T) => string;
};

/** Состояние открытого контекстного меню. */
export type ReportListMenuState = {
  x: number;
  y: number;
  /** Строки, к которым открыто меню: одна или вся пачка выделенных. */
  targetIds: string[];
  bulk: boolean;
};

/**
 * Колонки для копирования в буфер — те же, что на экране: иначе оператор копирует одно,
 * а видит другое. Текст берётся из того же `render`, что и печать.
 */
export function buildReportContextColumns<T>(columns: readonly ReportListColumn<T>[]): ListContextColumn<T>[] {
  return columns.map((col) => ({
    title: col.label,
    value: (row: T) => (col.printValue ? col.printValue(row) : reactNodeToText(col.render(row))),
  }));
}

/**
 * Действия отчётного списка — **объявление**, а не шаблон (промт КАРМАНА #67).
 *
 * Отчёт — список ДЛЯ ЧТЕНИЯ: удалять в нём нечего, поэтому пункта «Удалить» здесь нет
 * ВООБЩЕ, а не гаснет серым. Гаснущий пункт читался бы как «умеет, но запрещено» — это
 * враньё списка о самом себе.
 */
export function buildReportListActions<T>(args: {
  contextColumns: ListContextColumn<T>[];
  onPrint: (rows: T[]) => void;
  onStatus?: (text: string) => void;
}): ListActionDeclaration<T>[] {
  return [
    listPrintAction<T>({ available: true, print: (printRows) => args.onPrint(printRows) }),
    listCopyAction<T>({
      available: true,
      copy: async (copyRows) => {
        await copyRowsToClipboard(copyRows, args.contextColumns);
        args.onStatus?.(buildCopyRowsStatus(copyRows.length));
      },
    }),
  ];
}

export function useReportListKit<T extends { id: string }>(args: {
  /** Строки списка БЕЗ заголовков групп: заголовок группы не строка и не выделяется. */
  rows: readonly T[];
  /** Колонки отчёта — из них собираются колонки для копирования в буфер. */
  columns: readonly ReportListColumn<T>[];
  /** Печать из меню: страница открывает свой диалог печати с этими строками. */
  onPrint: (rows: T[]) => void;
  /** Показать оператору строку-отклик (например «Скопировано строк: 3»). */
  onStatus?: (text: string) => void;
}) {
  const { rows, columns, onPrint, onStatus } = args;
  const [menu, setMenu] = useState<ReportListMenuState | null>(null);

  // Правила поведения списков — из общего источника (D-248), без частных настроек страницы.
  const listBehavior = useListBehaviorSettings();

  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selection = useListSelection(rowIds);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const selectedRows = useMemo(
    () => rows.filter((row) => selection.selectedIds.has(row.id)),
    [rows, selection.selectedIds],
  );

  /**
   * Колонки для копирования в буфер — те же, что на экране.
   */
  const contextColumns = useMemo(() => buildReportContextColumns(columns), [columns]);

  const menuRows = useMemo(() => (menu ? resolveMenuRows(menu.targetIds, rowById) : []), [menu, rowById]);

  const menuItems = useMemo<ListContextMenuItem[]>(() => {
    if (!menu) return [];
    return buildListContextMenuItems({
      rows: menuRows,
      bulk: menu.bulk,
      getId: (row) => row.id,
      onSelect: selection.toggleSelect,
      onClearSelection: selection.clearSelection,
      hasSelection: selection.selectedCount > 0,
      actions: buildReportListActions<T>({
        contextColumns,
        onPrint,
        // `exactOptionalPropertyTypes`: undefined во optional-поле не пишем — Conditional spread.
        ...(onStatus ? { onStatus } : {}),
      }),
    });
  }, [menu, menuRows, selection, contextColumns, onPrint, onStatus]);

  /** Правый клик по строке: Shift — переключить выделение, обычный — открыть меню. */
  const onRowContextMenu = (e: React.MouseEvent<HTMLTableRowElement>, id: string) => {
    const result = selection.onRowContextMenu(e, id);
    if (!result.openMenu) return;
    setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
  };

  return {
    selection,
    listBehavior,
    menu,
    menuItems,
    setMenu,
    onRowContextMenu,
    selectedRows,
    contextColumns,
  };
}
