import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import { ListRowThumbs } from '../components/ListRowThumbs.js';
import { type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { useListSelection } from '../hooks/useListSelection.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
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
import { listHeaderKindProps, listCellKindProps, type ListColumnKind } from '../utils/listColumnKinds.js';

type Row = {
  id: string;
  displayName?: string;
  searchText?: string;
  inn?: string;
  updatedAt: number;
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
};
type SortKey = 'displayName' | 'inn' | 'updatedAt';

function toAttachmentPreviews(raw: unknown): Array<{ id: string; name: string; mime: string | null }> {
  if (!Array.isArray(raw)) return [];
  const previews: Array<{ id: string; name: string; mime: string | null }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.isObsolete === true) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!id || !name) continue;
    const mime = typeof entry.mime === 'string' ? entry.mime : null;
    previews.push({ id, name, mime });
    if (previews.length >= 5) break;
  }
  return previews;
}

function collectAttachmentPreviews(attrs: Record<string, unknown>): Array<{ id: string; name: string; mime: string | null }> {
  const out: Array<{ id: string; name: string; mime: string | null }> = [];
  const seen = new Set<string>();
  for (const value of Object.values(attrs)) {
    for (const preview of toAttachmentPreviews(value)) {
      if (seen.has(preview.id)) continue;
      seen.add(preview.id);
      out.push(preview);
      if (out.length >= 5) return out;
    }
  }
  return out;
}

