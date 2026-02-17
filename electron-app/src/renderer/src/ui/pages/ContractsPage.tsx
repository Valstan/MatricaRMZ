import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useStableArrayState } from '../hooks/useStableState.js';
import { parseContractSections, aggregateProgressByContract, type ProgressLinkedItem } from '@matricarmz/shared';

type Row = {
  id: string;
  number: string;
  internalNumber: string;
  dateMs: number | null;
  updatedAt: number;
  daysLeft: number | null;
  progress: number | null;
};
type SortKey = 'number' | 'internalNumber' | 'dateMs' | 'updatedAt';

function normalize(s: string) {
  return String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

export function ContractsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const [rows, setRows] = useStableArrayState<Row>([]);
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

      const enginesRes = await window.matrica.engines.list().catch(() => []);
      const engines: ProgressLinkedItem[] = Array.isArray(enginesRes) ? enginesRes : [];
      const partsRes = await window.matrica.parts.list({ limit: 5000 }).catch(() => ({ ok: false, parts: [] }));
      const parts: ProgressLinkedItem[] = partsRes?.ok && partsRes.parts ? partsRes.parts : [];

      const engineAggByContract = aggregateProgressByContract(engines);
      const partAggByContract = aggregateProgressByContract(parts);

      const details = await Promise.all(
        (listRaw as any[]).map(async (row: any) => {
          try {
            const d = await window.matrica.admin.entities.get(String(row.id));
            const attrs = (d as any).attributes ?? {};
            const sections = parseContractSections(attrs);
            const numberRaw = (sections.primary.number || attrs.number) ?? row.displayName ?? '';
            const internalRaw = (sections.primary.internalNumber || attrs.internal_number) ?? '';
            const dateMs = sections.primary.signedAt ?? (typeof attrs.date === 'number' ? Number(attrs.date) : null);
            let maxDueAt: number | null = null;
            if (sections.primary.dueAt != null) maxDueAt = sections.primary.dueAt;
            for (const addon of sections.addons) {
              if (addon.dueAt != null && (maxDueAt == null || addon.dueAt > maxDueAt)) maxDueAt = addon.dueAt;
            }
            const daysLeft = maxDueAt != null ? Math.ceil((maxDueAt - Date.now()) / (24 * 60 * 60 * 1000)) : null;

            const contractId = String(row.id);
            const engineAgg = engineAggByContract[contractId];
            const partAgg = partAggByContract[contractId];
            const sumStages = (engineAgg?.sumStages ?? 0) + (partAgg?.sumStages ?? 0);
            const count = (engineAgg?.count ?? 0) + (partAgg?.count ?? 0);
            const progress = count > 0 ? sumStages / (count * 100) : null;

            return {
              id: String(row.id),
              number: numberRaw == null ? '' : String(numberRaw),
              internalNumber: internalRaw == null ? '' : String(internalRaw),
              dateMs,
              updatedAt: Number(row.updatedAt ?? 0),
              daysLeft,
              progress,
            };
          } catch {
            return {
              id: String(row.id),
              number: row.displayName ? String(row.displayName) : String(row.id).slice(0, 8),
              internalNumber: '',
              dateMs: null,
              updatedAt: Number(row.updatedAt ?? 0),
              daysLeft: null,
              progress: null,
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
      if (key === 'dateMs') return Number(row.dateMs ?? 0);
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
          Номер {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'number')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('internalNumber')}>
          Внутр. номер {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'internalNumber')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('dateMs')}>
          Дата {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'dateMs')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>
          Обновлено {sortArrow(listState.sortKey as SortKey, listState.sortDir, 'updatedAt')}
        </th>
        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, width: 140 }}>Действия</th>
      </tr>
    </thead>
  );

  function renderContractRow(row: Row) {
    const h = row.daysLeft != null && row.daysLeft <= 30 && (row.progress == null || row.progress < 0.7);
    return (
      <tr
        key={row.id}
        style={{
          borderBottom: '1px solid #f3f4f6',
          cursor: 'pointer',
          ...(h && { backgroundColor: 'rgba(254, 202, 202, 0.5)' }),
        }}
        onClick={() => void props.onOpen(row.id)}
        onMouseEnter={(e) => {
          if (!h) e.currentTarget.style.backgroundColor = '#f9fafb';
        }}
        onMouseLeave={(e) => {
          if (!h) e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <td style={{ padding: '8px 10px' }}>{row.number || '(без номера)'}</td>
        <td style={{ padding: '8px 10px', color: '#6b7280' }}>{row.internalNumber || '—'}</td>
        <td style={{ padding: '8px 10px', color: '#6b7280' }}>
          {row.dateMs ? new Date(row.dateMs).toLocaleDateString('ru-RU') : '—'}
        </td>
        <td style={{ padding: '8px 10px', color: '#6b7280' }}>
          {row.updatedAt ? new Date(row.updatedAt).toLocaleString('ru-RU') : '—'}
        </td>
        <td style={{ padding: '8px 10px' }}>
          {props.canDelete && (
            <Button
              variant="ghost"
              onClick={async (e) => {
                e.stopPropagation();
                if (!confirm('Удалить контракт?')) return;
                try {
                  setStatus('Удаление…');
                  const r = await window.matrica.admin.entities.softDelete(row.id);
                  if (!r.ok) {
                    setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
                    return;
                  }
                  setStatus('Удалено');
                  setTimeout(() => setStatus(''), 900);
                  await loadContracts();
                } catch (err) {
                  setStatus(`Ошибка: ${String(err)}`);
                }
              }}
              style={{ color: '#b91c1c' }}
            >
              Удалить
            </Button>
          )}
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
                <td colSpan={5} style={{ padding: 10, color: '#6b7280' }}>
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
