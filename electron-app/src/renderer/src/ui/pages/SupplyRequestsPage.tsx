import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { SupplyRequestPayload } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { Input } from '../components/Input.js';
import { ListRowThumbs } from '../components/ListRowThumbs.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { listHeaderKindProps, listCellKindProps, type ListColumnKind } from '../utils/listColumnKinds.js';

type Row = {
  id: string;
  requestNumber: string;
  compiledAt: number;
  sentAt?: number | null;
  arrivedAt?: number | null;
  status: string;
  title: string;
  itemsCount: number;
  departmentId: string;
  departmentName?: string | null;
  workshopId: string | null;
  sectionId: string | null;
  updatedAt: number;
  isIncomplete?: boolean;
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
};
type SortKey = 'requestNumber' | 'itemsCount' | 'compiledAt' | 'sentAt' | 'arrivedAt' | 'status' | 'updatedAt';

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
  onOpen: (id: string, opts?: { initialPayload?: SupplyRequestPayload }) => Promise<void>;
  canCreate: boolean;
}) {
  const { state: listState, patchState } = useListUiState('list:supply_requests', {
    query: '',
    month: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
    showPreviews: true,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:supply_requests');
  const query = String(listState.query ?? '');
  const month = String(listState.month ?? '');
  const showPreviews = listState.showPreviews !== false;
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1600;

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
      if (key === 'itemsCount') return Number(row.itemsCount ?? 0);
      if (key === 'compiledAt') return Number(row.compiledAt ?? 0);
      if (key === 'sentAt') return Number(row.sentAt ?? 0);
      if (key === 'arrivedAt') return Number(row.arrivedAt ?? 0);
      if (key === 'status') return String(statusLabel(row.status) ?? '').toLowerCase();
      return Number(row.updatedAt ?? 0);
    },
    (row) => row.id,
  );
  const displayRows = sorted;

  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  type RequestColumn = ColumnDescriptor & {
    sortKey?: SortKey;
    cellAlign?: 'left' | 'right';
    width?: number;
    kind?: ListColumnKind;
    requireShowPreviews?: boolean;
    render: (r: Row) => React.ReactNode;
  };
  const allColumns = useMemo<RequestColumn[]>(
    () => [
      { id: 'requestNumber', label: 'Номер', sortKey: 'requestNumber', kind: 'name', render: (r) => r.requestNumber || r.id },
      { id: 'title', label: 'Описание заявки', kind: 'text', render: (r) => r.title || '-' },
      { id: 'itemsCount', label: 'Кол-во пунктов', sortKey: 'itemsCount', kind: 'num', render: (r) => r.itemsCount },
      { id: 'compiledAt', label: 'Дата создания', sortKey: 'compiledAt', kind: 'date', render: (r) => (r.compiledAt ? formatMoscowDate(r.compiledAt) : '-') },
      { id: 'sentAt', label: 'Дата отправки', sortKey: 'sentAt', kind: 'date', render: (r) => (r.sentAt ? formatMoscowDate(r.sentAt) : '-') },
      { id: 'arrivedAt', label: 'Дата поступления', sortKey: 'arrivedAt', kind: 'date', render: (r) => (r.arrivedAt ? formatMoscowDate(r.arrivedAt) : '-') },
      { id: 'status', label: 'Статус', sortKey: 'status', render: (r) => statusLabel(r.status) },
      { id: 'previews', label: 'Превью', cellAlign: 'right', kind: 'thumbs', requireShowPreviews: true, render: (r) => <ListRowThumbs files={r.attachmentPreviews ?? []} /> },
    ],
    [],
  );
  const allColumnIds = useMemo(() => allColumns.map((c) => c.id), [allColumns]);
  const columnsById = useMemo(() => new Map(allColumns.map((c) => [c.id, c])), [allColumns]);
  const columnLayout = useColumnLayout('list:supply-requests:columns', allColumnIds);
  const visibleColumns = useMemo(
    () =>
      columnLayout.order
        .map((id) => columnsById.get(id))
        .filter((col): col is RequestColumn => Boolean(col))
        .filter((col) => columnLayout.isVisible(col.id))
        .filter((col) => !col.requireShowPreviews || showPreviews),
    [columnLayout.order, columnLayout.hidden, columnsById, showPreviews],
  );
  const columnDescriptors = useMemo<ColumnDescriptor[]>(() => allColumns.map((c) => ({ id: c.id, label: c.label })), [allColumns]);

  function renderTableHeader() {
    return (
      <thead>
        <tr style={{ background: 'linear-gradient(135deg, #a21caf 0%, #7c3aed 120%)', color: '#fff' }}>
          {visibleColumns.map((col) => (
            <th
              key={col.id}
              {...listHeaderKindProps(col.kind, col.label)}
              style={{ textAlign: col.cellAlign ?? 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: col.sortKey ? 'pointer' : 'default', ...(col.width ? { width: col.width } : {}) }}
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

  function renderRequestCells(r: Row) {
    return (
      <>
        {visibleColumns.map((col) => (
          <td key={col.id} {...listCellKindProps(col.kind)} style={{ borderBottom: '1px solid #f3f4f6', padding: 8, cursor: 'pointer', textAlign: col.cellAlign ?? 'left' }}>
            {col.render(r)}
          </td>
        ))}
        <td className="list-col-filler" aria-hidden="true" />
      </>
    );
  }

  function rowProps(r: Row): VirtualTableRowProps {
    return {
      onClick: () => void props.onOpen(r.id),
      style: { cursor: 'pointer', ...(r.isIncomplete ? { background: 'rgba(239, 68, 68, 0.18)' } : {}) },
    };
  }

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'clip' }}>
        <table className="list-table">
          {renderTableHeader()}
          <tbody>
            {items.map((r) => (
              <tr key={r.id} {...rowProps(r)}>
                {renderRequestCells(r)}
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
        {props.canCreate && (
          <Button
            onClick={async () => {
              // Phase 2 (deferred-create): create() no longer writes a row — open the card seeded
              // with the empty payload; the row + number materialize on the first save.
              const r = await window.matrica.supplyRequests.create();
              if (!r.ok) {
                setStatus(`Ошибка: ${r.error}`);
                return;
              }
              await props.onOpen(r.id, { initialPayload: r.payload });
            }}
          >
            Создать закупку
          </Button>
        )}
        <div style={{ width: '50%', minWidth: 260 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по всем данным заявки…" />
        </div>
        <div style={{ width: 180 }}>
          <Input type="month" value={month} onChange={(e) => patchState({ month: e.target.value })} />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Применить фильтр
        </Button>
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
            renderCells={(i) => renderRequestCells(displayRows[i]!)}
            getRowKey={(i) => displayRows[i]!.id}
            getRowProps={(i) => rowProps(displayRows[i]!)}
            colCount={Math.max(1, visibleColumns.length) + 1}
            estimateSize={48}
            emptyState="Ничего не найдено"
          />
        )}
      </div>
    </div>
  );
}


