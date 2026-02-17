import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';

type Row = {
  id: string;
  name?: string;
  params?: string;
  updatedAt: number;
};
type SortKey = 'name' | 'params' | 'updatedAt';

export function ToolPropertiesPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const { state: listState, patchState } = useListUiState('list:tool_properties', {
    query: '',
    sortKey: 'name' as SortKey,
    sortDir: 'asc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:tool_properties');
  const query = String(listState.query ?? '');
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      if (!silent) setStatus('Загрузка…');
      const r = await window.matrica.tools.properties.list();
      if (!r.ok) {
        if (!silent) setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setRows((r as any).items ?? []);
      if (!silent) setStatus('');
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useLiveDataRefresh(
    useCallback(async () => {
      await refresh({ silent: true });
    }, [refresh]),
    { intervalMs: 15000 },
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => `${r.name ?? ''} ${r.params ?? ''}`.toLowerCase().includes(q));
  }, [rows, query]);

  const sorted = useSortedItems(
    filtered,
    listState.sortKey as SortKey,
    listState.sortDir,
    (row, key) => {
      if (key === 'params') return String(row.params ?? '').toLowerCase();
      if (key === 'updatedAt') return Number(row.updatedAt ?? 0);
      return String(row.name ?? '').toLowerCase();
    },
    (row) => row.id,
  );

  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto', flexWrap: 'wrap' }}>
        {props.canCreate && (
          <Button
            onClick={async () => {
              try {
                setStatus('Создание свойства...');
                const r = await window.matrica.tools.properties.create();
                if (!r.ok) {
                  setStatus(`Ошибка: ${r.error}`);
                  return;
                }
                setStatus('');
                await props.onOpen((r as any).id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Добавить свойство
          </Button>
        )}
        <div style={{ flex: 1, minWidth: 220 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по названию/параметрам…" />
        </div>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
          <table className="list-table list-table--catalog">
            <thead>
              <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('name')}>
                  Название {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'name')}
                </th>
                <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('params')}>
                  Параметры {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'params')}
                </th>
                <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', width: 140 }}>
                  Действия
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                    {rows.length === 0 ? 'Нет свойств' : 'Не найдено'}
                  </td>
                </tr>
              )}
              {sorted.map((row) => (
                <tr
                  key={row.id}
                  style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                  onClick={() => void props.onOpen(row.id)}
                >
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.name || '(без названия)'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.params || '—'}</td>
                  <td style={{ padding: '10px 12px' }}>
                    {props.canDelete && (
                      <Button
                        variant="ghost"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!confirm('Удалить свойство?')) return;
                          setStatus('Удаление…');
                          const r = await window.matrica.tools.properties.delete(row.id);
                          if (!r.ok) {
                            setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
                            return;
                          }
                          setStatus('Удалено');
                          setTimeout(() => setStatus(''), 900);
                          await refresh();
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
      </div>
    </div>
  );
}
