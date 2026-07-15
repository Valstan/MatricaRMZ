import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  WORK_ORDER_KIND_LABELS,
  engineInternalNumberSortKeyFromFull,
  WORK_ORDER_KIND_ORDER,
  WORK_ORDER_STATUS_LABELS,
  WorkOrderKind,
  deriveWorkOrderStatusCode,
  type WorkOrderPayload,
  type WorkOrderStatusCode,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { WorkOrderKindPickerDialog } from '../components/WorkOrderKindPickerDialog.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListSelection } from '../hooks/useListSelection.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { listHeaderKindProps, listCellKindProps, type ListColumnKind } from '../utils/listColumnKinds.js';
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
  startDate: number | null;
  workType: string;
  crewCount: number;
  performerSurnames: string;
  totalAmountRub: number;
  updatedAt: number;
  status: string;
  linkedDocumentId: string | null;
  dueDate: number | null;
  completedAt: number | null;
  completedDate: number | null;
  engineBrand: string;
  engineNumber: string;
  engineInternalNumber: string;
  acceptedByEmployeeId: string | null;
  workOrderKind: string;
  withdrawnAt: number | null;
};

/** Палитра подсветки по вычисляемому статусу наряда (Этап 3). */
const WO_STATUS_PALETTE: Record<WorkOrderStatusCode, { bg: string; fg: string; rowBg: string }> = {
  issued: { bg: '#fef3c7', fg: '#92400e', rowBg: 'rgba(252, 211, 77, 0.10)' }, // жёлтый — выдан
  done: { bg: '#dcfce7', fg: '#166534', rowBg: 'rgba(34, 197, 94, 0.08)' }, // зелёный — выполнен
  overdue: { bg: '#fee2e2', fg: '#b91c1c', rowBg: 'rgba(239, 68, 68, 0.12)' }, // красный — просрочен
  done_late: { bg: '#dcfce7', fg: '#166534', rowBg: 'rgba(34, 197, 94, 0.08)' }, // зелёный фон, дата красным
  withdrawn: { bg: '#e5e7eb', fg: '#374151', rowBg: 'rgba(107, 114, 128, 0.08)' }, // серый — отозван из работы
};

function rowStatusCode(row: Row, now: number): WorkOrderStatusCode {
  return deriveWorkOrderStatusCode({
    operationStatus: row.status,
    dueDate: row.dueDate,
    completedAt: row.completedAt,
    completedDate: row.completedDate,
    withdrawnAt: row.withdrawnAt,
    now,
  });
}

function StatusBadge({ code }: { code: WorkOrderStatusCode }) {
  const p = WO_STATUS_PALETTE[code];
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, background: p.bg, color: p.fg }}>
      {WORK_ORDER_STATUS_LABELS[code]}
    </span>
  );
}

type SortKey = 'number' | 'date' | 'start' | 'due' | 'completed' | 'part' | 'brand' | 'engineNo' | 'engineInternalNo' | 'crew' | 'performers' | 'total' | 'status' | 'updatedAt';

/** Ранг статуса для сортировки: просрочен → выдан → выполнен с опозданием → выполнен. */
const STATUS_SORT_RANK: Record<string, number> = { overdue: 0, issued: 1, withdrawn: 2, done_late: 3, done: 4 };

function rub(v: number) {
  return `${Math.round((Number(v) || 0) * 100) / 100} ₽`;
}

