import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { NomenclatureItemType, WarehouseNomenclatureListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { buildNomenclatureCode } from '../utils/nomenclatureCode.js';

type CreateConfig = {
  codePrefix: string;
  name: string;
  itemType: NomenclatureItemType;
  category: string;
};

type SortKey = 'code' | 'name' | 'sku' | 'parts' | 'price';

export function NomenclatureDirectoryPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canView?: boolean;
  noAccessText?: string;
  directoryKind: string;
  emptyText: string;
  searchPlaceholder: string;
  createButtonText: string;
  createConfig: CreateConfig;
  secondaryAction?: React.ReactNode;
}) {
  const [rows, setRows] = useState<WarehouseNomenclatureListItem[]>([]);
  const [servicePrices, setServicePrices] = useState<Record<string, number | null>>({});
  const [brandPartCounts, setBrandPartCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const canView = props.canView !== false;

  function parsePriceFromSpec(specJson: string | null | undefined): number | null {
    if (!specJson) return null;
    try {
      const parsed = JSON.parse(String(specJson)) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return null;
      const direct = Number((parsed as any).price);
      if (Number.isFinite(direct)) return Math.max(0, direct);
      const attrsPrice = Number((parsed as any)?.attributes?.price);
      if (Number.isFinite(attrsPrice)) return Math.max(0, attrsPrice);
      return null;
    } catch {
      return null;
    }
  }

  function formatPrice(value: number | null | undefined): string {
    if (!Number.isFinite(Number(value))) return '—';
    const rounded = Math.round(Number(value));
    return `${rounded.toLocaleString('ru-RU')} ₽`;
  }

  function looksLikeLegacyDirectoryRow(row: WarehouseNomenclatureListItem): boolean {
    const code = String((row as any).code ?? '').trim().toLowerCase();
    const itemType = String((row as any).itemType ?? '').trim().toLowerCase();
    const specJson = String((row as any).specJson ?? '').trim().toLowerCase();
    if (props.directoryKind === 'part') {
      return itemType === 'component' || code.startsWith('det-') || specJson.includes('"source":"part"');
    }
    if (props.directoryKind === 'tool') {
      return itemType === 'tool_consumable' || code.startsWith('tls-');
    }
    return false;
  }

  const refresh = useCallback(async () => {
    if (!canView) return;
    try {
      setStatus('Загрузка...');
      const result = await window.matrica.warehouse.nomenclatureList({
        directoryKind: props.directoryKind,
        ...(query.trim() ? { search: query.trim() } : {}),
        limit: 1000,
        offset: 0,
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      const strictRows = (result.rows ?? []) as WarehouseNomenclatureListItem[];
      if (strictRows.length > 0 || (props.directoryKind !== 'part' && props.directoryKind !== 'tool')) {
        setRows(strictRows);
        setStatus('');
        return;
      }
      // Legacy fallback: in old data directory_kind was often empty.
      const fallback = await window.matrica.warehouse.nomenclatureList({
        ...(query.trim() ? { search: query.trim() } : {}),
        limit: 1000,
        offset: 0,
      });
      if (!fallback?.ok) {
        setRows(strictRows);
        setStatus('');
        return;
      }
      const fallbackRows = ((fallback.rows ?? []) as WarehouseNomenclatureListItem[]).filter(looksLikeLegacyDirectoryRow);
      setRows(fallbackRows);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [canView, props.directoryKind, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!canView) return;
    if (props.directoryKind !== 'engine_brand') {
      setBrandPartCounts({});
      return;
    }
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
  }, [canView, props.directoryKind, rows]);

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'code') cmp = String(a.code ?? '').localeCompare(String(b.code ?? ''), 'ru');
      else if (sortKey === 'name') cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      else if (sortKey === 'sku') cmp = String(a.sku ?? '').localeCompare(String(b.sku ?? ''), 'ru');
      else if (sortKey === 'parts') cmp = (brandPartCounts[String(a.id)] ?? 0) - (brandPartCounts[String(b.id)] ?? 0);
      else if (sortKey === 'price') cmp = Number(servicePrices[String(a.id)] ?? -1) - Number(servicePrices[String(b.id)] ?? -1);
      if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      return cmp * dir;
    });
  }, [rows, sortDir, sortKey, brandPartCounts, servicePrices]);
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
    setSortDir('asc');
    setPageIndex(0);
  }

  function sortLabel(label: string, key: SortKey) {
    if (sortKey !== key) return label;
    return `${label} ${sortDir === 'asc' ? '↑' : '↓'}`;
  }

  useEffect(() => {
    if (!canView) return;
    if (props.directoryKind !== 'service') {
      setServicePrices({});
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const next: Record<string, number | null> = {};
        const toLoad: Array<{ id: string; directoryRefId: string | null }> = [];
        for (const row of rows) {
          const parsedPrice = parsePriceFromSpec(row.specJson);
          if (parsedPrice != null) {
            next[String(row.id)] = parsedPrice;
          } else {
            toLoad.push({
              id: String(row.id),
              directoryRefId: row.directoryRefId ? String(row.directoryRefId) : null,
            });
          }
        }
        if (toLoad.length > 0) {
          const loaded = await Promise.all(
            toLoad.map(async (row) => {
              if (!row.directoryRefId) return { id: row.id, price: null as number | null };
              const details = await window.matrica.admin.entities.get(row.directoryRefId).catch(() => null);
              const attrs = (details as any)?.attributes ?? {};
              const value = Number(attrs.price);
              return { id: row.id, price: Number.isFinite(value) ? Math.max(0, value) : null };
            }),
          );
          for (const row of loaded) next[row.id] = row.price;
        }
        if (alive) setServicePrices(next);
      } catch {
        if (alive) setServicePrices({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [canView, props.directoryKind, rows]);

  if (!canView) {
    return <div style={{ color: 'var(--subtle)' }}>{props.noAccessText ?? 'Недостаточно прав для просмотра.'}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate ? (
          <Button
            onClick={async () => {
              const created = await window.matrica.warehouse.nomenclatureUpsert({
                code: buildNomenclatureCode(props.createConfig.codePrefix),
                name: props.createConfig.name,
                itemType: props.createConfig.itemType,
                category: props.createConfig.category,
                directoryKind: props.directoryKind,
                isActive: true,
              });
              if (!created?.ok) {
                setStatus(`Ошибка: ${String(created.error ?? 'не удалось создать')}`);
                return;
              }
              if (!created.id) {
                setStatus('Ошибка: не удалось создать');
                return;
              }
              await refresh();
              await props.onOpen(String(created.id));
            }}
          >
            {props.createButtonText}
          </Button>
        ) : null}

        {props.secondaryAction}

        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => { setPageIndex(0); setQuery(e.target.value); }} placeholder={props.searchPlaceholder} />
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
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('code')}>{sortLabel('Код', 'code')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>{sortLabel('Наименование', 'name')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('sku')}>{sortLabel('SKU', 'sku')}</th>
              {props.directoryKind === 'engine_brand' ? (
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('parts')}>
                  {sortLabel('Прикреплено деталей', 'parts')}
                </th>
              ) : null}
              {props.directoryKind === 'service' ? (
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('price')}>
                  {sortLabel('Цена', 'price')}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={
                    3 + (props.directoryKind === 'engine_brand' ? 1 : 0) + (props.directoryKind === 'service' ? 1 : 0)
                  }
                  style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}
                >
                  {props.emptyText}
                </td>
              </tr>
            ) : (
              pagedRows.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => void props.onOpen(String(row.id))}>
                  <td>{row.code || '—'}</td>
                  <td>{row.name || '—'}</td>
                  <td>{row.sku || '—'}</td>
                  {props.directoryKind === 'engine_brand' ? <td>{brandPartCounts[String(row.id)] ?? 0}</td> : null}
                  {props.directoryKind === 'service' ? <td>{formatPrice(servicePrices[String(row.id)])}</td> : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
