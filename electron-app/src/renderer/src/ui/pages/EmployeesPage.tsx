import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { formatEmploymentStatusAttrForUi } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import { ListSearchBar } from '../components/ListSearchBar.js';
import { useListDeepFilter } from '../hooks/useListDeepFilter.js';
import { ListRowThumbs } from '../components/ListRowThumbs.js';
import { type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { useListSelection } from '../hooks/useListSelection.js';
import { useListUiState, usePersistedScrollTop } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
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
  position?: string | null;
  departmentName?: string | null;
  employmentStatus?: string | null;
  accessEnabled?: boolean;
  systemRole?: string | null;
  deleteRequestedAt?: number | null;
  deleteRequestedById?: string | null;
  deleteRequestedByUsername?: string | null;
  personnelNumber?: string | null;
  updatedAt: number;
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
};

type SortKey = 'displayName' | 'position' | 'departmentName' | 'employmentStatus' | 'access' | 'updatedAt';

function formatAccessRole(role: string | null | undefined) {
  const normalized = String(role ?? '').trim().toLowerCase();
  if (!normalized) return 'Пользователь';
  if (normalized === 'superadmin') return 'Суперадминистратор';
  if (normalized === 'admin') return 'Администратор';
  if (normalized === 'employee') return 'Сотрудник';
  if (normalized === 'pending') return 'Ожидает подтверждения';
  if (normalized === 'user') return 'Пользователь';
  return normalized;
}