export function WorkOrdersPage(props: { onOpen: (id: string, opts?: { initialPayload?: WorkOrderPayload }) => Promise<void>; canCreate: boolean; canDelete: boolean; onOpenReport?: () => void }) {
  const { confirm } = useConfirm();
  const { state: listState, patchState } = useListUiState('list:work_orders', {
    query: '',
    month: '',
    typeKind: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:work_orders');
  const query = String(listState.query ?? '');
  const month = String(listState.month ?? '');
  const typeKind = String(listState.typeKind ?? '');
  const [rows, setRows] = useState<Row[]>([]);
  const [empSurnames, setEmpSurnames] = useState<Map<string, string>>(new Map());
  const [status, setStatus] = useState<string>('');
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const [kindPickerOpen, setKindPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
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

  // Сотрудники → карта id→Фамилия для колонки «Исполнители» (подписи хранят только id).
  useEffect(() => {
    let cancelled = false;
    void window.matrica.employees
      .list()
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        const map = new Map<string, string>();
        for (const e of list as Array<Record<string, unknown>>) {
          const id = String(e.id ?? '').trim();
          if (!id) continue;
          const full = String(e.displayName || e.fullName || '').trim();
          const surname = full.split(/[,\s]+/).find((p) => p.trim().length > 0) ?? full;
          if (surname) map.set(id, surname);
        }
        setEmpSurnames(map);
      })
      .catch(() => {
        /* нет прав/офлайн — колонка покажет «—» */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useLiveDataRefresh(
    useCallback(async () => {
      await refresh({ silent: true });
    }, [refresh]),
    { intervalMs: 15000 },
  );

  // Колонка «Исполнители»: фамилия того, кто «принял в работу» (нач. цеха из подписей),
  // иначе — фамилии бригады. Подписи хранят id → резолвим через карту empSurnames.
  const acceptedOrCrew = useCallback(
    (row: Row): string => {
      const accepted = empSurnames.get(row.acceptedByEmployeeId ?? '');
      return accepted && accepted.trim() ? accepted : row.performerSurnames || '';
    },
    [empSurnames],
  );

  // Инлайн-фильтр по типу наряда: чисто клиентский, поверх уже загруженного списка
  // (директива: «фильтрация прямо в текущем списке», без отдельных экранов/запросов).
  const filteredRows = useMemo(
    () => (typeKind ? rows.filter((row) => row.workOrderKind === typeKind) : rows),
    [rows, typeKind],
  );

  const sorted = useSortedItems(
    filteredRows,
    listState.sortKey as SortKey,
    listState.sortDir,
    (row, key) => {
      if (key === 'number') return Number(row.workOrderNumber ?? 0);
      if (key === 'date') return Number(row.orderDate ?? 0);
      if (key === 'start') return Number(row.startDate ?? 0);
      if (key === 'due') return Number(row.dueDate ?? 0);
      // «Завершён»: closed-дата, для незакрытых — операторская «Дата выполнения»
      // (та же пара, что рендерит колонку; иначе выполненные наряды сыпались в конец).
      if (key === 'completed') return Number(row.completedAt ?? row.completedDate ?? 0);
      if (key === 'status') return STATUS_SORT_RANK[rowStatusCode(row, Date.now())] ?? 9;
      if (key === 'part') return String(row.workType ?? '').toLowerCase();
      if (key === 'brand') return String(row.engineBrand ?? '').toLowerCase();
      if (key === 'engineNo') return String(row.engineNumber ?? '').toLowerCase();
      if (key === 'engineInternalNo') return engineInternalNumberSortKeyFromFull(row.engineInternalNumber ?? '');
      if (key === 'crew') return Number(row.crewCount ?? 0);
      if (key === 'performers') return acceptedOrCrew(row).toLowerCase();
      if (key === 'total') return Number(row.totalAmountRub ?? 0);
      return Number(row.updatedAt ?? 0);
    },
    (row) => row.id,
  );
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const displayRows = sorted;

  const selection = useListSelection(displayRows.map((row) => row.id));

  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  const contextColumns = useMemo(
    () => [
      { title: 'Дата создания', value: (row: Row) => (row.orderDate ? formatMoscowDate(row.orderDate) : '-') },
      { title: 'Номер', value: (row: Row) => String(row.workOrderNumber) },
      { title: 'Начало работ', value: (row: Row) => (row.startDate ? formatMoscowDate(row.startDate) : '-') },
      { title: 'Срок', value: (row: Row) => (row.dueDate ? formatMoscowDate(row.dueDate) : '-') },
      { title: 'Виды работ', value: (row: Row) => row.workType || '-' },
      { title: 'Марка дв.', value: (row: Row) => row.engineBrand || '-' },
      { title: '№ дв.', value: (row: Row) => row.engineNumber || '-' },
      { title: 'Внутр. №', value: (row: Row) => row.engineInternalNumber || '-' },
      { title: 'Завершён', value: (row: Row) => ((row.completedAt ?? row.completedDate) ? formatMoscowDate(Number(row.completedAt ?? row.completedDate)) : '-') },
      { title: 'Исполнители', value: (row: Row) => acceptedOrCrew(row) || '-' },
      { title: 'Статус', value: (row: Row) => WORK_ORDER_STATUS_LABELS[rowStatusCode(row, Date.now())] },
      { title: 'Итог', value: (row: Row) => rub(row.totalAmountRub) },
    ],
    [acceptedOrCrew],
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

  async function createWithKind(kind: WorkOrderKind) {
    if (creating) return;
    setKindPickerOpen(false);
    setCreating(true);
    setStatus('');
    try {
      // Phase 2 (deferred-create): create() no longer writes a row — it returns a fresh id +
      // empty payload. We open the card seeded with the chosen kind; the operations row (and the
      // number) materialize on the first save. An abandoned empty card leaves nothing behind.
      const r = await window.matrica.workOrders.create();
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      await props.onOpen(r.id, { initialPayload: { ...r.payload, workOrderKind: kind } });
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setCreating(false);
    }
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

  type WorkOrderColumn = ColumnDescriptor & {
    sortKey?: SortKey;
    width?: number;
    kind?: ListColumnKind;
    tdStyle?: React.CSSProperties;
    tdTitle?: (row: Row) => string;
    render: (row: Row) => React.ReactNode;
  };
  const allColumns = useMemo<WorkOrderColumn[]>(
    () => [
      { id: 'date', label: 'Дата создания наряда', sortKey: 'date', kind: 'date', render: (row) => (row.orderDate ? formatMoscowDate(row.orderDate) : '-') },
      { id: 'start', label: 'Начало работ', sortKey: 'start', kind: 'date', render: (row) => (row.startDate ? formatMoscowDate(row.startDate) : '-') },
      { id: 'number', label: '№ наряда', sortKey: 'number', kind: 'name', render: (row) => row.workOrderNumber },
      { id: 'due', label: 'Срок', sortKey: 'due', kind: 'date', render: (row) => (row.dueDate ? formatMoscowDate(row.dueDate) : '-') },
      { id: 'part', label: 'Виды работ', sortKey: 'part', kind: 'text', render: (row) => row.workType || '-' },
      { id: 'brand', label: 'Марка дв.', sortKey: 'brand', kind: 'text', render: (row) => row.engineBrand || '-' },
      { id: 'engineNo', label: '№ дв.', sortKey: 'engineNo', kind: 'text', render: (row) => row.engineNumber || '-' },
      {
        id: 'engineInternalNo',
        label: 'Внутр. №',
        sortKey: 'engineInternalNo',
        kind: 'text',
        render: (row) => row.engineInternalNumber || '-',
      },
      {
        id: 'completed',
        label: 'Завершён',
        sortKey: 'completed',
        kind: 'date',
        render: (row) => {
          // closed-дата, для незакрытых — «Дата выполнения» карточки (по ней статус уже
          // деривится «выполнен» — колонка была прочерком при живом бейдже статуса).
          const completed = row.completedAt ?? row.completedDate;
          if (!completed) return '-';
          const late = rowStatusCode(row, Date.now()) === 'done_late';
          return <span style={late ? { color: '#b91c1c', fontWeight: 600 } : undefined}>{formatMoscowDate(Number(completed))}</span>;
        },
      },
      { id: 'crew', label: 'Бригада', sortKey: 'crew', kind: 'num', render: (row) => row.crewCount },
      {
        id: 'performers',
        label: 'Исполнители',
        sortKey: 'performers',
        kind: 'name',
        tdStyle: { width: 200, maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        tdTitle: (row) => acceptedOrCrew(row) || '-',
        render: (row) => acceptedOrCrew(row) || '-',
      },
      { id: 'total', label: 'Итог', sortKey: 'total', kind: 'num', render: (row) => rub(row.totalAmountRub) },
      { id: 'status', label: 'Статус', sortKey: 'status', width: 150, render: (row) => <StatusBadge code={rowStatusCode(row, Date.now())} /> },
    ],
    [acceptedOrCrew],
  );
  const allColumnIds = useMemo(() => allColumns.map((c) => c.id), [allColumns]);
  const columnsById = useMemo(() => new Map(allColumns.map((c) => [c.id, c])), [allColumns]);
  const columnLayout = useColumnLayout('list:work-orders:columns', allColumnIds);
  const visibleColumns = useMemo(
    () =>
      columnLayout.order
        .map((id) => columnsById.get(id))
        .filter((col): col is WorkOrderColumn => Boolean(col))
        .filter((col) => columnLayout.isVisible(col.id)),
    [columnLayout.order, columnLayout.hidden, columnsById],
  );
  const columnDescriptors = useMemo<ColumnDescriptor[]>(() => allColumns.map((c) => ({ id: c.id, label: c.label })), [allColumns]);

  function renderTableHeader() {
    return (
      <thead>
        <tr style={{ background: 'linear-gradient(135deg, #065f46 0%, #0f766e 120%)', color: '#fff' }}>
          {visibleColumns.map((col) => (
            <th
              key={col.id}
              {...listHeaderKindProps(col.kind, col.label)}
              style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: col.sortKey ? 'pointer' : 'default', ...(col.width ? { width: col.width } : {}) }}
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
    const selected = selection.isSelected(row.id);
    const rowBg = WO_STATUS_PALETTE[rowStatusCode(row, Date.now())].rowBg;
    return {
      'data-list-selected': selected ? 'true' : undefined,
      style: { cursor: 'pointer', ...(selected ? {} : { background: rowBg }) },
      onClick: () => {
        selection.onRowPrimaryAction(row.id);
        void props.onOpen(row.id);
      },
      onContextMenu: (e) => {
        const result = selection.onRowContextMenu(e, row.id);
        if (!result.openMenu) return;
        setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
      },
    };
  }

  function renderWorkOrderCells(row: Row) {
    return (
      <>
        {visibleColumns.map((col) => (
          <td
            key={col.id}
            {...listCellKindProps(col.kind)}
            style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer', ...(col.tdStyle ?? {}) }}
            {...(col.tdTitle ? { title: col.tdTitle(row) } : {})}
          >
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
            {items.map((row) => (
              <tr key={row.id} {...rowProps(row)}>
                {renderWorkOrderCells(row)}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={Math.max(1, visibleColumns.length) + 1}>
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
            disabled={creating}
            onClick={() => setKindPickerOpen(true)}
          >
            {creating ? 'Создание…' : 'Создать наряд'}
          </Button>
        )}
        {props.onOpenReport && (
          <Button variant="ghost" onClick={() => props.onOpenReport?.()}>
            Отчёт по нарядам
          </Button>
        )}
        <div style={{ width: '50%', minWidth: 260 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по всем данным наряда…" />
        </div>
        <div style={{ width: 180 }}>
          <Input type="month" value={month} onChange={(e) => patchState({ month: e.target.value })} />
        </div>
        <div style={{ width: 180 }}>
          <select
            value={typeKind}
            onChange={(e) => patchState({ typeKind: e.target.value })}
            title="Фильтр по типу наряда — применяется сразу, поверх текущего списка"
            style={{
              width: '100%',
              height: 32,
              padding: '0 8px',
              borderRadius: 6,
              border: '1px solid var(--border, #d1d5db)',
              background: 'var(--input-bg, #fff)',
              color: 'var(--text)',
              fontSize: 13,
            }}
          >
            <option value="">Все типы</option>
            {WORK_ORDER_KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {WORK_ORDER_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Применить фильтр
        </Button>        <span style={{ color: '#6b7280', fontSize: 12 }}>Итог по списку: {rub(totalRowsAmount)}</span>
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
            renderCells={(i) => renderWorkOrderCells(displayRows[i]!)}
            getRowKey={(i) => displayRows[i]!.id}
            getRowProps={(i) => rowProps(displayRows[i]!)}
            colCount={Math.max(1, visibleColumns.length) + 1}
            estimateSize={44}
            emptyState="Ничего не найдено"
          />
        )}
      </div>
      {menu && menuItems.length > 0 ? (
        <ListContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
      <WorkOrderKindPickerDialog
        open={kindPickerOpen}
        onClose={() => setKindPickerOpen(false)}
        onPick={(kind) => {
          void createWithKind(kind);
        }}
      />
    </div>
  );
}

