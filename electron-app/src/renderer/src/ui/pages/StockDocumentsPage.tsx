import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WarehouseDocumentListItem, WarehouseDocumentType } from '@matricarmz/shared';
import { WAREHOUSE_DOCUMENT_STATUS_FILTER_ORDER } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { WarehouseDocumentStatusFilterDropdown } from '../components/WarehouseDocumentStatusFilterDropdown.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useRegisterSearchScope } from '../context/globalSearchScope.js';
import { formatListDateTime } from '../utils/dateUtils.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { listHeaderKindProps, listCellKindProps, type ListColumnKind } from '../utils/listColumnKinds.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { fetchWarehouseDocumentsAllPages } from '../utils/warehousePagedFetch.js';
import {
  lookupToSelectOptions,
  warehouseDocTypeLabel,
  warehouseDocumentStatusLabel,
  WAREHOUSE_DOC_TYPE_OPTIONS,
} from '../utils/warehouseUi.js';

const LS_STATUS_IN = 'matrica.warehouse.documents.statusIn';
const LS_HIDE_CANCELLED_LEGACY = 'matrica.warehouse.documents.hideCancelled';

function loadIncludedStatuses(): string[] {
  const order = [...WAREHOUSE_DOCUMENT_STATUS_FILTER_ORDER];
  try {
    const raw = localStorage.getItem(LS_STATUS_IN);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const allow = new Set<string>(order);
        const picked = parsed.filter((x): x is string => typeof x === 'string' && allow.has(x));
        if (picked.length > 0) return order.filter((id) => picked.includes(id));
      }
    }
    const legacyHide = localStorage.getItem(LS_HIDE_CANCELLED_LEGACY);
    if (legacyHide !== 'false') {
      return order.filter((id) => id !== 'cancelled');
    }
  } catch {
    /* noop */
  }
  return order;
}

type SortKey = 'docNo' | 'docType' | 'docDate' | 'status' | 'warehouse' | 'counterparty' | 'reason' | 'lines' | 'qty';

