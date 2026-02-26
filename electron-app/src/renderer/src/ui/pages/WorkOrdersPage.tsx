import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { ListColumnsToggle } from '../components/ListColumnsToggle.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { formatMoscowDate } from '../utils/dateUtils.js';

type Row = {
  id: string;
  workOrderNumber: number;
  orderDate: number;
  partName: string;
  crewCount: number;
  totalAmountRub: number;
  updatedAt: number;
};

type SortKey = 'number' | 'date' | 'part' | 'crew' | 'total' | 'updatedAt';

function rub(v: number) {
  return `${Math.round((Number(v) || 0) * 100) / 100} ₽`;
}

export function WorkOrdersPage(props: { onOpen: (id: string) => Promise<void>; canCreate: boolean; canDelete: boolean }) {
  const { state: listState, patchState } = useListUiState('list:work_orders', {
    query: '',
    month: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:work_orders');
  const query = String(listState.query ?? '');
  const month = String(listState.month ?? '');
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
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
      if (key === 'part') return String(row.partName ?? '').toLowerCase();
      if (key === 'crew') return Number(row.crewCount ?? 0);
      if (key === 'total') return Number(row.totalAmountRub ?? 0);
      return Number(row.updatedAt ?? 0);
    },
    (row) => row.id,
  );

  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
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
          Изделие {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'part')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('crew')}>
          Бригада {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'crew')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('total')}>
          Итог {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'total')}
        </th>
        {props.canDelete && <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, width: 100 }}>Действия</th>}
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
              <tr key={row.id}>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }} onClick={() => void props.onOpen(row.id)}>
                  {row.workOrderNumber}
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }} onClick={() => void props.onOpen(row.id)}>
                  {row.orderDate ? formatMoscowDate(row.orderDate) : '-'}
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }} onClick={() => void props.onOpen(row.id)}>
                  {row.partName || '-'}
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }} onClick={() => void props.onOpen(row.id)}>
                  {row.crewCount}
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }} onClick={() => void props.onOpen(row.id)}>
                  {rub(row.totalAmountRub)}
                </td>
                {props.canDelete && (
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}>
                    <Button
                      variant="ghost"
                      style={{ color: '#b91c1c' }}
                      onClick={async () => {
                        if (!confirm('Удалить наряд?')) return;
                        const r = await window.matrica.workOrders.delete(row.id);
                        if (!r.ok) {
                          alert(`Ошибка удаления: ${r.error}`);
                          return;
                        }
                        await refresh();
                      }}
                    >
                      Удалить
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={props.canDelete ? 6 : 5}>
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
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по всем данным наряда…" />
        </div>
        <div style={{ width: 180 }}>
          <Input type="month" value={month} onChange={(e) => patchState({ month: e.target.value })} />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Применить фильтр
        </Button>
        <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleColumnsMode} />
        <span style={{ color: '#6b7280', fontSize: 12 }}>Итог по списку: {rub(totalRowsAmount)}</span>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}

