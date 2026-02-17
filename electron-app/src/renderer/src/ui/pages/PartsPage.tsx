import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useStableArrayState } from '../hooks/useStableState.js';

type Row = {
  id: string;
  name?: string;
  article?: string;
  updatedAt: number;
  createdAt: number;
};
type SortKey = 'name' | 'article' | 'updatedAt';

export function PartsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const { state: listState, patchState } = useListUiState('list:parts', {
    query: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:parts');
  const query = String(listState.query ?? '');
  const [rows, setRows] = useStableArrayState<Row>([]);
  const [status, setStatus] = useState<string>('');
  const width = useWindowWidth();
  const twoCol = width >= 1400;
  const queryTimer = useRef<number | null>(null);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      if (!silent) setStatus('Загрузка…');
      const r = await window.matrica.parts.list({ ...(query.trim() ? { q: query.trim() } : {}) });
      if (!r.ok) {
        if (!silent) setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setRows(r.parts as any);
      if (!silent) setStatus('');
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (queryTimer.current) {
      window.clearTimeout(queryTimer.current);
    }
    queryTimer.current = window.setTimeout(() => {
      void refresh();
    }, 300);
    return () => {
      if (queryTimer.current) window.clearTimeout(queryTimer.current);
    };
  }, [query]);

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
      if (key === 'name') return String(row.name ?? '').toLowerCase();
      if (key === 'article') return String(row.article ?? '').toLowerCase();
      return Number(row.updatedAt ?? 0);
    },
    (row) => row.id,
  );
  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  const tableHeader = (
    <thead>
      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('name')}>
          Название {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'name')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('article')}>
          Артикул {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'article')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>
          Обновлено {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'updatedAt')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', width: 140 }}>Действия</th>
      </tr>
    </thead>
  );

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Нет деталей' : 'Не найдено'}
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr
                key={row.id}
                style={{
                  borderBottom: '1px solid #f3f4f6',
                  cursor: 'pointer',
                }}
                onClick={() => void props.onOpen(row.id)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f9fafb';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.name || '(без названия)'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.article || '—'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>
                  {row.updatedAt ? new Date(row.updatedAt).toLocaleString('ru-RU') : '—'}
                </td>
                <td style={{ padding: '10px 12px' }}>
                  {props.canDelete && (
                    <Button
                      variant="ghost"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm('Удалить деталь?')) return;
                        try {
                          setStatus('Удаление…');
                          const r = await window.matrica.parts.delete(row.id);
                          if (!r.ok) {
                            setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
                            return;
                          }
                          setStatus('Удалено');
                          setTimeout(() => setStatus(''), 900);
                          await refresh();
                        } catch (err) {
                          setStatus(`Ошибка: ${String(err)}`);
                        }
                      }}
                      style={{ color: '#b91c1c' }}
                    >
                      Удалить
                    </Button>
                  )}
                </td>
              </tr>
            ))}
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
              try {
                setStatus('Создание детали...');
                const r = await window.matrica.parts.create();
                if (!r.ok) {
                  setStatus(`Ошибка: ${r.error}`);
                  return;
                }
                // Проверка уже выполнена в partsService
                setStatus('');
                await props.onOpen(r.part.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Создать деталь
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по названию/артикулу…" />
        </div>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}

