import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ListRowThumbs } from '../components/ListRowThumbs.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { ListColumnsToggle } from '../components/ListColumnsToggle.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import {
  aggregateProgressWithPlan,
  contractPlannedItemsCount,
  effectiveContractDueAt,
  type ContractSections,
  type ProgressLinkedItem,
  parseContractSections,
} from '@matricarmz/shared';
import { formatMoscowDate, formatMoscowDateTime, formatRuMoney } from '../utils/dateUtils.js';
import { matchesQueryInRecord } from '../utils/search.js';

type Row = {
  id: string;
  number: string;
  internalNumber: string;
  counterparty: string;
  searchText?: string;
  dateMs: number | null;
  dueDateMs: number | null;
  contractAmount: number;
  updatedAt: number;
  daysLeft: number | null;
  progressPct: number | null;
  isFullyExecuted: boolean;
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
};
type SortKey = 'number' | 'internalNumber' | 'counterparty' | 'dateMs' | 'dueDateMs' | 'amount' | 'updatedAt';
type ContractsListUiState = {
  query: string;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  showPreviews: boolean;
  contractDateFrom: string;
  contractDateTo: string;
};

function sumMoneyItems(items: Array<{ qty: number; unitPrice: number }>) {
  return items.reduce<number>((acc, row) => {
    const qty = Number(row.qty);
    const unitPrice = Number(row.unitPrice);
    if (!Number.isFinite(qty) || !Number.isFinite(unitPrice)) return acc;
    return acc + qty * unitPrice;
  }, 0);
}

function getContractAmount(sections: ContractSections): number {
  let total = 0;
  total += sumMoneyItems(sections.primary.engineBrands);
  total += sumMoneyItems(sections.primary.parts);
  for (const addon of sections.addons) {
    total += sumMoneyItems(addon.engineBrands);
    total += sumMoneyItems(addon.parts);
  }
  return total;
}

function normalizeContractNumber(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function collectProgressContractNumbers(sections: ContractSections): Set<string> {
  const out = new Set<string>();
  const primary = normalizeContractNumber(sections.primary.number);
  if (primary) out.add(primary);
  for (const addon of sections.addons) {
    const addonNumber = normalizeContractNumber(addon.number);
    if (addonNumber) out.add(addonNumber);
  }
  return out;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return value;
}

function fromInputDate(value: string): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(`${text}T00:00:00`);
  return Number.isFinite(ms) ? ms : null;
}

function endOfInputDate(value: string): number | null {
  const startMs = fromInputDate(value);
  if (startMs == null) return null;
  return startMs + 24 * 60 * 60 * 1000 - 1;
}

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
    const previews = toAttachmentPreviews(value);
    for (const preview of previews) {
      if (seen.has(preview.id)) continue;
      seen.add(preview.id);
      out.push(preview);
      if (out.length >= 5) return out;
    }
  }
  return out;
}

function getProgressBarStyle(row: Row): { style: React.CSSProperties; textColor: string; hoverable: boolean } {
  if (row.daysLeft != null && row.daysLeft < 0 && !row.isFullyExecuted) {
    return {
      style: { backgroundColor: 'rgba(239, 68, 68, 0.85)' },
      textColor: '#fff',
      hoverable: false,
    };
  }

  if (row.isFullyExecuted) {
    return {
      style: { backgroundColor: 'rgba(59, 130, 246, 0.85)' },
      textColor: '#fff',
      hoverable: false,
    };
  }

  if (row.progressPct == null || row.dateMs == null || row.dueDateMs == null || row.dueDateMs <= row.dateMs) {
    return { style: {}, textColor: '#6b7280', hoverable: true };
  }

  const execPct = clampPercent(row.progressPct);
  const timePct = clampPercent(((Date.now() - row.dateMs) / (row.dueDateMs - row.dateMs)) * 100);
  const lag = timePct - execPct;

  let barColor = '#3b82f6';
  if (lag >= 50) barColor = '#ef4444';
  else if (lag >= 30) barColor = '#f97316';
  else if (lag >= 20) barColor = '#facc15';
  else if (lag >= 10) barColor = '#a3e635';
  else if (lag > 0) barColor = '#60a5fa';

  const pct = execPct.toFixed(2);
  return {
    style: {
      background: `linear-gradient(to right, ${barColor} ${pct}%, transparent ${pct}%)`,
    },
    textColor: '#6b7280',
    hoverable: false,
  };
}

