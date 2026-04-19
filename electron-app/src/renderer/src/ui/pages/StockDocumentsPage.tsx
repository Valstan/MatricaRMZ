import React, { useCallback, useEffect, useState } from 'react';
import type { WarehouseDocumentListItem, WarehouseDocumentType } from '@matricarmz/shared';
import { WAREHOUSE_DOCUMENT_STATUS_FILTER_ORDER } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { WarehouseDocumentStatusFilterDropdown } from '../components/WarehouseDocumentStatusFilterDropdown.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
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
  const [status, setStatus] = useState('');
  const [docType, setDocType] = useState<WarehouseDocumentType | ''>((props.defaultDocType as WarehouseDocumentType) ?? '');
  const [includedStatuses, setIncludedStatuses] = useState<string[]>(loadIncludedStatuses);
  const [query, setQuery] = useState('');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
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

  useEffect(() => {
    setPageIndex(0);
  }, [includedStatuses, docType, fromDate, query, toDate, warehouseId]);

  const refresh = useCallback(async () => {
    try {
      if (includedStatuses.length === 0) {
        setRows([]);
        setHasMore(false);
        setStatus('');
        return;
      }
      setStatus('Загрузка документов...');
      const result = await window.matrica.warehouse.documentsList({
        limit: pageSize,
        offset: pageIndex * pageSize,
        ...(docType ? { docType } : {}),
        statusIn: includedStatuses,
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(fromDate ? { fromDate: new Date(`${fromDate}T00:00:00`).getTime() } : {}),
        ...(toDate ? { toDate: new Date(`${toDate}T23:59:59`).getTime() } : {}),
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setRows((result.rows ?? []) as WarehouseDocumentListItem[]);
      setHasMore(Boolean(result.hasMore));
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [includedStatuses, docType, fromDate, pageIndex, pageSize, query, toDate, warehouseId]);

  useEffect(() => {
    setDocType((props.defaultDocType as WarehouseDocumentType) ?? '');
  }, [props.defaultDocType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const displayRows = React.useMemo(() => {
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
      </div>

      {includedStatuses.length === 0 ? (
        <div style={{ color: 'var(--warning, #b8860b)', fontSize: 14 }}>Отметьте хотя бы один статус в фильтре «Статусы», чтобы загрузить список.</div>
      ) : null}

      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <WarehouseListPager
        pageSize={pageSize}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPageIndex(0);
        }}
        pageIndex={pageIndex}
        onPageIndexChange={setPageIndex}
        rowCount={rows.length}
        hasMore={hasMore}
        disabled={status === 'Загрузка документов...' || includedStatuses.length === 0}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('docNo')}>{sortLabel('Номер', 'docNo')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('docType')}>{sortLabel('Тип', 'docType')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('docDate')}>{sortLabel('Дата', 'docDate')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('status')}>{sortLabel('Статус', 'status')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('warehouse')}>{sortLabel('Склад', 'warehouse')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('counterparty')}>{sortLabel('Контрагент', 'counterparty')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('reason')}>{sortLabel('Основание', 'reason')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('lines')}>{sortLabel('Строк', 'lines')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('qty')}>{sortLabel('Кол-во', 'qty')}</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 12 }}>
                  {includedStatuses.length === 0 ? 'Выберите статусы в фильтре выше' : 'Нет документов'}
                </td>
              </tr>
            ) : (
              displayRows.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(String(row.id))}>
                  <td>{row.docNo || '—'}</td>
                  <td>{warehouseDocTypeLabel(row.docType)}</td>
                  <td>{row.docDate ? new Date(Number(row.docDate)).toLocaleString('ru-RU') : '—'}</td>
                  <td>{warehouseDocumentStatusLabel(row.status)}</td>
                  <td>{row.warehouseName || row.warehouseId || '—'}</td>
                  <td>{row.counterpartyName || '—'}</td>
                  <td>{row.reasonLabel || row.reason || '—'}</td>
                  <td>{Number(row.linesCount ?? 0)}</td>
                  <td>{Number(row.totalQty ?? 0)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
