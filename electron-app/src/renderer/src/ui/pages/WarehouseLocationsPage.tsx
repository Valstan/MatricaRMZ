import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  SYSTEM_WAREHOUSE_LOCATIONS,
  WAREHOUSE_LOCATION_DEFAULT,
  isWorkshopWarehouseId,
  parseWorkshopWarehouseId,
  warehouseLocationLabel,
  type WarehouseStockListItem,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type WorkshopMap = Map<string, string>;

type LocationBucket = {
  warehouseId: string;
  label: string;
  totalQty: number;
  totalAvailable: number;
  items: WarehouseStockListItem[];
};

function classifyLocation(warehouseId: string): 'system' | 'workshop' | 'default' | 'other' {
  if (warehouseId === WAREHOUSE_LOCATION_DEFAULT) return 'default';
  if (SYSTEM_WAREHOUSE_LOCATIONS.includes(warehouseId as (typeof SYSTEM_WAREHOUSE_LOCATIONS)[number])) return 'system';
  if (isWorkshopWarehouseId(warehouseId)) return 'workshop';
  return 'other';
}

const CATEGORY_LABELS: Record<ReturnType<typeof classifyLocation>, string> = {
  system: 'Системные (parts-movement)',
  workshop: 'Цеха',
  default: 'Основной',
  other: 'Прочие',
};

const CATEGORY_ORDER: Array<ReturnType<typeof classifyLocation>> = ['system', 'workshop', 'default', 'other'];