export function EmployeesPage(props: { onOpen: (id: string) => Promise<void>; canCreate: boolean; canDelete: boolean; refreshKey?: number }) {
  const { confirm } = useConfirm();
  const { state: listState, patchState } = useListUiState('list:employees', {
    query: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
    showPreviews: true,
    pageSize: 50 as WarehouseListPageSize,
    pageIndex: 0,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:employees');
  const query = String(listState.query ?? '');
  const showPreviews = listState.showPreviews !== false;
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const [workshops, setWorkshops] = useState<Array<{ id: string; label: string }>>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignWorkshopId, setAssignWorkshopId] = useState('');
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      if (!silent) setStatus('Загрузка…');
      const list = await window.matrica.employees.list();
      setRows(list as any);
      if (!silent) setStatus('');
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [props.refreshKey, refresh]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await window.matrica.workshops.list();
        const wrows = r && (r as any).ok && Array.isArray((r as any).rows) ? (r as any).rows : [];
        const opts = (wrows as any[]).map((w) => ({ id: String(w.id), label: String(w.name ?? w.id) }));
        opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setWorkshops(opts);
      } catch {
        // список цехов не критичен для страницы
      }
    })();
  }, []);

  useLiveDataRefresh(
    useCallback(async () => {
      await refresh({ silent: true });
    }, [refresh]),
    { intervalMs: 15000 },
  );

  const filtered = useMemo(() => {
    return rows.filter((row) =>
      matchesQueryInRecord(query, row, [
        formatEmploymentStatusAttrForUi(row.employmentStatus),
        row.accessEnabled === true ? formatAccessRole(row.systemRole) : 'запрещено',
      ]),
    );
  }, [rows, query]);
  const sortKey = listState.sortKey as SortKey;
  const sortDir = listState.sortDir as 'asc' | 'desc';

  const sortValue = (row: Row, key: SortKey) => {
    switch (key) {
      case 'displayName':
        return String(row.displayName ?? '').toLowerCase();
      case 'position':
        return String(row.position ?? '').toLowerCase();
      case 'departmentName':
        return String(row.departmentName ?? '').toLowerCase();
      case 'employmentStatus':
        return formatEmploymentStatusAttrForUi(row.employmentStatus);
      case 'access':
        return row.accessEnabled === true ? formatAccessRole(row.systemRole).toLowerCase() : 'запрещено';
      case 'updatedAt':
        return Number(row.updatedAt ?? 0);
      default:
        return String(row.displayName ?? '').toLowerCase();
    }
  };

  const sorted = useMemo(() => {
    const sortKey = listState.sortKey as SortKey;
    const sortDir = listState.sortDir as 'asc' | 'desc';
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (typeof av === 'number' && typeof bv === 'number') {
        if (av === bv) return a.id.localeCompare(b.id, 'ru') * dir;
        return av > bv ? dir : -dir;
      }
      const as = String(av ?? '');
      const bs = String(bv ?? '');
      if (as === bs) return a.id.localeCompare(b.id, 'ru') * dir;
      return as.localeCompare(bs, 'ru') * dir;
    });
  }, [filtered, listState.sortDir, listState.sortKey]);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  // Нижний поиск: фильтрует отображённый список, заглядывая и внутрь карточек (EAV).
  const getRowId = useCallback((row: Row) => String(row.id), []);
  const getRowLabel = useCallback((row: Row) => String(row.displayName ?? ''), []);
  const bottomFilter = useListDeepFilter(sorted, getRowId, getRowLabel);
  const displayRows = bottomFilter.filtered;

  const selection = useListSelection(displayRows.map((row) => row.id));

  const headerCellStyle: React.CSSProperties = {
    padding: '10px 12px',
    textAlign: 'left',
    fontWeight: 700,
    fontSize: 14,
    color: '#374151',
    position: 'sticky',
    top: 0,
    background: '#f9fafb',
    zIndex: 1,
  };

  const headerButtonStyle: React.CSSProperties = {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    padding: 0,
    margin: 0,
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
  };

  const renderSortLabel = (label: string, key: SortKey) => {
    const active = sortKey === key;
    const suffix = active ? (sortDir === 'asc' ? ' ^' : ' v') : '';
    return (
      <button
        type="button"
        style={headerButtonStyle}
        onClick={() => {
          if (active) {
            patchState({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' });
            return;
          }
          patchState({ sortKey: key, sortDir: 'asc' });
        }}
      >
        {label}
        {suffix}
      </button>
    );
  };

  type EmployeeColumn = ColumnDescriptor & {
    sortKey?: SortKey;
    cellAlign?: 'left' | 'right';
    width?: number;
    kind?: ListColumnKind;
    requireShowPreviews?: boolean;
    render: (row: Row) => React.ReactNode;
  };
  const allColumns = useMemo<EmployeeColumn[]>(
    () => [
      {
        id: 'displayName',
        label: 'Сотрудник',
        sortKey: 'displayName',
        kind: 'name',
        render: (row) => (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827' }}>
            <span>{row.displayName || '(без ФИО)'}</span>
            {row.deleteRequestedAt ? (
              <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 999, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                на удаление
              </span>
            ) : null}
          </div>
        ),
      },
      { id: 'position', label: 'Должность', sortKey: 'position', kind: 'name', render: (row) => row.position || '—' },
      { id: 'departmentName', label: 'Подразделение', sortKey: 'departmentName', kind: 'name', render: (row) => row.departmentName || '—' },
      { id: 'employmentStatus', label: 'Статус', sortKey: 'employmentStatus', kind: 'flag', render: (row) => formatEmploymentStatusAttrForUi(row.employmentStatus) },
      {
        id: 'access',
        label: 'Доступ',
        sortKey: 'access',
        kind: 'flag',
        render: (row) => (
          <span style={{ color: row.accessEnabled === true ? '#065f46' : '#b91c1c' }}>
            {row.accessEnabled === true ? formatAccessRole(row.systemRole) : 'запрещено'}
          </span>
        ),
      },
      { id: 'previews', label: 'Превью', cellAlign: 'right', kind: 'thumbs', requireShowPreviews: true, render: (row) => <ListRowThumbs files={row.attachmentPreviews ?? []} /> },
    ],
    [],
  );
  const allColumnIds = useMemo(() => allColumns.map((c) => c.id), [allColumns]);
  const columnsById = useMemo(() => new Map(allColumns.map((c) => [c.id, c])), [allColumns]);
  const columnLayout = useColumnLayout('list:employees:columns', allColumnIds);
  const visibleColumns = useMemo(
    () =>
      columnLayout.order
        .map((id) => columnsById.get(id))
        .filter((col): col is EmployeeColumn => Boolean(col))
        .filter((col) => columnLayout.isVisible(col.id))
        .filter((col) => !col.requireShowPreviews || showPreviews),
    [columnLayout.order, columnLayout.hidden, columnsById, showPreviews],
  );
  const columnDescriptors = useMemo<ColumnDescriptor[]>(() => allColumns.map((c) => ({ id: c.id, label: c.label })), [allColumns]);

  function renderTableHeader() {
    return (
      <thead>
        <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
          {visibleColumns.map((col) => (
            <th key={col.id} {...listHeaderKindProps(col.kind, col.label)} style={col.width ? { ...headerCellStyle, width: col.width, textAlign: col.cellAlign ?? 'left' } : headerCellStyle}>
              {col.sortKey ? renderSortLabel(col.label, col.sortKey) : col.label}
            </th>
          ))}
          <th className="list-col-filler" aria-hidden="true" />
        </tr>
      </thead>
    );
  }

  const contextColumns = useMemo(
    () => [
      { title: 'Сотрудник', value: (row: Row) => row.displayName || '(без ФИО)' },
      { title: 'Должность', value: (row: Row) => row.position || '—' },
      { title: 'Подразделение', value: (row: Row) => row.departmentName || '—' },
      {
        title: 'Статус',
        value: (row: Row) => formatEmploymentStatusAttrForUi(row.employmentStatus),
      },
      {
        title: 'Доступ',
        value: (row: Row) => (row.accessEnabled === true ? formatAccessRole(row.systemRole) : 'запрещено'),
      },
    ],
    [],
  );

  const printRows = useCallback((items: Row[]) => {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные сотрудники (${items.length})` : `Сотрудник: ${items[0]?.displayName || '(без ФИО)'}`,
      sectionTitle: 'Список сотрудников',
      rows: items,
      columns: contextColumns,
    });
  }, [contextColumns]);

  const copyRows = useCallback(async (items: Row[]) => {
    await copyRowsToClipboard(items, contextColumns);
    setStatus(buildCopyRowsStatus(items.length));
  }, [contextColumns]);

  const deleteRows = useCallback(async (ids: string[]) => {
    if (!props.canDelete || ids.length === 0) return;
    const message = buildDeleteConfirmMessage({
      selectedCount: ids.length,
      selectedManyLabel: 'выделенных сотрудников',
      singleLabel: 'сотрудника',
    });
    const ok = await confirm({ detail: `${message}\n\nЭто действие обычно нельзя отменить.` });
    if (!ok) return;
    let failed = 0;
    for (const id of ids) {
      const r = await window.matrica.employees.delete(id);
      if (!r.ok) failed += 1;
    }
    setStatus(
      buildDeleteRowsStatus({
        failedCount: failed,
        deletedCount: ids.length,
        deletedManyLabel: 'сотрудников',
      }),
    );
    selection.clearSelection();
    await refresh();
  }, [confirm, props.canDelete, refresh, selection]);

  const assignWorkshopToSelected = useCallback(async () => {
    const ids = Array.from(selection.selectedIds);
    if (!props.canCreate || ids.length === 0) return;
    setStatus(`Назначение цеха (${ids.length})…`);
    let failed = 0;
    for (const id of ids) {
      const r = await window.matrica.employees.setAttr(id, 'workshop_id', assignWorkshopId || null);
      if (!r.ok) failed += 1;
    }
    setStatus(failed ? `Готово, ошибок: ${failed} из ${ids.length}` : `Цех назначен: ${ids.length}`);
    setAssignOpen(false);
    selection.clearSelection();
    await refresh();
  }, [assignWorkshopId, props.canCreate, refresh, selection]);

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

  function renderEmployeeCells(row: Row) {
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
                  {rows.length === 0 ? 'Нет сотрудников' : 'Не найдено'}
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr key={row.id} {...rowProps(row)}>
                {renderEmployeeCells(row)}
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
                setStatus('Создание сотрудника...');
                const r = await window.matrica.employees.create();
                if (!r.ok) {
                  setStatus(`Ошибка: ${r.error}`);
                  return;
                }
                setStatus('');
                await props.onOpen(r.id);
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Создать сотрудника
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value, pageIndex: 0 })} placeholder="Поиск по всем данным сотрудника…" />
        </div>
        {props.canCreate && selection.selectedCount > 0 && (
          <Button variant="ghost" onClick={() => { setAssignWorkshopId(''); setAssignOpen(true); }}>
            Назначить цех ({selection.selectedCount})
          </Button>
        )}
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
          <TwoColumnList items={displayRows} enabled renderColumn={(items) => renderTable(items)} />
        ) : (
          <VirtualTable
            scrollElementRef={containerRef}
            count={displayRows.length}
            header={renderTableHeader()}
            renderCells={(i) => renderEmployeeCells(displayRows[i]!)}
            getRowKey={(i) => displayRows[i]!.id}
            getRowProps={(i) => rowProps(displayRows[i]!)}
            colCount={Math.max(1, visibleColumns.length) + 1}
            estimateSize={showPreviews ? 56 : 44}
            emptyState={rows.length === 0 ? 'Нет сотрудников' : 'Не найдено'}
          />
        )}
      </div>
      <div style={{ flex: '0 0 auto' }}>
        <ListSearchBar
          query={bottomFilter.query}
          onQueryChange={bottomFilter.setQuery}
          matched={bottomFilter.matched}
          total={bottomFilter.total}
          placeholder="Поиск в списке сотрудников (и внутри карточек)…"
        />
      </div>
      {assignOpen ? (
        <div onClick={() => setAssignOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 16, width: 380, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <strong>Назначить цех выбранным ({selection.selectedCount})</strong>
            <select
              value={assignWorkshopId}
              onChange={(e) => setAssignWorkshopId(e.target.value)}
              style={{ height: 34, padding: '4px 8px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff' }}
            >
              <option value="">— Очистить цех —</option>
              {workshops.map((w) => (<option key={w.id} value={w.id}>{w.label}</option>))}
            </select>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setAssignOpen(false)}>Отмена</Button>
              <Button variant="primary" onClick={() => void assignWorkshopToSelected()}>Применить</Button>
            </div>
          </div>
        </div>
      ) : null}
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