export function CounterpartiesPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
  canViewMasterData: boolean;
}) {
  const { confirm } = useConfirm();
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const { state: listState, patchState } = useListUiState('list:counterparties', {
    query: '',
    sortKey: 'displayName' as SortKey,
    sortDir: 'asc' as const,
    showPreviews: true,
    pageSize: 50 as WarehouseListPageSize,
    pageIndex: 0,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:counterparties');
  const query = String(listState.query ?? '');
  const showPreviews = listState.showPreviews !== false;
  const [typeId, setTypeId] = useState<string>('');
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;

  async function loadType() {
    if (!props.canViewMasterData) return;
    const types = await window.matrica.admin.entityTypes.list();
    const type = (types as any[]).find((t) => String(t.code) === 'customer');
    setTypeId(type?.id ? String(type.id) : '');
  }

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!props.canViewMasterData) return;
    if (!typeId) {
      if (!silent) setStatus('Справочник контрагентов не найден (customer).');
      setRows([]);
      return;
    }
    try {
      if (!silent) setStatus('Загрузка…');
      const list = await window.matrica.admin.entities.listByEntityType(typeId);
      const baseRows = list as any[];
      const details = await Promise.all(
        baseRows.map((r) => window.matrica.admin.entities.get(String(r.id)).catch(() => null)),
      );
      const enriched: Row[] = baseRows.map((r, idx) => {
        const attrs = (details[idx] as any)?.attributes ?? {};
        const inn = typeof attrs.inn === 'string' ? attrs.inn : attrs.inn == null ? '' : String(attrs.inn);
        const attachmentPreviews = collectAttachmentPreviews(attrs);
        return {
          id: String(r.id),
          displayName: r.displayName ? String(r.displayName) : '',
          searchText: r.searchText ? String(r.searchText) : '',
          inn: inn.trim() || undefined,
          updatedAt: Number(r.updatedAt ?? 0),
          ...(attachmentPreviews.length > 0 ? { attachmentPreviews } : {}),
        };
      });
      setRows(enriched);
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
    (row, key) => {
      if (key === 'inn') return String(row.inn ?? '').toLowerCase();
      if (key === 'updatedAt') return Number(row.updatedAt ?? 0);
      return String(row.displayName ?? '').toLowerCase();
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
      { title: 'Название', value: (row: Row) => row.displayName || '(без названия)' },
      { title: 'ИНН', value: (row: Row) => row.inn || '—' },
      { title: 'Обновлено', value: (row: Row) => (row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—') },
    ],
    [],
  );

  function printRows(items: Row[]) {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные контрагенты (${items.length})` : `Контрагент: ${items[0]?.displayName || '(без названия)'}`,
      sectionTitle: 'Список контрагентов',
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
      selectedManyLabel: 'выделенных контрагентов',
      singleLabel: 'контрагента',
    });
    const ok = await confirm({ detail: `${message}\n\nКарточки будут помечены удалёнными (soft delete).` });
    if (!ok) return;
    let failed = 0;
    for (const id of ids) {
      const r = await window.matrica.admin.entities.softDelete(id);
      if (!r.ok) failed += 1;
    }
    setStatus(
      buildDeleteRowsStatus({
        failedCount: failed,
        deletedCount: ids.length,
        deletedManyLabel: 'контрагентов',
      }),
    );
    selection.clearSelection();
    await refresh();
  }

  type CounterpartyColumn = ColumnDescriptor & {
    sortKey?: SortKey;
    cellAlign?: 'left' | 'right';
    width?: number;
    kind?: ListColumnKind;
    requireShowPreviews?: boolean;
    render: (row: Row) => React.ReactNode;
  };
  const allColumns = useMemo<CounterpartyColumn[]>(
    () => [
      { id: 'displayName', label: 'Название', sortKey: 'displayName', kind: 'name', render: (row) => <span style={{ color: '#111827' }}>{row.displayName || '(без названия)'}</span> },
      { id: 'inn', label: 'ИНН', sortKey: 'inn', kind: 'name', render: (row) => row.inn || '—' },
      { id: 'updatedAt', label: 'Обновлено', sortKey: 'updatedAt', kind: 'date', render: (row) => (row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—') },
      { id: 'previews', label: 'Превью', cellAlign: 'right', kind: 'thumbs', requireShowPreviews: true, render: (row) => <ListRowThumbs files={row.attachmentPreviews ?? []} /> },
    ],
    [],
  );
  const allColumnIds = useMemo(() => allColumns.map((c) => c.id), [allColumns]);
  const columnsById = useMemo(() => new Map(allColumns.map((c) => [c.id, c])), [allColumns]);
  const columnLayout = useColumnLayout('list:counterparties:columns', allColumnIds);
  const visibleColumns = useMemo(
    () =>
      columnLayout.order
        .map((id) => columnsById.get(id))
        .filter((col): col is CounterpartyColumn => Boolean(col))
        .filter((col) => columnLayout.isVisible(col.id))
        .filter((col) => !col.requireShowPreviews || showPreviews),
    [columnLayout.order, columnLayout.hidden, columnsById, showPreviews],
  );
  const columnDescriptors = useMemo<ColumnDescriptor[]>(() => allColumns.map((c) => ({ id: c.id, label: c.label })), [allColumns]);

  function renderTableHeader() {
    return (
      <thead>
        <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
          {visibleColumns.map((col) => (
            <th
              key={col.id}
              {...listHeaderKindProps(col.kind, col.label)}
              style={{ padding: '10px 12px', textAlign: col.cellAlign ?? 'left', fontWeight: 700, fontSize: 14, color: '#374151', cursor: col.sortKey ? 'pointer' : 'default', ...(col.width ? { width: col.width } : {}) }}
              onClick={col.sortKey ? () => onSort(col.sortKey as SortKey) : undefined}
            >
              {col.label}
              {col.sortKey ? ` ${sortArrow(listState.sortKey as SortKey, listState.sortDir, col.sortKey)}` : ''}
            </th>
          ))}
          <th className="list-col-filler" aria-hidden="true" />
        </tr>
      </thead>
    );
  }

  function rowProps(row: Row): VirtualTableRowProps {
    return {
      'data-list-selected': selection.isSelected(row.id) ? 'true' : undefined,
      style: { borderBottom: '1px solid #f3f4f6', cursor: 'pointer' },
      onContextMenu: (e) => {
        const result = selection.onRowContextMenu(e, row.id);
        if (!result.openMenu) return;
        setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
      },
      onClick: () => {
        selection.onRowPrimaryAction(row.id);
        void props.onOpen(row.id);
      },
      onMouseEnter: (e) => {
        e.currentTarget.style.backgroundColor = '#f9fafb';
      },
      onMouseLeave: (e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
      },
    };
  }

  function renderCounterpartyCells(row: Row) {
    return (
      <>
        {visibleColumns.map((col) => (
          <td key={col.id} {...listCellKindProps(col.kind)} style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280', textAlign: col.cellAlign ?? 'left' }}>
            {col.render(row)}
          </td>
        ))}
        <td className="list-col-filler" aria-hidden="true" />
      </>
    );
  }

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'clip' }}>
        <table className="list-table">
          {renderTableHeader()}
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={Math.max(1, visibleColumns.length) + 1} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Нет контрагентов' : 'Не найдено'}
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr key={row.id} {...rowProps(row)}>
                {renderCounterpartyCells(row)}
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
                // Deferred-create: open an empty card on a client id; the row is materialized on
                // the first save (CounterpartyDetailsPage passes fallbackTypeId). Opened and
                // abandoned → nothing persisted, no empty ghost synced to everyone.
                await props.onOpen(crypto.randomUUID());
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Добавить контрагента
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value, pageIndex: 0 })} placeholder="Поиск по всем данным контрагента…" />
        </div>
        <Button variant="ghost" onClick={() => patchState({ showPreviews: !showPreviews })}>
          {showPreviews ? 'Отключить превью' : 'Включить превью'}
        </Button>
        <ColumnSettingsButton
          columns={columnDescriptors}
          order={columnLayout.order}
          isVisible={columnLayout.isVisible}
          onToggleVisible={columnLayout.setVisible}
          onMove={columnLayout.moveColumn}
          onReset={columnLayout.resetToDefault}
        />
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}
      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        {twoCol ? (
          <TwoColumnList items={sorted} enabled renderColumn={(items) => renderTable(items)} />
        ) : (
          <VirtualTable
            scrollElementRef={containerRef}
            count={sorted.length}
            header={renderTableHeader()}
            renderCells={(i) => renderCounterpartyCells(sorted[i]!)}
            getRowKey={(i) => sorted[i]!.id}
            getRowProps={(i) => rowProps(sorted[i]!)}
            colCount={Math.max(1, visibleColumns.length)}
            estimateSize={showPreviews ? 52 : 44}
            emptyState={rows.length === 0 ? 'Нет контрагентов' : 'Не найдено'}
          />
        )}
      </div>
      <div style={{ padding: '4px 0 2px', flex: '0 0 auto', fontSize: 12, color: '#9ca3af' }}>Всего: {sorted.length}</div>
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