export function ContractsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const { state: listState, patchState } = useListUiState<ContractsListUiState>('list:contracts', {
    query: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
    showPreviews: true,
    contractDateFrom: '',
    contractDateTo: '',
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:contracts');
  const query = String(listState.query ?? '');
  const showPreviews = listState.showPreviews !== false;
  const contractDateFrom = String(listState.contractDateFrom ?? '');
  const contractDateTo = String(listState.contractDateTo ?? '');
  const [contractTypeId, setContractTypeId] = useState<string>('');
  const width = useWindowWidth();
  const { isMultiColumn, toggle: toggleColumnsMode } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;

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

      const engines = await window.matrica.engines.list();
      const partsRes = await window.matrica.parts.list({ limit: 5000 });
      const linkedItems: ProgressLinkedItem[] = [];
      const linkedEngineItems = Array.isArray(engines) ? engines : [];
      for (const e of linkedEngineItems) {
        linkedItems.push({
          contractId: e.contractId || null,
          statusFlags: e.statusFlags ?? null,
        });
      }
      if (partsRes?.ok && Array.isArray(partsRes.parts)) {
        for (const p of partsRes.parts) {
          linkedItems.push({ contractId: p.contractId || null, statusFlags: p.statusFlags ?? null });
        }
      }

      const linkedItemsByContractId = new Map<string, Array<Pick<ProgressLinkedItem, 'statusFlags'>>>();
      for (const item of linkedItems) {
        const contractId = String(item.contractId ?? '');
        if (!contractId) continue;
        const bucket = linkedItemsByContractId.get(contractId) ?? [];
        bucket.push({ statusFlags: item.statusFlags ?? null });
        linkedItemsByContractId.set(contractId, bucket);
      }

      const contractIdsByNumber = new Map<string, Set<string>>();
      for (const row of listRaw as any[]) {
        const id = String(row?.id ?? '');
        if (!id) continue;
        const numberKey = normalizeContractNumber(row?.displayName ?? '');
        if (!numberKey) continue;
        const bucket = contractIdsByNumber.get(numberKey) ?? new Set<string>();
        bucket.add(id);
        contractIdsByNumber.set(numberKey, bucket);
      }

      const details = await Promise.all(
        (listRaw as any[]).map(async (row: any) => {
          try {
            const d = await window.matrica.admin.entities.get(String(row.id));
            const attrs = (d as any).attributes ?? {};
            const attachmentPreviews = collectAttachmentPreviews(attrs);
            const sections = parseContractSections(attrs);
            const numberRaw = (sections.primary.number || attrs.number) ?? row.displayName ?? '';
            const internalRaw = (sections.primary.internalNumber || attrs.internal_number) ?? '';
            const dateMs = sections.primary.signedAt ?? (typeof attrs.date === 'number' ? Number(attrs.date) : null);
            const dueDateMs = effectiveContractDueAt(sections);
            const daysLeft = dueDateMs != null ? Math.ceil((dueDateMs - Date.now()) / (24 * 60 * 60 * 1000)) : null;

            const contractAmount = getContractAmount(sections);
            const counterparty = sections.primary.customerId ? customerById.get(sections.primary.customerId) ?? sections.primary.customerId : '—';
            const progressNumberKeys = collectProgressContractNumbers(sections);
            if (progressNumberKeys.size === 0) {
              const fallback = normalizeContractNumber(numberRaw);
              if (fallback) progressNumberKeys.add(fallback);
            }
            const relatedContractIds = new Set<string>([String(row.id)]);
            for (const numberKey of progressNumberKeys) {
              const byNumber = contractIdsByNumber.get(numberKey);
              if (!byNumber) continue;
              for (const relatedId of byNumber) relatedContractIds.add(relatedId);
            }
            const relatedItems: Array<Pick<ProgressLinkedItem, 'statusFlags'>> = [];
            for (const relatedId of relatedContractIds) {
              const bucket = linkedItemsByContractId.get(relatedId);
              if (bucket?.length) relatedItems.push(...bucket);
            }
            const plannedCount = contractPlannedItemsCount(sections);
            const progress = aggregateProgressWithPlan(relatedItems, plannedCount);
            const progressPct = progress?.progressPct ?? null;
            const isFullyExecuted = Boolean(progressPct != null && progressPct >= 100);

            return {
              id: String(row.id),
              number: numberRaw == null ? '' : String(numberRaw),
              internalNumber: internalRaw == null ? '' : String(internalRaw),
              counterparty,
              searchText: row.searchText ? String(row.searchText) : undefined,
              dueDateMs,
              contractAmount,
              dateMs,
              updatedAt: Number(row.updatedAt ?? 0),
              daysLeft,
              progressPct,
              isFullyExecuted,
              ...(attachmentPreviews.length > 0 ? { attachmentPreviews } : {}),
            };
          } catch {
            return {
              id: String(row.id),
              number: row.displayName ? String(row.displayName) : String(row.id).slice(0, 8),
              internalNumber: '',
              counterparty: '—',
              searchText: row.searchText ? String(row.searchText) : undefined,
              dueDateMs: null,
              contractAmount: 0,
              dateMs: null,
              updatedAt: Number(row.updatedAt ?? 0),
              daysLeft: null,
              progressPct: null,
              isFullyExecuted: false,
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
    const fromMs = fromInputDate(contractDateFrom);
    const toMs = endOfInputDate(contractDateTo);
    const hasDateFilter = fromMs != null || toMs != null;
    return rows.filter((row) => {
      if (!matchesQueryInRecord(query, row)) return false;
      if (!hasDateFilter) return true;
      const contractSignedAt = row.dateMs;
      if (contractSignedAt == null) return false;
      if (fromMs != null && contractSignedAt < fromMs) return false;
      if (toMs != null && contractSignedAt > toMs) return false;
      return true;
    });
  }, [rows, query, contractDateFrom, contractDateTo]);

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
        {showPreviews && (
          <th style={{ textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, width: 220 }}>
            Превью
          </th>
        )}
      </tr>
    </thead>
  );

  function renderContractRow(row: Row) {
    const rowVisual = getProgressBarStyle(row);
    const textColor = rowVisual.textColor;
    return (
      <tr
        key={row.id}
        style={{
          borderBottom: '1px solid #f3f4f6',
          cursor: 'pointer',
          ...(rowVisual.style && rowVisual.style),
        }}
        onClick={() => void props.onOpen(row.id)}
        onMouseEnter={(e) => {
          if (rowVisual.hoverable) e.currentTarget.style.backgroundColor = '#f9fafb';
        }}
        onMouseLeave={(e) => {
          if (rowVisual.hoverable) e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <td style={{ padding: '8px 10px', color: textColor }}>{row.number || '(без номера)'}</td>
        <td style={{ padding: '8px 10px', color: textColor }}>{row.internalNumber || '—'}</td>
        <td style={{ padding: '8px 10px', color: textColor }}>{row.counterparty || '—'}</td>
        <td style={{ padding: '8px 10px', color: textColor }}>
          {row.dateMs ? formatMoscowDate(row.dateMs) : '—'}
        </td>
        <td style={{ padding: '8px 10px', color: textColor }}>
          {row.dueDateMs ? formatMoscowDate(row.dueDateMs) : '—'}
        </td>
        <td style={{ padding: '8px 10px', color: textColor }}>{formatRuMoney(row.contractAmount)}</td>
        <td style={{ padding: '8px 10px', color: textColor }}>
          {row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—'}
        </td>
        {showPreviews && (
          <td style={{ padding: '8px 10px', textAlign: 'right' }}>
            <ListRowThumbs files={row.attachmentPreviews ?? []} />
          </td>
        )}
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
                <td colSpan={showPreviews ? 8 : 7} style={{ padding: 10, color: '#6b7280' }}>
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
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по всем данным контракта…" />
        </div>
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          По дате заключения:
        </span>
        <div style={{ width: 170 }}>
          <Input
            type="date"
            value={contractDateFrom}
            onChange={(e) => patchState({ contractDateFrom: e.target.value })}
            title="Дата заключения контракта: с"
          />
        </div>
        <div style={{ width: 170 }}>
          <Input
            type="date"
            value={contractDateTo}
            onChange={(e) => patchState({ contractDateTo: e.target.value })}
            title="Дата заключения контракта: по"
          />
        </div>
        <Button
          variant="ghost"
          onClick={() => patchState({ contractDateFrom: '', contractDateTo: '' })}
          disabled={!contractDateFrom && !contractDateTo}
        >
          Сбросить даты
        </Button>
        <Button variant="ghost" onClick={() => void loadContracts()}>
          Обновить
        </Button>
        <Button variant="ghost" onClick={() => patchState({ showPreviews: !showPreviews })}>
          {showPreviews ? 'Отключить превью' : 'Включить превью'}
        </Button>
        <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleColumnsMode} />
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
    </div>
  );
}
