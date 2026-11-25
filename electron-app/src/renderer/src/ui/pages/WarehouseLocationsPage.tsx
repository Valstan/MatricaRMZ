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
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
// Кит списков (промт КАРМАНА #67): правила — из общего источника, меню — из объявления действий.
import { useListSelection } from '../hooks/useListSelection.js';
import { useListBehaviorSettings } from '../hooks/useListBehaviorSettings.js';
import { ListLassoLayer } from '../components/ListLassoLayer.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import {
  buildCopyRowsStatus,
  buildListContextMenuItems,
  copyRowsToClipboard,
  listCopyAction,
  listPrintAction,
  printRowsPreview,
  resolveMenuRows,
  type ListContextColumn,
} from '../utils/listContextActions.js';

type WorkshopMap = Map<string, string>;

type LocationBucket = {
  warehouseId: string;
  label: string;
  /** Имя цеха, если warehouseId удалось сопоставить (workshop_<code> или прямой UUID). */
  workshopName: string | null;
  totalQty: number;
  totalAvailable: number;
  items: WarehouseStockListItem[];
};

/**
 * Строка списка для кита: локация или позиция внутри неё.
 *
 * Ключ строки устойчивый (не позиция в списке): локация — по warehouseId, позиция —
 * по паре «локация + номенклатура». Иначе выделение контуром после смены фильтра
 * указывало бы на другую строку.
 */
type LocationRow =
  | { kind: 'location'; key: string; warehouseId: string; label: string; totalQty: number; totalAvailable: number }
  | { kind: 'item'; key: string; warehouseId: string; item: WarehouseStockListItem };

function locationKey(warehouseId: string): string {
  return `loc:${warehouseId}`;
}

function itemKey(warehouseId: string, itemId: string): string {
  return `item:${warehouseId}:${itemId}`;
}

function classifyLocation(warehouseId: string): 'system' | 'workshop' | 'default' | 'other' {
  if (warehouseId === WAREHOUSE_LOCATION_DEFAULT) return 'default';
  if (SYSTEM_WAREHOUSE_LOCATIONS.includes(warehouseId as (typeof SYSTEM_WAREHOUSE_LOCATIONS)[number])) return 'system';
  if (isWorkshopWarehouseId(warehouseId)) return 'workshop';
  return 'other';
}

const CATEGORY_LABELS: Record<ReturnType<typeof classifyLocation>, string> = {
  system: 'Системные',
  workshop: 'Цеха',
  default: 'Основной',
  other: 'Прочие',
};

const CATEGORY_ORDER: Array<ReturnType<typeof classifyLocation>> = ['system', 'workshop', 'default', 'other'];

