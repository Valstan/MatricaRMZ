import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { ListColumnsToggle } from '../components/ListColumnsToggle.js';
import { useListSelection } from '../hooks/useListSelection.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';
import {
  buildCopyRowsStatus,
  buildDeleteConfirmMessage,
  buildDeleteRowsStatus,
  buildListContextMenuItems,
  copyRowsToClipboard,
  printRowsPreview,
  resolveMenuRows,
} from '../utils/listContextActions.js';
import { matchesQueryInRecord } from '../utils/search.js';

type Row = {
  id: string;
  displayName?: string;
  searchText?: string;
  updatedAt: number;
};
type SortKey = 'displayName' | 'updatedAt';

export function ProductsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
  canViewMasterData: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const { state: listState, patchState } = useListUiState('list:products', {
    query: '',
    sortKey: 'displayName' as SortKey,
    sortDir: 'asc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:products');
  const query = String(listState.query ?? '');
  const [typeId, setTypeId] = useState<string>('');
  const width = useWindowWidth();
  const { isMultiColumn, toggle: toggleColumnsMode } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;

  async function loadType() {
    if (!props.canViewMasterData) return;
    const types = await window.matrica.admin.entityTypes.list();
    const type = (types as any[]).find((t) => String(t.code) === 'product');
    setTypeId(type?.id ? String(type.id) : '');
  }

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!props.canViewMasterData) return;
    if (!typeId) {
      if (!silent) setStatus('Справочник товаров не найден (product).');
      setRows([]);
      return;
    }
    try {
      if (!silent) setStatus('Загрузка…');
      const list = await window.matrica.admin.entities.listByEntityType(typeId);
      setRows(list as any);
      if (!silent) setStatus('');
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.canViewMasterData, typeId]);

  useEffect(() => {
    void loadType();
  }, [props.canViewMasterData]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useLiveDataRefresh(
    useCallback(async () => {
      await refresh({ silent: true });
    }, [refresh]),
    { enabled: !!typeId && props.canViewMasterData, intervalMs: 15000 },
  );

  const filtered = useMemo(() => {
    return rows.filter((row) => matchesQueryInRecord(query, row));
  }, [rows, query]);

  const sorted = useSortedItems(
    filtered,
    listState.sortKey as SortKey,
    listState.sortDir,
    (row, key) => (key === 'updatedAt' ? Number(row.updatedAt ?? 0) : String(row.displayName ?? '').toLowerCase()),
    (row) => row.id,
  );
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const selection = useListSelection(sorted.map((row) => row.id));
  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  const contextColumns = useMemo(
    () => [
      { title: 'Название', value: (row: Row) => row.displayName || '(без названия)' },
      { title: 'Обновлено', value: (row: Row) => (row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—') },
    ],
    [],
  );

  function printRows(items: Row[]) {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные товары (${items.length})` : `Товар: ${items[0]?.displayName || '(без названия)'}`,
      sectionTitle: 'Список товаров',
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
      selectedManyLabel: 'выделенные товары',
      singleLabel: 'товар',
    });
    if (!confirm(message)) return;
    let failed = 0;
    for (const id of ids) {
      const r = await window.matrica.admin.entities.softDelete(id);
      if (!r.ok) failed += 1;
    }
    setStatus(
      buildDeleteRowsStatus({
        failedCount: failed,
        deletedCount: ids.length,
        deletedManyLabel: 'товаров',
      }),
    );
    selection.clearSelection();
    await refresh();
  }

  const tableHeader = (
    <thead>
      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('displayName')}>
          Название {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'displayName')}
        </th>
        <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>
          Обновлено {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'updatedAt')}
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
            {items.length === 0 && (
              <tr>
                <td colSpan={2} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Нет товаров' : 'Не найдено'}
                </td>
              </tr>
            )}
            {items.map((row) => (
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
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f9fafb';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>{row.displayName || '(без названия)'}</td>
                <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>
                  {row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—'}
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
              if (!typeId) return;
              try {
                setStatus('Создание товара...');
                const created = await window.matrica.admin.entities.create(typeId);
                if (!created?.ok || !created.id) {
                  setStatus('Ошибка: не удалось создать товар');
                  return;
                }
                await window.matrica.admin.entities.setAttr(created.id, 'name', 'Новый товар');
                setStatus('');
                await refresh();
                await props.onOpen(created.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Добавить товар
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по всем данным товара…" />
        </div>
        <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleColumnsMode} />
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
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
