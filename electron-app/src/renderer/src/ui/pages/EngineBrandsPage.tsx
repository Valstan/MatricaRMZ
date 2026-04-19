import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';

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
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
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

  useEffect(() => {
    if (!props.canViewMasterData) return;
    let alive = true;
    void (async () => {
      try {
        const partsResult = await window.matrica.parts.list({ limit: 5000, offset: 0 });
        if (!alive || !partsResult?.ok) return;
        const counts: Record<string, number> = {};
        for (const part of partsResult.parts ?? []) {
          for (const link of part.brandLinks ?? []) {
            const brandId = String(link.engineBrandId ?? '').trim();
            if (!brandId) continue;
            counts[brandId] = (counts[brandId] ?? 0) + 1;
          }
        }
        if (alive) setBrandPartCounts(counts);
      } catch {
        if (alive) setBrandPartCounts({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.canViewMasterData, rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  }, [rows, query]);

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

  const pagedRows = useMemo(() => {
    const start = pageIndex * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [pageIndex, pageSize, sortedRows]);

  function onSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      setPageIndex(0);
      return;
    }
    setSortKey(nextKey);
    setSortDir(nextKey === 'parts' ? 'desc' : 'asc');
    setPageIndex(0);
  }

  function sortLabel(label: string, key: SortKey) {
    if (sortKey !== key) return label;
    return `${label} ${sortDir === 'asc' ? '↑' : '↓'}`;
  }

  async function addBrand() {
    if (!props.canCreate || !entityTypeId) return;
    try {
      setStatus('');
      const created = await window.matrica.admin.entities.create(entityTypeId);
      if (!created || typeof created !== 'object' || !('ok' in created) || !created.ok || !created.id) {
        setStatus('Ошибка: не удалось создать запись в справочнике марок.');
        return;
      }
      await window.matrica.admin.entities.setAttr(created.id, 'name', 'Новая марка двигателя');
      await refresh();
      await props.onOpen(String(created.id));
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (!props.canViewMasterData) {
    return <div style={{ color: 'var(--subtle)' }}>Недостаточно прав для просмотра марок двигателя.</div>;
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
            onChange={(e) => {
              setPageIndex(0);
              setQuery(e.target.value);
            }}
            placeholder="Поиск по наименованию или id..."
          />
        </div>
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <WarehouseListPager
        pageSize={pageSize}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPageIndex(0);
        }}
        pageIndex={pageIndex}
        onPageIndexChange={setPageIndex}
        rowCount={pagedRows.length}
        totalCount={sortedRows.length}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>
                {sortLabel('Наименование марки двигателя', 'name')}
              </th>
              <th style={{ textAlign: 'right', cursor: 'pointer', width: 220 }} onClick={() => onSort('parts')}>
                {sortLabel('Количество деталей, прикреплённых к этой марке двигателя', 'parts')}
              </th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td colSpan={2} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                  Нет марок двигателя в справочнике
                </td>
              </tr>
            ) : (
              pagedRows.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => void props.onOpen(row.id)}>
                  <td>{row.name}</td>
                  <td style={{ textAlign: 'right' }}>{brandPartCounts[row.id] ?? 0}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
