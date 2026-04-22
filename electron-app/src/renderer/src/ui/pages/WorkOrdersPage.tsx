import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { ListColumnsToggle } from '../components/ListColumnsToggle.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListSelection } from '../hooks/useListSelection.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import {
  buildDeleteConfirmMessage,
  buildCopyRowsStatus,
  buildDeleteRowsStatus,
  buildListContextMenuItems,
  copyRowsToClipboard,
  printRowsPreview,
  resolveMenuRows,
} from '../utils/listContextActions.js';

type Row = {
  id: string;
  workOrderNumber: number;
  orderDate: number;
  workType: string;
  crewCount: number;
  performerSurnames: string;
  totalAmountRub: number;
  updatedAt: number;
};

type SortKey = 'number' | 'date' | 'part' | 'crew' | 'performers' | 'total' | 'updatedAt';

function rub(v: number) {
  return `${Math.round((Number(v) || 0) * 100) / 100} ₽`;
}

export function WorkOrdersPage(props: { onOpen: (id: string) => Promise<void>; canCreate: boolean; canDelete: boolean }) {
  const { confirm } = useConfirm();
  const { state: listState, patchState } = useListUiState('list:work_orders', {
    query: '',
    month: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
    pageSize: 50 as WarehouseListPageSize,
    pageIndex: 0,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:work_orders');
  const query = String(listState.query ?? '');
  const month = String(listState.month ?? '');
  const pageSize = Number(listState.pageSize ?? 50) as WarehouseListPageSize;
  const pageIndex = Math.max(0, Number(listState.pageIndex ?? 0) || 0);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const width = useWindowWidth();
  const { isMultiColumn, toggle: toggleColumnsMode } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1600;

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      if (!silent) setStatus('Загрузка…');
      const r = await window.matrica.workOrders.list({
        ...(query.trim() ? { q: query.trim() } : {}),
        ...(month ? { month } : {}),
      });
      if (!r.ok) {
        if (!silent) setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setRows(r.rows as Row[]);
      if (!silent) setStatus('');
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, [month, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useLiveDataRefresh(
    useCallback(async () => {
      await refresh({ silent: true });
    }, [refresh]),
    { intervalMs: 15000 },
  );

  const sorted = useSortedItems(
    rows,
    listState.sortKey as SortKey,
    listState.sortDir,
    (row, key) => {
      if (key === 'number') return Number(row.workOrderNumber ?? 0);
      if (key === 'date') return Number(row.orderDate ?? 0);
      if (key === 'part') return String(row.workType ?? '').toLowerCase();
      if (key === 'crew') return Number(row.crewCount ?? 0);
      if (key === 'performers') return String(row.performerSurnames ?? '').toLowerCase();
      if (key === 'total') return Number(row.totalAmountRub ?? 0);
      return Number(row.updatedAt ?? 0);
    },
    (row) => row.id,
  );
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const paged = useMemo(() => {
    const start = pageIndex * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [pageIndex, pageSize, sorted]);
  const selection = useListSelection(paged.map((row) => row.id));

  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  const contextColumns = useMemo(
    () => [
      { title: 'Номер', value: (row: Row) => String(row.workOrderNumber) },
      { title: 'Дата', value: (row: Row) => (row.orderDate ? formatMoscowDate(row.orderDate) : '-') },
      { title: 'Виды работ', value: (row: Row) => row.workType || '-' },
      { title: 'Бригада', value: (row: Row) => String(row.crewCount) },
      { title: 'Исполнители', value: (row: Row) => row.performerSurnames || '-' },
      { title: 'Итог', value: (row: Row) => rub(row.totalAmountRub) },
    ],
    [],
  );

  function printRows(items: Row[]) {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные наряды (${items.length})` : `Наряд №${items[0]?.workOrderNumber ?? '-'}`,
      sectionTitle: 'Список нарядов',
      rows: items,
      columns: contextColumns,
    });
  }

  async function copyRows(items: Row[]) {
    await copyRowsToClipboard(items, contextColumns);
    setStatus(buildCopyRowsStatus(items.length));
  }

  async function deleteRows(ids: string[]) {
    if (!props.canDelete) return;
    if (!ids.length) return;
    const message = buildDeleteConfirmMessage({
      selectedCount: ids.length,
      selectedManyLabel: 'выбранные наряды',
      singleLabel: 'наряд',
    });
    const ok = await confirm({ detail: `${message}\n\nЭто действие обычно нельзя отменить.` });
    if (!ok) return;
    const failed: string[] = [];
    for (const id of ids) {
      const r = await window.matrica.workOrders.delete(id);
      if (!r.ok) failed.push(`${id}: ${r.error}`);
    }
    setStatus(
      buildDeleteRowsStatus({
        failedCount: failed.length,
        deletedCount: ids.length,
        deletedManyLabel: 'документов',
      }),
    );
    selection.clearSelection();
    await refresh();
  }

  const tableHeader = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #065f46 0%, #0f766e 120%)', color: '#fff' }}>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('number')}>
          № наряда {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'number')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('date')}>
          Дата {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'date')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('part')}>
          Виды работ {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'part')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('crew')}>
          Бригада {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'crew')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('performers')}>
          Исполнители {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'performers')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('total')}>
          Итог {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'total')}
        </th>
      </tr>
    </thead>
  );

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.map((row) => (
              <tr
                key={row.id}
                data-list-selected={selection.isSelected(row.id) ? 'true' : undefined}
                onContextMenu={(e) => {
                  const result = selection.onRowContextMenu(e, row.id);
                  if (!result.openMenu) return;
                  setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
                }}
              >
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    selection.onRowPrimaryAction(row.id);
                    void props.onOpen(row.id);
                  }}
                >
                  {row.workOrderNumber}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    selection.onRowPrimaryAction(row.id);
                    void props.onOpen(row.id);
                  }}
                >
                  {row.orderDate ? formatMoscowDate(row.orderDate) : '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    selection.onRowPrimaryAction(row.id);
                    void props.onOpen(row.id);
                  }}
                >
                  {row.workType || '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    selection.onRowPrimaryAction(row.id);
                    void props.onOpen(row.id);
                  }}
                >
                  {row.crewCount}
                </td>
                <td
                  style={{
                    borderBottom: '1px solid #f3f4f6',
                    padding: 8,
                    cursor: 'pointer',
                    width: 220,
                    maxWidth: 220,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  onClick={() => {
                    selection.onRowPrimaryAction(row.id);
                    void props.onOpen(row.id);
                  }}
                  title={row.performerSurnames || '-'}
                >
                  {row.performerSurnames || '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    selection.onRowPrimaryAction(row.id);
                    void props.onOpen(row.id);
                  }}
                >
                  {rub(row.totalAmountRub)}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={6}>
                  Ничего не найдено
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  const totalRowsAmount = useMemo(() => rows.reduce((acc, row) => acc + Number(row.totalAmountRub ?? 0), 0), [rows]);
  const menuRows = useMemo(() => (menu ? resolveMenuRows(menu.targetIds, rowById) : []), [menu, rowById]);
  const menuItems = useMemo(() => {
    if (!menu) return [];
    return buildListContextMenuItems({
      rows: menuRows,
      bulk: menu.bulk,
      canDelete: props.canDelete,
      getId: (row) => row.id,
      onSelect: selection.toggleSelect,
      onPrint: printRows,
      onCopy: copyRows,
      onDelete: deleteRows,
      onClearSelection: selection.clearSelection,
    });
  }, [menu, menuRows, props.canDelete, selection, printRows, copyRows, deleteRows]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
        {props.canCreate && (
          <Button
            onClick={async () => {
              const r = await window.matrica.workOrders.create();
              if (!r.ok) {
                setStatus(`Ошибка: ${r.error}`);
                return;
              }
              await props.onOpen(r.id);
            }}
          >
            Создать наряд
          </Button>
        )}
        <div style={{ width: '50%', minWidth: 260 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value, pageIndex: 0 })} placeholder="Поиск по всем данным наряда…" />
        </div>
        <div style={{ width: 180 }}>
          <Input type="month" value={month} onChange={(e) => patchState({ month: e.target.value, pageIndex: 0 })} />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Применить фильтр
        </Button>
        <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleColumnsMode} />
        <span style={{ color: '#6b7280', fontSize: 12 }}>Итог по списку: {rub(totalRowsAmount)}</span>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}
      <WarehouseListPager
        pageSize={pageSize}
        onPageSizeChange={(size) => patchState({ pageSize: size, pageIndex: 0 })}
        pageIndex={pageIndex}
        onPageIndexChange={(index) => patchState({ pageIndex: index })}
        rowCount={paged.length}
        totalCount={sorted.length}
      />

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={paged} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
      {menu && menuItems.length > 0 ? (
        <ListContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}