export function WarehouseLocationsPage(props: { onOpenReport?: (presetId: string, filters: Record<string, unknown>) => void }) {
  const [rows, setRows] = useState<WarehouseStockListItem[]>([]);
  /** Лейблы цехов по ключу «workshop_<code>» (префиксированный warehouseId). */
  const [workshopsByCode, setWorkshopsByCode] = useState<WorkshopMap>(new Map());
  /** Лейблы цехов по id (если warehouseId сохранён как голый UUID цеха). */
  const [workshopsById, setWorkshopsById] = useState<WorkshopMap>(new Map());
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

      // Параллельно тянем цеха для красивых лейблов.
      // warehouseId в данных встречается в двух форматах:
      //   1) «workshop_<code>» — нормализованный (используется новым модулем parts-movement)
      //   2) голый UUID цеха — встречается в исторических движениях / некоторых остатках
      const wsRes = await window.matrica.workshops.list();
      const byCode: WorkshopMap = new Map();
      const byId: WorkshopMap = new Map();
      if (wsRes.ok) {
        for (const w of wsRes.rows) {
          byCode.set(`workshop_${w.code}`, w.name);
          if (w.id) byId.set(String(w.id), w.name);
        }
      }
      setWorkshopsByCode(byCode);
      setWorkshopsById(byId);
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
      // 1) нормализованный «workshop_<code>» → по карте кодов
      // 2) голый UUID цеха — пробуем по карте id (исторические данные / parts-movement до миграции)
      const workshopName =
        (code ? workshopsByCode.get(wh) ?? null : null) ??
        workshopsById.get(wh) ??
        null;
      const label = workshopName ?? warehouseLocationLabel(wh, null);
      const bucket =
        result[wh] ?? { warehouseId: wh, label, workshopName, totalQty: 0, totalAvailable: 0, items: [] };
      bucket.totalQty += Number(row.qty ?? 0);
      bucket.totalAvailable += Number(row.availableQty ?? 0);
      bucket.items.push(row);
      result[wh] = bucket;
    }
    return result;
  }, [hideEmpty, query, rows, workshopsByCode, workshopsById]);

  const grouped = useMemo(() => {
    const groups: Record<string, LocationBucket[]> = { system: [], workshop: [], default: [], other: [] };
    for (const bucket of Object.values(buckets)) {
      let cat = classifyLocation(bucket.warehouseId);
      // Голые UUID цехов (исторические данные) не соответствуют формату «workshop_<code>»,
      // но мы знаем их имена — отправляем их в группу «Цеха».
      if (cat === 'other' && bucket.workshopName) cat = 'workshop';
      groups[cat]!.push(bucket);
    }
    // sort each group by name
    for (const cat of Object.keys(groups)) {
      groups[cat]!.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    }
    return groups;
  }, [buckets]);

  // Счётчик локаций: всего — по сырым остаткам (до «скрывать нулевые» и поиска), показано — по buckets.
  const totalLocations = useMemo(
    () => new Set(rows.map((row) => String(row.warehouseId ?? WAREHOUSE_LOCATION_DEFAULT))).size,
    [rows],
  );
  const shownLocations = Object.keys(buckets).length;

  // Кит списка: выделение, контур и меню — по общим правилам программы (D-248).
  const rowById = useMemo(() => {
    const map = new Map<string, LocationRow>();
    for (const bucket of Object.values(buckets)) {
      const key = locationKey(bucket.warehouseId);
      map.set(key, {
        kind: 'location',
        key,
        warehouseId: bucket.warehouseId,
        label: bucket.label,
        totalQty: bucket.totalQty,
        totalAvailable: bucket.totalAvailable,
      });
      for (const item of bucket.items) {
        const itemRowKey = itemKey(bucket.warehouseId, String(item.id));
        map.set(itemRowKey, { kind: 'item', key: itemRowKey, warehouseId: bucket.warehouseId, item });
      }
    }
    return map;
  }, [buckets]);

  /** На экране: локации + позиции развёрнутых локаций (свёрнутые позиции в DOM не лежат). */
  const visibleRowIds = useMemo(() => {
    const ids: string[] = [];
    for (const bucket of Object.values(buckets)) {
      ids.push(locationKey(bucket.warehouseId));
      if (!expandedLoc[bucket.warehouseId]) continue;
      for (const item of bucket.items) ids.push(itemKey(bucket.warehouseId, String(item.id)));
    }
    return ids;
  }, [buckets, expandedLoc]);

  const selection = useListSelection(visibleRowIds);
  const listBehavior = useListBehaviorSettings();
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);

  const contextColumns = useMemo<ListContextColumn<LocationRow>[]>(
    () => [
      { title: 'Тип', value: (row) => (row.kind === 'location' ? 'Локация' : 'Позиция') },
      { title: 'Локация', value: (row) => row.warehouseId },
      {
        title: 'Наименование',
        value: (row) => (row.kind === 'location' ? row.label : (row.item.nomenclatureName ?? '(без названия)')),
      },
      { title: 'Код', value: (row) => (row.kind === 'location' ? '—' : (row.item.nomenclatureCode ?? '—')) },
      {
        title: 'Остаток',
        value: (row) => (row.kind === 'location' ? String(row.totalQty) : String(Number(row.item.qty ?? 0))),
      },
      {
        title: 'Доступно',
        value: (row) => (row.kind === 'location' ? String(row.totalAvailable) : String(Number(row.item.availableQty ?? 0))),
      },
    ],
    [],
  );

  function printRows(items: LocationRow[]) {
    const head = items[0];
    const title =
      items.length > 1
        ? `Выделенные остатки (${items.length})`
        : `Остатки: ${head?.kind === 'location' ? head.label : (head?.item.nomenclatureName ?? '')}`;
    printRowsPreview({
      title,
      sectionTitle: 'Остатки по локациям',
      rows: items,
      columns: contextColumns,
    });
  }

  async function copyRows(items: LocationRow[]) {
    await copyRowsToClipboard(items, contextColumns);
    setStatus(buildCopyRowsStatus(items.length));
  }

  // Сквозная нумерация строк-локаций по всем категориям; позиции внутри локации не нумеруются.
  let locationRowNo = 0;

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

      <ListCount total={totalLocations} shown={shownLocations} />
      <div
        data-list-root="true"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}
      >
        <table className="list-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <RowNumberHeaderCell />
              <th style={{ width: 18 }}></th>
              <th data-col-kind="name" style={{ textAlign: 'left' }}>Локация / Деталь</th>
              <th data-col-kind="name" style={{ width: 110 }}>warehouseId</th>
              <th data-col-kind="name" style={{ width: 120 }}>Код</th>
              <th data-col-kind="num" title="Остаток" style={{ width: 110, textAlign: 'right' }}>Остаток</th>
              <th data-col-kind="num" title="Доступно" style={{ width: 110, textAlign: 'right' }}>Доступно</th>
              <th style={{ width: 80 }}>Журнал</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORY_ORDER.flatMap((cat) => {
              const list = grouped[cat] ?? [];
              if (list.length === 0) return [];
              const header = (
                <tr key={`cat-${cat}`} style={{ background: 'var(--surface-subtle, #f5f5f5)' }}>
                  <td colSpan={8} style={{ fontWeight: 600, padding: '4px 8px' }}>
                    {CATEGORY_LABELS[cat]} ({list.length})
                  </td>
                </tr>
              );
              const rows = list.flatMap((bucket) => {
                const isExpanded = Boolean(expandedLoc[bucket.warehouseId]);
                locationRowNo += 1;
                const head = (
                  <tr
                    key={bucket.warehouseId}
                    style={{ cursor: 'pointer' }}
                    data-list-selected={selection.isSelected(locationKey(bucket.warehouseId)) ? 'true' : undefined}
                    // Маркер строки для выделения контуром (Ctrl + рамка) — правило одно на программу.
                    data-list-row="true"
                    data-list-row-key={locationKey(bucket.warehouseId)}
                    onContextMenu={(e) => {
                      const result = selection.onRowContextMenu(e, locationKey(bucket.warehouseId));
                      if (!result.openMenu) return;
                      setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
                    }}
                    onClick={() => {
                      selection.onRowPrimaryAction(locationKey(bucket.warehouseId));
                      toggleExpand(bucket.warehouseId);
                    }}
                  >
                    <RowNumberCell n={locationRowNo} />
                    <td style={{ textAlign: 'center' }}>{isExpanded ? '▾' : '▸'}</td>
                    <td data-col-kind="name"><strong>{bucket.label}</strong> <span style={{ color: 'var(--subtle)', fontSize: 12 }}>{bucket.items.length} поз.</span></td>
                    <td data-col-kind="name"><code style={{ fontSize: 12 }}>{bucket.warehouseId}</code></td>
                    <td></td>
                    <td data-col-kind="num" style={{ textAlign: 'right' }}><strong>{bucket.totalQty}</strong></td>
                    <td data-col-kind="num" style={{ textAlign: 'right' }}><strong>{bucket.totalAvailable}</strong></td>
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
                  <tr
                    key={`${bucket.warehouseId}::${item.id}`}
                    data-list-selected={selection.isSelected(itemKey(bucket.warehouseId, String(item.id))) ? 'true' : undefined}
                    data-list-row="true"
                    data-list-row-key={itemKey(bucket.warehouseId, String(item.id))}
                    onContextMenu={(e) => {
                      const result = selection.onRowContextMenu(e, itemKey(bucket.warehouseId, String(item.id)));
                      if (!result.openMenu) return;
                      setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
                    }}
                    onClick={() => selection.onRowPrimaryAction(itemKey(bucket.warehouseId, String(item.id)))}
                  >
                    <td />
                    <td></td>
                    <td data-col-kind="name" style={{ paddingLeft: 24 }}>{item.nomenclatureName ?? '(без названия)'}</td>
                    <td></td>
                    <td data-col-kind="name"><code style={{ fontSize: 12 }}>{item.nomenclatureCode ?? ''}</code></td>
                    <td data-col-kind="num" style={{ textAlign: 'right' }}>{Number(item.qty ?? 0)}</td>
                    <td data-col-kind="num" style={{ textAlign: 'right' }}>{Number(item.availableQty ?? 0)}</td>
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
              <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>Нет данных</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Выделение контуром (Ctrl + рамка) — слой кита, включается общей настройкой. */}
      <ListLassoLayer enabled={listBehavior.lasso} onSelect={selection.selectMany} />
      {menu ? (
        <ListContextMenu
          x={menu.x}
          y={menu.y}
          items={buildListContextMenuItems({
            rows: resolveMenuRows(menu.targetIds, rowById),
            bulk: menu.bulk,
            getId: (row) => row.key,
            onSelect: selection.toggleSelect,
            onClearSelection: selection.clearSelection,
            hasSelection: selection.selectedCount > 0,
            // Список ОБЪЯВЛЯЕТ свои действия (промт КАРМАНА #67): печать, копирование
            // и журнал движений по строке. Удалять остатки здесь нечем — пункта «Удалить» нет.
            actions: [
              listPrintAction({ available: true, print: printRows }),
              listCopyAction({ available: true, copy: copyRows }),
              {
                id: 'journal',
                label: 'Журнал движений',
                available: Boolean(props.onOpenReport),
                scope: 'single',
                run: (items) => {
                  const row = items[0];
                  if (!row || !props.onOpenReport) return;
                  if (row.kind === 'location') {
                    props.onOpenReport('part_movement_journal', { warehouseIds: [row.warehouseId] });
                    return;
                  }
                  if (row.item.nomenclatureId) {
                    props.onOpenReport('part_movement_journal', {
                      warehouseIds: [row.warehouseId],
                      nomenclatureSearch: row.item.nomenclatureCode ?? row.item.nomenclatureName ?? '',
                    });
                  }
                },
              },
            ],
          })}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
