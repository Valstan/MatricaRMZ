import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useStableArrayState } from '../hooks/useStableState.js';

type Row = {
  id: string;
  requestNumber: string;
  compiledAt: number;
  sentAt?: number | null;
  arrivedAt?: number | null;
  status: string;
  title: string;
  departmentId: string;
  departmentName?: string | null;
  workshopId: string | null;
  sectionId: string | null;
  updatedAt: number;
  isIncomplete?: boolean;
};
type SortKey = 'requestNumber' | 'compiledAt' | 'sentAt' | 'arrivedAt' | 'status' | 'updatedAt';

function statusLabel(s: string): string {
  switch (s) {
    case 'draft':
      return 'Черновик';
    case 'signed':
      return 'Подписана начальником цеха';
    case 'director_approved':
      return 'Одобрена директором';
    case 'accepted':
      return 'Принята к исполнению';
    case 'fulfilled_full':
      return 'Исполнена полностью';
    case 'fulfilled_partial':
      return 'Исполнена частично';
    default:
      return s;
  }
}

export function SupplyRequestsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const { state: listState, patchState } = useListUiState('list:supply_requests', {
    query: '',
    month: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:supply_requests');
  const query = String(listState.query ?? '');
  const month = String(listState.month ?? '');
  const [rows, setRows] = useStableArrayState<Row>([]);
  const [status, setStatus] = useState<string>('');
  const width = useWindowWidth();
  const twoCol = width >= 1600;

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      if (!silent) setStatus('Загрузка…');
      const r = await window.matrica.supplyRequests.list({
        ...(query.trim() ? { q: query.trim() } : {}),
        ...(month ? { month } : {}),
      });
      if (!r.ok) {
        if (!silent) setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setRows(r.requests as any);
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
      if (key === 'requestNumber') return String(row.requestNumber ?? '').toLowerCase();
      if (key === 'compiledAt') return Number(row.compiledAt ?? 0);
      if (key === 'sentAt') return Number(row.sentAt ?? 0);
      if (key === 'arrivedAt') return Number(row.arrivedAt ?? 0);
      if (key === 'status') return String(statusLabel(row.status) ?? '').toLowerCase();
      return Number(row.updatedAt ?? 0);
    },
    (row) => row.id,
  );
  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  const tableHeader = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #a21caf 0%, #7c3aed 120%)', color: '#fff' }}>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('requestNumber')}>
          Номер {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'requestNumber')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('compiledAt')}>
          Дата создания {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'compiledAt')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('sentAt')}>
          Дата отправки {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'sentAt')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('arrivedAt')}>
          Дата поступления {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'arrivedAt')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('status')}>
          Статус {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'status')}
        </th>
        {props.canDelete && (
          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, width: 100 }}>Действия</th>
        )}
      </tr>
    </thead>
  );

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.map((r) => (
              <tr key={r.id} style={{ background: r.isIncomplete ? 'rgba(239, 68, 68, 0.18)' : undefined }}>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(r.id);
                  }}
                >
                  {r.requestNumber || r.id}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(r.id);
                  }}
                >
                  {r.compiledAt ? new Date(r.compiledAt).toLocaleDateString('ru-RU') : '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(r.id);
                  }}
                >
                  {r.sentAt ? new Date(r.sentAt).toLocaleDateString('ru-RU') : '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(r.id);
                  }}
                >
                  {r.arrivedAt ? new Date(r.arrivedAt).toLocaleDateString('ru-RU') : '-'}
                </td>
                <td
                  style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer' }}
                  onClick={() => {
                    void props.onOpen(r.id);
                  }}
                >
                  {statusLabel(r.status)}
                </td>
                {props.canDelete && (
                  <td style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }} onClick={(ev) => ev.stopPropagation()}>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm('Удалить заявку?')) return;
                        const result = await window.matrica.supplyRequests.delete(r.id);
                        if (!result.ok) {
                          alert(`Ошибка удаления: ${result.error}`);
                          return;
                        }
                        void refresh();
                      }}
                      style={{ color: '#b91c1c' }}
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
        {props.canCreate && (
          <Button
            onClick={async () => {
              const r = await window.matrica.supplyRequests.create();
              if (!r.ok) {
                setStatus(`Ошибка: ${r.error}`);
                return;
              }
              await props.onOpen(r.id);
            }}
          >
            Создать закупку
          </Button>
        )}
        <div style={{ width: '50%', minWidth: 260 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по названию/тексту/товарам…" />
        </div>
        <div style={{ width: 180 }}>
          <Input type="month" value={month} onChange={(e) => patchState({ month: e.target.value })} />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Поиск
        </Button>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}


