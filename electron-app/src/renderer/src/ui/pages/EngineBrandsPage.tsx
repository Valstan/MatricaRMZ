import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useCardContentIds } from '../hooks/useListDeepFilter.js';
import { matchesQueryInRecord } from '../utils/search.js';

type BrandRow = { id: string; name: string };

type SortKey = 'name' | 'parts';

export function EngineBrandsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canViewMasterData: boolean;
}) {
  const [entityTypeId, setEntityTypeId] = useState<string | null>(null);
  const [rows, setRows] = useState<BrandRow[]>([]);
  const [brandPartCounts, setBrandPartCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const refresh = useCallback(async () => {
    if (!props.canViewMasterData) return;
    try {
      setStatus('Загрузка...');
      const types = (await window.matrica.admin.entityTypes.list()) as Array<{ id: string; code: string }>;
      const eb = types.find((t) => String(t.code) === 'engine_brand');
      if (!eb?.id) {
        setEntityTypeId(null);
        setRows([]);
        setStatus('Тип справочника «Марки двигателей» (engine_brand) не найден.');
        return;
      }
      setEntityTypeId(eb.id);
      const list = (await window.matrica.admin.entities.listByEntityType(eb.id)) as Array<{
        id: string;
        displayName?: string;
        searchText?: string;
      }>;
      setRows(
        list.map((r) => ({
          id: String(r.id),
          name: String(r.displayName ?? '').trim() || String(r.id),
        })),
      );
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.canViewMasterData]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadBrandPartCounts = useCallback(async () => {
    if (!props.canViewMasterData) return;
    try {
      const specsResult = await window.matrica.warehouse.nomenclaturePartSpecsList();
      if (!specsResult?.ok) return;
      const counts: Record<string, number> = {};
      for (const part of specsResult.rows ?? []) {
        for (const link of part.brandLinks ?? []) {
          const brandId = String(link.engineBrandId ?? '').trim();
          if (!brandId) continue;
          counts[brandId] = (counts[brandId] ?? 0) + 1;
        }
      }
      setBrandPartCounts(counts);
    } catch {
      setBrandPartCounts({});
    }
  }, [props.canViewMasterData]);

  useEffect(() => {
    void loadBrandPartCounts();
  }, [loadBrandPartCounts, rows]);

  // Counts must not go stale after the operator adds/removes parts inside a brand card and
  // returns here: refresh on the live-data pulse (sync-done / focus) and on interval.
  useLiveDataRefresh(loadBrandPartCounts, { enabled: props.canViewMasterData, intervalMs: 20000 });

  // Верхний поиск: имя + внутрь карточки (EAV).
  const getRowId = useCallback((r: { id: string }) => String(r.id), []);
  const deepIds = useCardContentIds(rows, getRowId, query);
  const filtered = useMemo(
    () => rows.filter((r) => matchesQueryInRecord(query, { name: r.name, id: r.id }) || (deepIds?.has(String(r.id)) ?? false)),
    [rows, query, deepIds],
  );

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name, 'ru');
      else cmp = (brandPartCounts[a.id] ?? 0) - (brandPartCounts[b.id] ?? 0);
      if (cmp === 0) cmp = a.name.localeCompare(b.name, 'ru');
      return cmp * dir;
    });
  }, [filtered, sortKey, sortDir, brandPartCounts]);

  function onSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(nextKey);
    setSortDir(nextKey === 'parts' ? 'desc' : 'asc');
  }

  function sortLabel(label: string, key: SortKey) {
    if (sortKey !== key) return label;
    return `${label} ${sortDir === 'asc' ? '↑' : '↓'}`;
  }

  async function addBrand() {
    if (!props.canCreate || !entityTypeId) return;
    try {
      setStatus('');
      // Deferred-create: open an empty card on a client id; the row is materialized on the first
      // save (EngineBrandDetailsPage passes fallbackTypeId). Opened and abandoned → no empty ghost.
      await props.onOpen(crypto.randomUUID());
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (!props.canViewMasterData) {
    return <div style={{ color: 'var(--subtle)' }}>Недостаточно прав для просмотра марок двигателя.</div>;
  }

  const tableHeader = (
    <thead>
      <tr>
        <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>
          {sortLabel('Наименование марки двигателя', 'name')}
        </th>
        <th data-col-kind="num" title="Количество деталей, прикреплённых к этой марке двигателя" style={{ textAlign: 'right', cursor: 'pointer', width: 220 }} onClick={() => onSort('parts')}>
          {sortLabel('Количество деталей, прикреплённых к этой марке двигателя', 'parts')}
        </th>
      </tr>
    </thead>
  );

  function renderBrandCells(row: BrandRow) {
    return (
      <>
        <td data-col-kind="name">{row.name}</td>
        <td data-col-kind="num" style={{ textAlign: 'right' }}>{brandPartCounts[row.id] ?? 0}</td>
      </>
    );
  }

  function rowProps(row: BrandRow): VirtualTableRowProps {
    return {
      style: { cursor: 'pointer' },
      onClick: () => void props.onOpen(row.id),
    };
  }

  function renderTable(items: BrandRow[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'clip' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.map((row) => (
              <tr key={row.id} {...rowProps(row)}>
                {renderBrandCells(row)}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={2}>
                  Нет марок двигателя в справочнике
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate ? (
          <Button onClick={() => void addBrand()} disabled={!entityTypeId}>
            Добавить марку
          </Button>
        ) : null}
        <div style={{ flex: 1 }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по наименованию или id..."
          />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {twoCol ? (
          <TwoColumnList items={sortedRows} enabled renderColumn={(items) => renderTable(items)} />
        ) : (
          <VirtualTable
            scrollElementRef={containerRef}
            count={sortedRows.length}
            header={tableHeader}
            renderCells={(i) => renderBrandCells(sortedRows[i]!)}
            getRowKey={(i) => sortedRows[i]!.id}
            getRowProps={(i) => rowProps(sortedRows[i]!)}
            colCount={2}
            estimateSize={40}
            emptyState="Нет марок двигателя в справочнике"
          />
        )}
      </div>
      <div style={{ padding: '4px 0 2px', flex: '0 0 auto', fontSize: 12, color: '#9ca3af' }}>Всего: {sortedRows.length}</div>
    </div>
  );
}