export function StockDocumentsPage(props: {
  defaultDocType?: string;
  canEdit: boolean;
  onOpen: (id: string) => void;
}) {
  const { lookups, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData();
  const [rows, setRows] = useState<WarehouseDocumentListItem[]>([]);
  useRegisterSearchScope(
    useMemo(
      () => ({
        kind: 'stock_document' as const,
        title: 'Складские документы',
        rows,
        getId: (r: unknown) => String((r as WarehouseDocumentListItem).id ?? ''),
        getLabel: (r: unknown) => {
          const d = r as WarehouseDocumentListItem;
          return String(d.docNo ?? '') || String(d.id ?? '');
        },
      }),
      [rows],
    ),
  );
  const [status, setStatus] = useState('');
  const [docType, setDocType] = useState<WarehouseDocumentType | ''>((props.defaultDocType as WarehouseDocumentType) ?? '');
  const [includedStatuses, setIncludedStatuses] = useState<string[]>(loadIncludedStatuses);
  const [query, setQuery] = useState('');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;
  const [sortKey, setSortKey] = useState<SortKey>('docDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function persistIncludedStatuses(next: string[]) {
    setIncludedStatuses(next);
    try {
      localStorage.setItem(LS_STATUS_IN, JSON.stringify(next));
    } catch {
      /* noop */
    }
  }

  const refresh = useCallback(async () => {
    try {
      if (includedStatuses.length === 0) {
        setRows([]);
        setStatus('');
        return;
      }
      setStatus('Загрузка документов...');
      const fetched = await fetchWarehouseDocumentsAllPages({
        ...(docType ? { docType } : {}),
        statusIn: includedStatuses,
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(fromDate ? { fromDate: new Date(`${fromDate}T00:00:00`).getTime() } : {}),
        ...(toDate ? { toDate: new Date(`${toDate}T23:59:59`).getTime() } : {}),
      });
      setRows(fetched);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [includedStatuses, docType, fromDate, query, toDate, warehouseId]);

  useEffect(() => {
    setDocType((props.defaultDocType as WarehouseDocumentType) ?? '');
  }, [props.defaultDocType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const displayRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'docNo') cmp = String(a.docNo ?? '').localeCompare(String(b.docNo ?? ''), 'ru');
      else if (sortKey === 'docType') cmp = String(a.docType ?? '').localeCompare(String(b.docType ?? ''), 'ru');
      else if (sortKey === 'docDate') cmp = Number(a.docDate ?? 0) - Number(b.docDate ?? 0);
      else if (sortKey === 'status')
        cmp = warehouseDocumentStatusLabel(String(a.status ?? '')).localeCompare(
          warehouseDocumentStatusLabel(String(b.status ?? '')),
          'ru',
        );
      else if (sortKey === 'warehouse') cmp = String(a.warehouseName ?? '').localeCompare(String(b.warehouseName ?? ''), 'ru');
      else if (sortKey === 'counterparty') cmp = String(a.counterpartyName ?? '').localeCompare(String(b.counterpartyName ?? ''), 'ru');
      else if (sortKey === 'reason') cmp = String(a.reasonLabel ?? a.reason ?? '').localeCompare(String(b.reasonLabel ?? b.reason ?? ''), 'ru');
      else if (sortKey === 'lines') cmp = Number(a.linesCount ?? 0) - Number(b.linesCount ?? 0);
      else if (sortKey === 'qty') cmp = Number(a.totalQty ?? 0) - Number(b.totalQty ?? 0);
      if (cmp === 0) cmp = String(a.docNo ?? '').localeCompare(String(b.docNo ?? ''), 'ru');
      return cmp * dir;
    });
  }, [rows, sortDir, sortKey]);

  function onSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(nextKey);
    setSortDir('asc');
  }

  function sortLabel(label: string, key: SortKey) {
    if (sortKey !== key) return label;
    return `${label} ${sortDir === 'asc' ? '↑' : '↓'}`;
  }

  type DocColumn = ColumnDescriptor & {
    sortKey: SortKey;
    kind?: ListColumnKind;
    render: (row: WarehouseDocumentListItem) => React.ReactNode;
  };
  const allColumns = useMemo<DocColumn[]>(
    () => [
      { id: 'docNo', label: 'Номер', sortKey: 'docNo', kind: 'name', render: (row) => row.docNo || '—' },
      { id: 'docType', label: 'Тип', sortKey: 'docType', render: (row) => warehouseDocTypeLabel(row.docType) },
      { id: 'docDate', label: 'Дата', sortKey: 'docDate', kind: 'date', render: (row) => (row.docDate ? formatListDateTime(Number(row.docDate)) : '—') },
      { id: 'status', label: 'Статус', sortKey: 'status', render: (row) => warehouseDocumentStatusLabel(row.status) },
      { id: 'warehouse', label: 'Склад', sortKey: 'warehouse', kind: 'name', render: (row) => row.warehouseName || row.warehouseId || '—' },
      { id: 'counterparty', label: 'Контрагент', sortKey: 'counterparty', kind: 'name', render: (row) => row.counterpartyName || '—' },
      { id: 'reason', label: 'Основание', sortKey: 'reason', kind: 'text', render: (row) => row.reasonLabel || row.reason || '—' },
      { id: 'lines', label: 'Строк', sortKey: 'lines', kind: 'num', render: (row) => Number(row.linesCount ?? 0) },
      { id: 'qty', label: 'Кол-во', sortKey: 'qty', kind: 'num', render: (row) => Number(row.totalQty ?? 0) },
    ],
    [],
  );
  const allColumnIds = useMemo(() => allColumns.map((c) => c.id), [allColumns]);
  const columnsById = useMemo(() => new Map(allColumns.map((c) => [c.id, c])), [allColumns]);
  const columnLayout = useColumnLayout('list:stock-documents:columns', allColumnIds);
  const visibleColumns = useMemo(
    () =>
      columnLayout.order
        .map((id) => columnsById.get(id))
        .filter((col): col is DocColumn => Boolean(col))
        .filter((col) => columnLayout.isVisible(col.id)),
    [columnLayout.order, columnLayout.hidden, columnsById],
  );
  const columnDescriptors = useMemo<ColumnDescriptor[]>(() => allColumns.map((c) => ({ id: c.id, label: c.label })), [allColumns]);

  function renderTableHeader() {
    return (
      <thead>
        <tr>
          {visibleColumns.map((col) => (
            <th key={col.id} {...listHeaderKindProps(col.kind, col.label)} style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort(col.sortKey)}>
              {sortLabel(col.label, col.sortKey)}
            </th>
          ))}
          <th className="list-col-filler" aria-hidden="true" />
        </tr>
      </thead>
    );
  }

  function rowProps(row: WarehouseDocumentListItem): VirtualTableRowProps {
    return {
      style: { cursor: 'pointer' },
      onClick: () => props.onOpen(String(row.id)),
    };
  }

  function renderDocCells(row: WarehouseDocumentListItem) {
    return (
      <>
        {visibleColumns.map((col) => (
          <td key={col.id} {...listCellKindProps(col.kind)}>{col.render(row)}</td>
        ))}
        <td className="list-col-filler" aria-hidden="true" />
      </>
    );
  }

  function renderTable(items: WarehouseDocumentListItem[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'clip' }}>
        <table className="list-table">
          {renderTableHeader()}
          <tbody>
            {items.map((row) => (
              <tr key={String(row.id)} {...rowProps(row)}>
                {renderDocCells(row)}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={Math.max(1, visibleColumns.length) + 1}>
                  {includedStatuses.length === 0 ? 'Выберите статусы в фильтре выше' : 'Нет документов'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'grid', gap: 8, alignItems: 'center', gridTemplateColumns: 'minmax(220px, 0.9fr) minmax(220px, 0.9fr) minmax(220px, 1fr) minmax(150px, 0.7fr) minmax(150px, 0.7fr) auto auto auto' }}>
        <select value={docType} onChange={(e) => setDocType((e.target.value || '') as WarehouseDocumentType | '')} style={{ minWidth: 220, padding: '8px 10px' }}>
          {WAREHOUSE_DOC_TYPE_OPTIONS.map((item) => (
            <option key={item.id || 'all'} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <WarehouseDocumentStatusFilterDropdown value={includedStatuses} onChange={persistIncludedStatuses} />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по номеру, основанию, складу, контрагенту..." />
        <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        <SearchSelect value={warehouseId} options={lookupToSelectOptions(lookups.warehouses)} placeholder="Склад" onChange={setWarehouseId} />
        {props.canEdit ? (
          <Button
            onClick={async () => {
              const now = Date.now();
              const type = (docType || props.defaultDocType || 'stock_receipt') as WarehouseDocumentType;
              const created = await window.matrica.warehouse.documentCreate({
                docType: type,
                docNo: `WH-${String(now).slice(-8)}`,
                docDate: now,
                header: {
                  warehouseId: warehouseId ?? 'default',
                  reason: null,
                  counterpartyId: null,
                },
                lines: [],
              });
              if (!created?.ok || !created.id) {
                setStatus(`Ошибка: ${String(!created?.ok && created ? created.error : 'не удалось создать документ')}`);
                return;
              }
              await refresh();
              props.onOpen(String(created.id));
            }}
          >
            Создать документ
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
        <Button variant="ghost" onClick={() => void refreshRefs()}>
          Справочники
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

      {includedStatuses.length === 0 ? (
        <div style={{ color: 'var(--warning, #b8860b)', fontSize: 14 }}>Отметьте хотя бы один статус в фильтре «Статусы», чтобы загрузить список.</div>
      ) : null}

      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {twoCol ? (
          <TwoColumnList items={displayRows} enabled renderColumn={(items) => renderTable(items)} />
        ) : (
          <VirtualTable
            scrollElementRef={containerRef}
            count={displayRows.length}
            header={renderTableHeader()}
            renderCells={(i) => renderDocCells(displayRows[i]!)}
            getRowKey={(i) => displayRows[i]!.id}
            getRowProps={(i) => rowProps(displayRows[i]!)}
            colCount={Math.max(1, visibleColumns.length) + 1}
            estimateSize={40}
            emptyState={includedStatuses.length === 0 ? 'Выберите статусы в фильтре выше' : 'Нет документов'}
          />
        )}
      </div>
      <div style={{ padding: '4px 0 2px', flex: '0 0 auto', fontSize: 12, color: '#9ca3af' }}>Всего: {displayRows.length}</div>
    </div>
  );
}
