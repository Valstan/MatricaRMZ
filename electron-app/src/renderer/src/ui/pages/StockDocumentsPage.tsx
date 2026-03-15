import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WarehouseDocumentListItem, WarehouseDocumentType } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { lookupToSelectOptions, warehouseDocTypeLabel, WAREHOUSE_DOC_STATUS_OPTIONS, WAREHOUSE_DOC_TYPE_OPTIONS } from '../utils/warehouseUi.js';

export function StockDocumentsPage(props: {
  defaultDocType?: string;
  canEdit: boolean;
  onOpen: (id: string) => void;
}) {
  const { lookups, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData();
  const [rows, setRows] = useState<WarehouseDocumentListItem[]>([]);
  const [status, setStatus] = useState('');
  const [docType, setDocType] = useState<WarehouseDocumentType | ''>((props.defaultDocType as WarehouseDocumentType) ?? '');
  const [docStatus, setDocStatus] = useState('');
  const [query, setQuery] = useState('');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка документов...');
      const result = await window.matrica.warehouse.documentsList({
        ...(docType ? { docType } : {}),
        ...(docStatus ? { status: docStatus } : {}),
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
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [docStatus, docType, fromDate, query, toDate, warehouseId]);

  useEffect(() => {
    setDocType((props.defaultDocType as WarehouseDocumentType) ?? '');
  }, [props.defaultDocType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = useMemo(() => [...rows].sort((a, b) => Number(b.docDate ?? 0) - Number(a.docDate ?? 0)), [rows]);

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
        <select value={docStatus} onChange={(e) => setDocStatus(e.target.value)} style={{ minWidth: 180, padding: '8px 10px' }}>
          {WAREHOUSE_DOC_STATUS_OPTIONS.map((item) => (
            <option key={item.id || 'all'} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
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

      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Номер</th>
              <th style={{ textAlign: 'left' }}>Тип</th>
              <th style={{ textAlign: 'left' }}>Дата</th>
              <th style={{ textAlign: 'left' }}>Статус</th>
              <th style={{ textAlign: 'left' }}>Склад</th>
              <th style={{ textAlign: 'left' }}>Контрагент</th>
              <th style={{ textAlign: 'left' }}>Основание</th>
              <th style={{ textAlign: 'left' }}>Строк</th>
              <th style={{ textAlign: 'left' }}>Кол-во</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 12 }}>
                  Нет документов
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(String(row.id))}>
                  <td>{row.docNo || '—'}</td>
                  <td>{warehouseDocTypeLabel(row.docType)}</td>
                  <td>{row.docDate ? new Date(Number(row.docDate)).toLocaleString('ru-RU') : '—'}</td>
                  <td>{row.status || '—'}</td>
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