export function WarehouseLocationsPage(props: { onOpenReport?: (presetId: string, filters: Record<string, unknown>) => void }) {
  const [rows, setRows] = useState<WarehouseStockListItem[]>([]);
  const [workshops, setWorkshops] = useState<WorkshopMap>(new Map());
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [expandedLoc, setExpandedLoc] = useState<Record<string, boolean>>({});
  const [hideEmpty, setHideEmpty] = useState(true);

  const refresh = useCallback(async () => {
    setStatus('Загрузка...');
    try {
      // Тянем все балансы пачками (лимит api: разумный максимум на странице)
      const all: WarehouseStockListItem[] = [];
      let offset = 0;
      const pageSize = 500;
      // safety: max 20 pages = 10k строк
      for (let page = 0; page < 20; page += 1) {
        const r = await window.matrica.warehouse.stockList({ limit: pageSize, offset });
        if (!r?.ok) {
          setStatus(`Ошибка остатков: ${String(r?.error ?? 'unknown')}`);
          return;
        }
        const got = (r.rows ?? []) as WarehouseStockListItem[];
        all.push(...got);
        if (!r.hasMore || got.length < pageSize) break;
        offset += got.length;
      }
      setRows(all);

      // Параллельно тянем цеха для красивых лейблов
      const wsRes = await window.matrica.workshops.list();
      const map: WorkshopMap = new Map();
      if (wsRes.ok) {
        for (const w of wsRes.rows) map.set(`workshop_${w.code}`, w.name);
      }
      setWorkshops(map);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const buckets = useMemo<Record<string, LocationBucket>>(() => {
    const result: Record<string, LocationBucket> = {};
    const queryLc = query.trim().toLowerCase();
    for (const row of rows) {
      if (hideEmpty && Number(row.qty ?? 0) <= 0 && Number(row.availableQty ?? 0) <= 0) continue;
      if (queryLc) {
        const hay = `${row.nomenclatureName ?? ''} ${row.nomenclatureCode ?? ''} ${row.warehouseId ?? ''}`.toLowerCase();
        if (!hay.includes(queryLc)) continue;
      }
      const wh = String(row.warehouseId ?? WAREHOUSE_LOCATION_DEFAULT);
      const code = parseWorkshopWarehouseId(wh);
      const workshopName = code ? workshops.get(wh) ?? null : null;
      const label = warehouseLocationLabel(wh, workshopName);
      const bucket = result[wh] ?? { warehouseId: wh, label, totalQty: 0, totalAvailable: 0, items: [] };
      bucket.totalQty += Number(row.qty ?? 0);
      bucket.totalAvailable += Number(row.availableQty ?? 0);
      bucket.items.push(row);
      result[wh] = bucket;
    }
    return result;
  }, [hideEmpty, query, rows, workshops]);

  const grouped = useMemo(() => {
    const groups: Record<string, LocationBucket[]> = { system: [], workshop: [], default: [], other: [] };
    for (const bucket of Object.values(buckets)) {
      const cat = classifyLocation(bucket.warehouseId);
      groups[cat]!.push(bucket);
    }
    // sort each group by name
    for (const cat of Object.keys(groups)) {
      groups[cat]!.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    }
    return groups;
  }, [buckets]);

  function toggleExpand(wh: string) {
    setExpandedLoc((prev) => ({ ...prev, [wh]: !prev[wh] }));
  }

  function expandAll() {
    const next: Record<string, boolean> = {};
    for (const bucket of Object.values(buckets)) next[bucket.warehouseId] = true;
    setExpandedLoc(next);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Остатки по локациям</h2>
        <Button variant="ghost" onClick={() => void refresh()}>Обновить</Button>
        <Button variant="ghost" onClick={expandAll}>Развернуть все</Button>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
          Скрывать нулевые
        </label>
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск (название/код/локация)" />
        </div>
      </div>

      {status ? (
        <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: 18 }}></th>
              <th style={{ textAlign: 'left' }}>Локация / Деталь</th>
              <th style={{ width: 110 }}>warehouseId</th>
              <th style={{ width: 120 }}>Код</th>
              <th style={{ width: 110, textAlign: 'right' }}>Остаток</th>
              <th style={{ width: 110, textAlign: 'right' }}>Доступно</th>
              <th style={{ width: 80 }}>Журнал</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORY_ORDER.flatMap((cat) => {
              const list = grouped[cat] ?? [];
              if (list.length === 0) return [];
              const header = (
                <tr key={`cat-${cat}`} style={{ background: 'var(--surface-subtle, #f5f5f5)' }}>
                  <td colSpan={7} style={{ fontWeight: 600, padding: '4px 8px' }}>
                    {CATEGORY_LABELS[cat]} ({list.length})
                  </td>
                </tr>
              );
              const rows = list.flatMap((bucket) => {
                const isExpanded = Boolean(expandedLoc[bucket.warehouseId]);
                const head = (
                  <tr key={bucket.warehouseId} style={{ cursor: 'pointer' }} onClick={() => toggleExpand(bucket.warehouseId)}>
                    <td style={{ textAlign: 'center' }}>{isExpanded ? '▾' : '▸'}</td>
                    <td><strong>{bucket.label}</strong> <span style={{ color: 'var(--subtle)', fontSize: 12 }}>{bucket.items.length} поз.</span></td>
                    <td><code style={{ fontSize: 12 }}>{bucket.warehouseId}</code></td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}><strong>{bucket.totalQty}</strong></td>
                    <td style={{ textAlign: 'right' }}><strong>{bucket.totalAvailable}</strong></td>
                    <td>
                      {props.onOpenReport ? (
                        <Button
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onOpenReport!('part_movement_journal', { warehouseIds: [bucket.warehouseId] });
                          }}
                        >
                          ↗
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
                if (!isExpanded) return [head];
                const itemRows = bucket.items.map((item) => (
                  <tr key={`${bucket.warehouseId}::${item.id}`}>
                    <td></td>
                    <td style={{ paddingLeft: 24 }}>{item.nomenclatureName ?? '(без названия)'}</td>
                    <td></td>
                    <td><code style={{ fontSize: 12 }}>{item.nomenclatureCode ?? ''}</code></td>
                    <td style={{ textAlign: 'right' }}>{Number(item.qty ?? 0)}</td>
                    <td style={{ textAlign: 'right' }}>{Number(item.availableQty ?? 0)}</td>
                    <td>
                      {props.onOpenReport && item.nomenclatureId ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            props.onOpenReport!('part_movement_journal', {
                              warehouseIds: [bucket.warehouseId],
                              nomenclatureSearch: item.nomenclatureCode ?? item.nomenclatureName ?? '',
                            })
                          }
                        >
                          ↗
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ));
                return [head, ...itemRows];
              });
              return [header, ...rows];
            })}
            {Object.keys(buckets).length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>Нет данных</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
