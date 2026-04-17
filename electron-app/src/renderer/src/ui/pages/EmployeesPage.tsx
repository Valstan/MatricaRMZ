import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import { ListRowThumbs } from '../components/ListRowThumbs.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { ListColumnsToggle } from '../components/ListColumnsToggle.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
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
  const pageSize = Number(listState.pageSize ?? 50) as WarehouseListPageSize;
  const pageIndex = Math.max(0, Number(listState.pageIndex ?? 0) || 0);
  const showPreviews = listState.showPreviews !== false;
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const width = useWindowWidth();
  const { isMultiColumn, toggle: toggleColumnsMode } = useListColumnsMode();
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

  useLiveDataRefresh(
    useCallback(async () => {
      await refresh({ silent: true });
    }, [refresh]),
    { intervalMs: 15000 },
  );

  const filtered = useMemo(() => {
    return rows.filter((row) =>
      matchesQueryInRecord(query, row, [
        String(row.employmentStatus ?? '').toLowerCase() === 'fired' ? 'уволен' : 'работает',
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
      case 'employmentStatus': {
        const status = String(row.employmentStatus ?? '').toLowerCase();
        return status === 'fired' ? 'уволен' : status ? status : 'работает';
      }
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
  const paged = useMemo(() => {
    const start = pageIndex * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [pageIndex, pageSize, sorted]);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const selection = useListSelection(paged.map((row) => row.id));

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

  const tableHeader = (
    <thead>
      <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
        <th style={headerCellStyle}>{renderSortLabel('Сотрудник', 'displayName')}</th>
        <th style={headerCellStyle}>{renderSortLabel('Должность', 'position')}</th>
        <th style={headerCellStyle}>{renderSortLabel('Подразделение', 'departmentName')}</th>
        <th style={headerCellStyle}>{renderSortLabel('Статус', 'employmentStatus')}</th>
        <th style={headerCellStyle}>{renderSortLabel('Доступ', 'access')}</th>
        {showPreviews && <th style={{ ...headerCellStyle, width: 220, textAlign: 'right' }}>Превью</th>}
      </tr>
    </thead>
  );

  const contextColumns = useMemo(
    () => [
      { title: 'Сотрудник', value: (row: Row) => row.displayName || '(без ФИО)' },
      { title: 'Должность', value: (row: Row) => row.position || '—' },
      { title: 'Подразделение', value: (row: Row) => row.departmentName || '—' },
      {
        title: 'Статус',
        value: (row: Row) => {
          const status = String(row.employmentStatus ?? '').toLowerCase();
          return status === 'fired' ? 'уволен' : status || 'работает';
        },
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
    if (!confirm(message)) return;
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
  }, [props.canDelete, refresh, selection]);

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={showPreviews ? 6 : 5} style={{ padding: '16px 12px', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
                  {rows.length === 0 ? 'Нет сотрудников' : 'Не найдено'}
                </td>
              </tr>
            )}
            {items.map((row) => {
              const status = String(row.employmentStatus ?? '').toLowerCase();
              const statusLabel = status === 'fired' ? 'уволен' : status ? status : 'работает';
              const accessState = row.accessEnabled;
              const accessLabel = accessState === true ? formatAccessRole(row.systemRole) : 'запрещено';
              const accessColor = accessState === true ? '#065f46' : '#b91c1c';
              const deleteRequested = !!row.deleteRequestedAt;
              return (
                <tr
                  key={row.id}
                  data-list-selected={selection.isSelected(row.id) ? 'true' : undefined}
                  style={{
                    borderBottom: '1px solid #f3f4f6',
                    cursor: 'pointer',
                  }}
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
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#111827' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span>{row.displayName || '(без ФИО)'}</span>
                      {deleteRequested && (
                        <span
                          style={{
                            fontSize: 11,
                            padding: '2px 6px',
                            borderRadius: 999,
                            background: '#fef3c7',
                            color: '#92400e',
                            border: '1px solid #fde68a',
                          }}
                        >
                          на удаление
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.position || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{row.departmentName || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: '#6b7280' }}>{statusLabel}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: accessColor }}>
                    {accessLabel}
                  </td>
                  {showPreviews && (
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <ListRowThumbs files={row.attachmentPreviews ?? []} />
                    </td>
                  )}
                </tr>
              );
            })}
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
        <Button variant="ghost" onClick={() => patchState({ showPreviews: !showPreviews })}>
          {showPreviews ? 'Отключить превью' : 'Включить превью'}
        </Button>
        <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleColumnsMode} />
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
