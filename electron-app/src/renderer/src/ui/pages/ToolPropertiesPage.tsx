import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import { useListSelection } from '../hooks/useListSelection.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { matchesQueryInRecord } from '../utils/search.js';
import {
  buildCopyRowsStatus,
  buildDeleteConfirmMessage,
  buildDeleteRowsStatus,
  buildListContextMenuItems,
  copyRowsToClipboard,
  printRowsPreview,
  resolveMenuRows,
} from '../utils/listContextActions.js';

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
  const { confirm } = useConfirm();
  const { state: listState, patchState } = useListUiState('list:tool_properties', {
    query: '',
    sortKey: 'name' as SortKey,
    sortDir: 'asc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:tool_properties');
  const query = String(listState.query ?? '');
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);

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
    return rows.filter((row) => matchesQueryInRecord(query, row));
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
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const selection = useListSelection(sorted.map((row) => row.id));

  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  const contextColumns = useMemo(
    () => [
      { title: 'Название', value: (row: Row) => row.name || '(без названия)' },
      { title: 'Параметры', value: (row: Row) => row.params || '—' },
    ],
    [],
  );

  function printRows(items: Row[]) {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные свойства (${items.length})` : `Свойство: ${items[0]?.name || '(без названия)'}`,
      sectionTitle: 'Список свойств',
      rows: items,
      columns: contextColumns,
    });
  }

  async function copyRows(items: Row[]) {
    await copyRowsToClipboard(items, contextColumns);
    setStatus(buildCopyRowsStatus(items.length));
  }

  async function deleteRows(ids: string[]) {
    if (!props.canDelete || ids.length === 0) return;
    const message = buildDeleteConfirmMessage({
      selectedCount: ids.length,
      selectedManyLabel: 'выделенные свойства',
      singleLabel: 'свойство',
    });
    const ok = await confirm({ detail: `${message}\n\nСвойства инструмента будут удалены из справочника.` });
    if (!ok) return;
    let failed = 0;
    for (const id of ids) {
      const r = await window.matrica.tools.properties.delete(id);
      if (!r.ok) failed += 1;
    }
    setStatus(
      buildDeleteRowsStatus({
        failedCount: failed,
        deletedCount: ids.length,
        deletedManyLabel: 'свойств',
      }),
    );
    selection.clearSelection();
    await refresh();
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
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по всем данным свойства…" />
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
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={2} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                    {rows.length === 0 ? 'Нет свойств' : 'Не найдено'}
                  </td>
                </tr>
              )}
              {sorted.map((row) => (
                <tr
                  key={row.id}
                  data-list-selected={selection.isSelected(row.id) ? 'true' : undefined}
                  style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                  onContextMenu={(e) => {
                    const result = selection.onRowContextMenu(e, row.id);
                    if (!result.openMenu) return;
                    setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
                  }}
                  onClick={() => {
                    selection.onRowPrimaryAction(row.id);
                    void props.onOpen(row.id);
                  }}
                >
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.name || '(без названия)'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.params || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {menu ? (
        <ListContextMenu
          x={menu.x}
          y={menu.y}
          items={buildListContextMenuItems({
            rows: resolveMenuRows(menu.targetIds, rowById),
            bulk: menu.bulk,
            canDelete: props.canDelete,
            getId: (row) => row.id,
            onSelect: selection.toggleSelect,
            onPrint: printRows,
            onCopy: copyRows,
            onDelete: deleteRows,
            onClearSelection: selection.clearSelection,
          })}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
