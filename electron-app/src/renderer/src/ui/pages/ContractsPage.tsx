import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { parseContractSections, type ContractSections } from '@matricarmz/shared';

const MONTH_1_DAYS = 30;
const MONTH_3_DAYS = 92;
const MONTH_6_DAYS = 183;

type Row = {
  id: string;
  number: string;
  internalNumber: string;
  counterparty: string;
  dateMs: number | null;
  dueDateMs: number | null;
  contractAmount: number;
  updatedAt: number;
  daysLeft: number | null;
};
type SortKey = 'number' | 'internalNumber' | 'counterparty' | 'dateMs' | 'dueDateMs' | 'amount' | 'updatedAt';

function normalize(s: string) {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function sumMoneyItems(items: unknown[]) {
  return items.reduce((acc, row) => {
    if (!row || typeof row !== 'object') return acc;
    const rowObj = row as Record<string, unknown>;
    const qty = Number(rowObj.qty);
    const unitPrice = Number(rowObj.unitPrice);
    if (!Number.isFinite(qty) || !Number.isFinite(unitPrice)) return acc;
    return acc + qty * unitPrice;
  }, 0);
}

function getContractAmount(sections: ContractSections): number {
  let total = 0;
  total += sumMoneyItems(sections.primary.engineBrands as unknown[]);
  total += sumMoneyItems(sections.primary.parts as unknown[]);
  for (const addon of sections.addons) {
    total += sumMoneyItems(addon.engineBrands as unknown[]);
    total += sumMoneyItems(addon.parts as unknown[]);
  }
  return total;
}

function getContractDueAt(sections: ContractSections): number | null {
  let dueAt: number | null = sections.primary.dueAt;
  for (const addon of sections.addons) {
    if (addon.dueAt != null && (dueAt == null || addon.dueAt > dueAt)) dueAt = addon.dueAt;
  }
  return dueAt;
}

function getContractUrgencyStyle(daysLeft: number | null) {
  if (daysLeft == null) return {};
  if (daysLeft < 0) return { backgroundColor: 'rgba(239, 68, 68, 0.8)', color: '#fff' };
  if (daysLeft < MONTH_1_DAYS) return { backgroundColor: 'rgba(253, 242, 248, 0.9)' };
  if (daysLeft < MONTH_3_DAYS) return { backgroundColor: 'rgba(254, 240, 138, 0.9)' };
  if (daysLeft > MONTH_6_DAYS) return { backgroundColor: 'rgba(220, 252, 231, 0.9)' };
  return {};
}

export function ContractsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const { state: listState, patchState } = useListUiState('list:contracts', {
    query: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:contracts');
  const query = String(listState.query ?? '');
  const [contractTypeId, setContractTypeId] = useState<string>('');
  const width = useWindowWidth();
  const twoCol = width >= 1400;

  const loadContracts = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      if (!silent) setStatus('Загрузка…');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'contract') ?? null;
      if (!type?.id) {
        setContractTypeId('');
        setRows([]);
        setStatus('Справочник «Контракты» не найден (contract).');
        return;
      }
      setContractTypeId(String(type.id));
      const listRaw = await window.matrica.admin.entities.listByEntityType(String(type.id));
      if (!Array.isArray(listRaw) || listRaw.length === 0) {
        setRows([]);
        setStatus('');
        return;
      }

      const customerType = (types as any[]).find((t) => String(t.code) === 'customer') ?? null;
      const customerRows =
        customerType?.id != null ? await window.matrica.admin.entities.listByEntityType(String(customerType.id)).catch(() => []) : [];
      const customerById = new Map<string, string>();
      for (const row of customerRows) {
        if (!row?.id) continue;
        customerById.set(String(row.id), String(row.displayName ?? String(row.id).slice(0, 8)));
      }

      const enginesRes = await window.matrica.engines.list().catch(() => []);
      const engines = Array.isArray(enginesRes) ? enginesRes : [];
      const partsRes = await window.matrica.parts.list({ limit: 5000 }).catch(() => ({ ok: false, parts: [] }));
      const parts = partsRes?.ok && partsRes.parts ? partsRes.parts : [];


      const details = await Promise.all(
        (listRaw as any[]).map(async (row: any) => {
          try {
            const d = await window.matrica.admin.entities.get(String(row.id));
            const attrs = (d as any).attributes ?? {};
            const sections = parseContractSections(attrs);
            const numberRaw = (sections.primary.number || attrs.number) ?? row.displayName ?? '';
            const internalRaw = (sections.primary.internalNumber || attrs.internal_number) ?? '';
            const dateMs = sections.primary.signedAt ?? (typeof attrs.date === 'number' ? Number(attrs.date) : null);
            const dueDateMs = getContractDueAt(sections);
            const daysLeft = dueDateMs != null ? Math.ceil((dueDateMs - Date.now()) / (24 * 60 * 60 * 1000)) : null;

            const contractAmount = getContractAmount(sections);
            const counterparty = sections.primary.customerId ? customerById.get(sections.primary.customerId) ?? sections.primary.customerId : '—';

            return {
              id: String(row.id),
              number: numberRaw == null ? '' : String(numberRaw),
              internalNumber: internalRaw == null ? '' : String(internalRaw),
              counterparty,
              dueDateMs,
              contractAmount,
              dateMs,
              updatedAt: Number(row.updatedAt ?? 0),
              daysLeft,
            };
          } catch {
            return {
              id: String(row.id),
              number: row.displayName ? String(row.displayName) : String(row.id).slice(0, 8),
              internalNumber: '',
              counterparty: '—',
              dueDateMs: null,
              contractAmount: 0,
              dateMs: null,
              updatedAt: Number(row.updatedAt ?? 0),
              daysLeft: null,
            };
          }
        }),
      );
      setRows(details);
      if (!silent) setStatus('');
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void loadContracts();
  }, [loadContracts]);

  useLiveDataRefresh(
    useCallback(async () => {
      await loadContracts({ silent: true });
    }, [loadContracts]),
    { intervalMs: 15000 },
  );

  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) return rows;
    return rows.filter((r) => normalize(r.number).includes(q) || normalize(r.internalNumber).includes(q));
  }, [rows, query]);

  const sorted = useSortedItems(
    filtered,
    listState.sortKey as SortKey,
    listState.sortDir,
    (row, key) => {
      if (key === 'number') return String(row.number ?? '').toLowerCase();
      if (key === 'internalNumber') return String(row.internalNumber ?? '').toLowerCase();
      if (key === 'counterparty') return String(row.counterparty ?? '').toLowerCase();
      if (key === 'dateMs') return Number(row.dateMs ?? 0);
      if (key === 'dueDateMs') return Number(row.dueDateMs ?? 0);
      if (key === 'amount') return Number(row.contractAmount ?? 0);
      return Number(row.updatedAt ?? 0);
    },
    (row) => row.id,
  );

  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  const tableHeader = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #0f766e 0%, #1d4ed8 120%)', color: '#fff' }}>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('number')}>
          Номер контракта {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'number')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('internalNumber')}>
          Внутренний номер контракта {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'internalNumber')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('counterparty')}>
          Контрагент {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'counterparty')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('dateMs')}>
          Дата заключения {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'dateMs')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('dueDateMs')}>
          Дата исполнения {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'dueDateMs')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('amount')}>
          Сумма контракта (контракт плюс ДС) {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'amount')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>
          Дата обновления карточки контракта {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'updatedAt')}
        </th>
      </tr>
    </thead>
  );

  function renderContractRow(row: Row) {
    const style = getContractUrgencyStyle(row.daysLeft);
    const textColor = style.color ?? '#6b7280';
    return (
      <tr
        key={row.id}
        style={{
          borderBottom: '1px solid #f3f4f6',
          cursor: 'pointer',
          ...(style && style),
        }}
        onClick={() => void props.onOpen(row.id)}
        onMouseEnter={(e) => {
          if (!style.backgroundColor) e.currentTarget.style.backgroundColor = '#f9fafb';
        }}
        onMouseLeave={(e) => {
          if (!style.backgroundColor) e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <td style={{ padding: '8px 10px' }}>{row.number || '(без номера)'}</td>
        <td style={{ padding: '8px 10px', color: textColor }}>{row.internalNumber || '—'}</td>
        <td style={{ padding: '8px 10px', color: textColor }}>{row.counterparty || '—'}</td>
        <td style={{ padding: '8px 10px', color: textColor }}>
          {row.dateMs ? new Date(row.dateMs).toLocaleDateString('ru-RU') : '—'}
        </td>
        <td style={{ padding: '8px 10px', color: textColor }}>
          {row.dueDateMs ? new Date(row.dueDateMs).toLocaleDateString('ru-RU') : '—'}
        </td>
        <td style={{ padding: '8px 10px', color: textColor }}>{row.contractAmount.toLocaleString('ru-RU')} ₽</td>
        <td style={{ padding: '8px 10px', color: textColor }}>
          {row.updatedAt ? new Date(row.updatedAt).toLocaleString('ru-RU') : '—'}
        </td>
      </tr>
    );
  }

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.map((row) => renderContractRow(row))}
            {items.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 10, color: '#6b7280' }}>
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
              if (!contractTypeId) return;
              try {
                setStatus('Создание контракта…');
                const r = await window.matrica.admin.entities.create(contractTypeId);
                if (!r?.ok || !r?.id) {
                  setStatus(`Ошибка: ${(r as any)?.error ?? 'unknown'}`);
                  return;
                }
                setStatus('');
                await loadContracts();
                await props.onOpen(String(r.id));
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Создать контракт
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по номеру/внутреннему номеру…" />
        </div>
        <Button variant="ghost" onClick={() => void loadContracts()}>
          Обновить
        </Button>
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}
