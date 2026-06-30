import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WarehouseMovementListItem, WarehouseStockListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { formatListDateTime } from '../utils/dateUtils.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { fetchWarehouseStockAllPagesEx } from '../utils/warehousePagedFetch.js';
import { lookupToSelectOptions, warehouseDocTypeLabel } from '../utils/warehouseUi.js';

type BalanceSortKey = 'warehouse' | 'code' | 'name' | 'group' | 'unit' | 'qty' | 'available' | 'reserved' | 'min' | 'max';
type MovementSortKey = 'date' | 'doc' | 'docType' | 'operation' | 'qty' | 'reason';

export function StockBalancesPage(props: {
  onOpenDocument: (id: string) => void;
  onOpenNomenclature: (id: string) => void;
  onOpenSupplyRequest?: (id: string) => void;
  canCreateSupplyRequest?: boolean;
}) {
  const { lookups, nomenclature, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData({ loadNomenclature: true });
  const [rows, setRows] = useState<WarehouseStockListItem[]>([]);
  const [searchSimilar, setSearchSimilar] = useState(false);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [nomenclatureId, setNomenclatureId] = useState<string | null>(null);
  const [itemTypeFilter, setItemTypeFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [movements, setMovements] = useState<WarehouseMovementListItem[]>([]);
  const [movementsStatus, setMovementsStatus] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;
  const [balanceSortKey, setBalanceSortKey] = useState<BalanceSortKey>('name');
  const [balanceSortDir, setBalanceSortDir] = useState<'asc' | 'desc'>('asc');
  const [movementSortKey, setMovementSortKey] = useState<MovementSortKey>('date');
  const [movementSortDir, setMovementSortDir] = useState<'asc' | 'desc'>('desc');

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка остатков...');
      const fetched = await fetchWarehouseStockAllPagesEx({
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(nomenclatureId ? { nomenclatureId } : {}),
        ...(lowStockOnly ? { lowStockOnly: true } : {}),
      });
      setRows(fetched.rows);
      setSearchSimilar(fetched.searchSimilar);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [lowStockOnly, nomenclatureId, query, warehouseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedRow = useMemo(() => rows.find((row) => row.id === selectedRowId) ?? null, [rows, selectedRowId]);

  useEffect(() => {
    if (!selectedRow?.nomenclatureId || !selectedRow.warehouseId) {
      setMovements([]);
      setMovementsStatus('');
      return;
    }
    let alive = true;
    void (async () => {
      setMovementsStatus('Загрузка движений...');
      const movListArgs: { limit: number; nomenclatureId?: string; warehouseId?: string } = { limit: 20 };
      if (selectedRow.nomenclatureId) movListArgs.nomenclatureId = selectedRow.nomenclatureId;
      if (selectedRow.warehouseId) movListArgs.warehouseId = selectedRow.warehouseId;
      const result = await window.matrica.warehouse.movementsList(movListArgs);
      if (!alive) return;
      if (!result?.ok) {
        setMovements([]);
        setMovementsStatus(`Ошибка: ${String(result?.error ?? 'не удалось загрузить движения')}`);
        return;
      }
      setMovements(result.rows ?? []);
      setMovementsStatus('');
    })();
    return () => {
      alive = false;
    };
  }, [selectedRow?.nomenclatureId, selectedRow?.warehouseId]);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (itemTypeFilter && String(row.itemType ?? '') !== itemTypeFilter) return false;
      if (categoryFilter && String(row.category ?? '') !== categoryFilter) return false;
      return true;
    });
  }, [rows, itemTypeFilter, categoryFilter]);

  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, row) => {
          acc.qty += Number(row.qty ?? 0);
          acc.reserved += Number(row.reservedQty ?? 0);
          acc.available += Number(row.availableQty ?? 0);
          return acc;
        },
        { qty: 0, reserved: 0, available: 0 },
      ),
    [filtered],
  );

  const sortedRows = useMemo(() => {
    const dir = balanceSortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (balanceSortKey === 'warehouse') cmp = String(a.warehouseName ?? '').localeCompare(String(b.warehouseName ?? ''), 'ru');
      else if (balanceSortKey === 'code') cmp = String(a.nomenclatureCode ?? '').localeCompare(String(b.nomenclatureCode ?? ''), 'ru');
      else if (balanceSortKey === 'name') cmp = String(a.nomenclatureName ?? '').localeCompare(String(b.nomenclatureName ?? ''), 'ru');
      else if (balanceSortKey === 'group') cmp = String(a.groupName ?? '').localeCompare(String(b.groupName ?? ''), 'ru');
      else if (balanceSortKey === 'unit') cmp = String(a.unitName ?? '').localeCompare(String(b.unitName ?? ''), 'ru');
      else if (balanceSortKey === 'qty') cmp = Number(a.qty ?? 0) - Number(b.qty ?? 0);
      else if (balanceSortKey === 'available') cmp = Number(a.availableQty ?? 0) - Number(b.availableQty ?? 0);
      else if (balanceSortKey === 'reserved') cmp = Number(a.reservedQty ?? 0) - Number(b.reservedQty ?? 0);
      else if (balanceSortKey === 'min') cmp = Number(a.minStock ?? -1) - Number(b.minStock ?? -1);
      else if (balanceSortKey === 'max') cmp = Number(a.maxStock ?? -1) - Number(b.maxStock ?? -1);
      if (cmp === 0) cmp = String(a.nomenclatureName ?? '').localeCompare(String(b.nomenclatureName ?? ''), 'ru');
      return cmp * dir;
    });
  }, [filtered, balanceSortDir, balanceSortKey]);

  // Точка заказа: рекомендуемое кол-во к закупке — добрать доступный остаток до
  // max (или до min, если max не задан). >0 только когда остаток ≤ min.
  function suggestedOrderQty(row: WarehouseStockListItem): number {
    const min = row.minStock == null ? null : Number(row.minStock);
    if (min == null) return 0;
    const qty = Number(row.qty ?? 0);
    if (qty > min) return 0;
    const target = row.maxStock != null ? Number(row.maxStock) : min;
    const available = Number(row.availableQty ?? qty);
    return Math.max(1, Math.ceil(target - available));
  }

  const [reorderStatus, setReorderStatus] = useState('');
  async function createReorderRequest() {
    const candidates = sortedRows.filter((r) => suggestedOrderQty(r) > 0);
    if (candidates.length === 0) {
      setReorderStatus('Нет позиций ниже минимума');
      return;
    }
    try {
      setReorderStatus('Создаю заявку…');
      const created = await window.matrica.supplyRequests.create();
      if (!created?.ok) {
        setReorderStatus(`Ошибка: ${String(created?.error ?? 'не удалось создать заявку')}`);
        return;
      }
      const payload = {
        ...created.payload,
        title: created.payload.title || 'Закупка по точке заказа',
        items: candidates.map((r, i) => ({
          lineNo: i + 1,
          productId: r.nomenclatureId ?? null,
          name: r.nomenclatureName ?? '',
          qty: suggestedOrderQty(r),
          unit: r.unitName ?? 'шт',
          note: 'Точка заказа',
          deliveries: [],
        })),
      };
      const upd = await window.matrica.supplyRequests.update({ id: created.id, payload });
      if (!upd?.ok) {
        setReorderStatus(`Ошибка сохранения: ${String(upd?.error ?? 'не удалось сохранить позиции')}`);
        return;
      }
      setReorderStatus('');
      props.onOpenSupplyRequest?.(created.id);
    } catch (e) {
      setReorderStatus(`Ошибка: ${String(e)}`);
    }
  }

  const sortedMovements = useMemo(() => {
    const dir = movementSortDir === 'asc' ? 1 : -1;
    return [...movements].sort((a, b) => {
      let cmp = 0;
      if (movementSortKey === 'date') cmp = Number(a.performedAt ?? 0) - Number(b.performedAt ?? 0);
      else if (movementSortKey === 'doc') cmp = String(a.documentDocNo ?? '').localeCompare(String(b.documentDocNo ?? ''), 'ru');
      else if (movementSortKey === 'docType') cmp = String(a.documentDocType ?? '').localeCompare(String(b.documentDocType ?? ''), 'ru');
      else if (movementSortKey === 'operation') cmp = String(a.movementType ?? '').localeCompare(String(b.movementType ?? ''), 'ru');
      else if (movementSortKey === 'qty') cmp = Number(a.qty ?? 0) - Number(b.qty ?? 0);
      else if (movementSortKey === 'reason') cmp = String(a.reasonLabel ?? a.reason ?? a.counterpartyName ?? '').localeCompare(String(b.reasonLabel ?? b.reason ?? b.counterpartyName ?? ''), 'ru');
      if (cmp === 0) cmp = String(a.id).localeCompare(String(b.id), 'ru');
      return cmp * dir;
    });
  }, [movements, movementSortDir, movementSortKey]);

  function onBalanceSort(nextKey: BalanceSortKey) {
    if (balanceSortKey === nextKey) {
      setBalanceSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setBalanceSortKey(nextKey);
    setBalanceSortDir('asc');
  }

  function onMovementSort(nextKey: MovementSortKey) {
    if (movementSortKey === nextKey) {
      setMovementSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setMovementSortKey(nextKey);
    setMovementSortDir('asc');
  }

  function label(base: string, active: boolean, dir: 'asc' | 'desc') {
    if (!active) return base;
    return `${base} ${dir === 'asc' ? '↑' : '↓'}`;
  }

  const balanceHeader = (
    <thead>
      <tr>
        <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('warehouse')}>{label('Склад', balanceSortKey === 'warehouse', balanceSortDir)}</th>
        <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('code')}>{label('Код', balanceSortKey === 'code', balanceSortDir)}</th>
        <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('name')}>{label('Номенклатура', balanceSortKey === 'name', balanceSortDir)}</th>
        <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('group')}>{label('Группа', balanceSortKey === 'group', balanceSortDir)}</th>
        <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('unit')}>{label('Ед.', balanceSortKey === 'unit', balanceSortDir)}</th>
        <th data-col-kind="num" title="Остаток" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('qty')}>{label('Остаток', balanceSortKey === 'qty', balanceSortDir)}</th>
        <th data-col-kind="num" title="Доступно" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('available')}>{label('Доступно', balanceSortKey === 'available', balanceSortDir)}</th>
        <th data-col-kind="num" title="Резерв" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('reserved')}>{label('Резерв', balanceSortKey === 'reserved', balanceSortDir)}</th>
        <th data-col-kind="num" title="Мин" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('min')}>{label('Мин', balanceSortKey === 'min', balanceSortDir)}</th>
        <th data-col-kind="num" title="Макс" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('max')}>{label('Макс', balanceSortKey === 'max', balanceSortDir)}</th>
        <th data-col-kind="num" style={{ textAlign: 'left' }} title="Рекомендуемое кол-во к закупке (до макс/мин)">К заказу</th>
      </tr>
    </thead>
  );

  function balanceRowProps(row: WarehouseStockListItem): VirtualTableRowProps {
    const qty = Number(row.qty ?? 0);
    const min = row.minStock == null ? null : Number(row.minStock);
    const isLow = min != null && qty <= min;
    const isSelected = row.id === selectedRowId;
    return {
      onClick: () => setSelectedRowId(row.id),
      ...(isSelected
        ? { style: { background: 'rgba(59, 130, 246, 0.12)' } }
        : isLow
          ? { style: { background: 'rgba(239, 68, 68, 0.08)' } }
          : {}),
    };
  }

  function renderBalanceCells(row: WarehouseStockListItem) {
    return (
      <>
        <td data-col-kind="name">
          {row.warehouseName ||
            (String(row.warehouseId ?? '') === 'default' ? 'Склад по умолчанию' : row.warehouseId || '—')}
        </td>
        <td data-col-kind="name">{row.nomenclatureCode || '—'}</td>
        <td data-col-kind="name">
          {row.nomenclatureId ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onOpenNomenclature(String(row.nomenclatureId));
              }}
              style={{ border: 'none', background: 'transparent', color: 'var(--link, #2563eb)', padding: 0, cursor: 'pointer' }}
            >
              {row.nomenclatureName || '—'}
            </button>
          ) : (
            '—'
          )}
        </td>
        <td>{row.groupName || '—'}</td>
        <td>{row.unitName || '—'}</td>
        <td data-col-kind="num">{Number(row.qty ?? 0)}</td>
        <td data-col-kind="num">{Number(row.availableQty ?? 0)}</td>
        <td data-col-kind="num">{Number(row.reservedQty ?? 0)}</td>
        <td data-col-kind="num">{row.minStock == null ? '—' : Number(row.minStock)}</td>
        <td data-col-kind="num">{row.maxStock == null ? '—' : Number(row.maxStock)}</td>
        <td data-col-kind="num">{suggestedOrderQty(row) > 0 ? <b style={{ color: '#b45309' }}>{suggestedOrderQty(row)}</b> : '—'}</td>
      </>
    );
  }

  function renderBalanceTable(items: WarehouseStockListItem[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'clip' }}>
        <table className="list-table">
          {balanceHeader}
          <tbody>
            {items.map((row) => (
              <tr key={row.id} {...balanceRowProps(row)}>
                {renderBalanceCells(row)}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={11}>
                  Нет данных
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'minmax(220px, 1.2fr) minmax(220px, 1fr) minmax(260px, 1.1fr) minmax(180px, 0.8fr) minmax(180px, 0.8fr) auto auto' }}>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по складу, коду и номенклатуре..." />
        <SearchSelect
          value={warehouseId}
          options={lookupToSelectOptions(lookups.warehouses)}
          placeholder="Склад"
          onChange={setWarehouseId}
        />
        <SearchSelect
          value={nomenclatureId}
          options={nomenclature.map((item) => ({ id: item.id, label: `${item.name} (${item.code})` }))}
          placeholder="Номенклатура"
          onChange={setNomenclatureId}
        />
        <select value={itemTypeFilter} onChange={(e) => setItemTypeFilter(e.target.value)} style={{ padding: '8px 10px' }}>
          <option value="">Тип: все</option>
          <option value="engine">Двигатель</option>
          <option value="component">Комплектующая</option>
          <option value="assembly">Сборка</option>
          <option value="material">Материал</option>
        </select>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} style={{ padding: '8px 10px' }}>
          <option value="">Категория: все</option>
          <option value="engine">Двигатель</option>
          <option value="component">Комплектующая</option>
          <option value="assembly">Сборка</option>
        </select>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={lowStockOnly} onChange={(e) => setLowStockOnly(e.target.checked)} />
          Ниже минимального
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={() => void refresh()}>
            Обновить
          </Button>
          <Button variant="ghost" onClick={() => void refreshRefs()}>
            Обновить справочники
          </Button>
        </div>
      </div>

      {searchSimilar && (
        <div
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            background: 'rgba(245, 158, 11, 0.15)',
            color: '#92400e',
            fontSize: 13,
            flex: '0 0 auto',
          }}
        >
          Точных совпадений нет — показаны похожие.
        </div>
      )}

      {props.canCreateSupplyRequest && (() => {
        const reorderCount = sortedRows.filter((r) => suggestedOrderQty(r) > 0).length;
        if (reorderCount === 0) return null;
        return (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button tone="warn" onClick={() => void createReorderRequest()}>
              Создать заявку на закупку ({reorderCount})
            </Button>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>
              позиций ниже минимума — будет создан черновик заявки в Снабжение
            </span>
            {reorderStatus ? <span style={{ fontSize: 12, color: reorderStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{reorderStatus}</span> : null}
          </div>
        );
      })()}

      <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
        Итого по списку ({sortedRows.length}) — остаток: <b>{totals.qty}</b> | доступно: <b>{totals.available}</b> | в резерве:{' '}
        <b>{totals.reserved}</b>
      </div>

      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {twoCol ? (
          <TwoColumnList items={sortedRows} enabled renderColumn={(items) => renderBalanceTable(items)} />
        ) : (
          <VirtualTable
            scrollElementRef={containerRef}
            count={sortedRows.length}
            header={balanceHeader}
            renderCells={(i) => renderBalanceCells(sortedRows[i]!)}
            getRowKey={(i) => sortedRows[i]!.id}
            getRowProps={(i) => balanceRowProps(sortedRows[i]!)}
            colCount={10}
            estimateSize={40}
            emptyState="Нет данных"
          />
        )}
      </div>

      {selectedRow ? (
        <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ fontWeight: 700 }}>Последние движения по позиции</div>
            <span style={{ color: 'var(--subtle)' }}>
              {selectedRow.nomenclatureName || 'Номенклатура'} / {selectedRow.warehouseName || selectedRow.warehouseId || 'Склад'}
            </span>
          </div>
          {movementsStatus ? <div style={{ color: movementsStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{movementsStatus}</div> : null}
          <table className="list-table">
            <thead>
              <tr>
                <th data-col-kind="date" title="Дата" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('date')}>
                  {label('Дата', movementSortKey === 'date', movementSortDir)}
                </th>
                <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('doc')}>{label('Документ', movementSortKey === 'doc', movementSortDir)}</th>
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('docType')}>{label('Тип', movementSortKey === 'docType', movementSortDir)}</th>
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('operation')}>{label('Операция', movementSortKey === 'operation', movementSortDir)}</th>
                <th data-col-kind="num" title="Кол-во" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('qty')}>{label('Кол-во', movementSortKey === 'qty', movementSortDir)}</th>
                <th data-col-kind="text" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('reason')}>{label('Основание', movementSortKey === 'reason', movementSortDir)}</th>
              </tr>
            </thead>
            <tbody>
              {sortedMovements.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 10, textAlign: 'center', color: 'var(--subtle)' }}>
                    Движения не найдены
                  </td>
                </tr>
              ) : (
                sortedMovements.map((movement) => (
                  <tr key={movement.id}>
                    <td data-col-kind="date">{movement.performedAt ? formatListDateTime(Number(movement.performedAt)) : '—'}</td>
                    <td data-col-kind="name">
                      {movement.documentHeaderId ? (
                        <button
                          type="button"
                          onClick={() => props.onOpenDocument(String(movement.documentHeaderId))}
                          style={{ border: 'none', background: 'transparent', color: 'var(--link, #2563eb)', padding: 0, cursor: 'pointer' }}
                        >
                          {movement.documentDocNo || 'Открыть документ'}
                        </button>
                      ) : (
                        movement.documentDocNo || '—'
                      )}
                    </td>
                    <td>{warehouseDocTypeLabel(movement.documentDocType)}</td>
                    <td>{movement.movementType}</td>
                    <td data-col-kind="num">{Number(movement.qty ?? 0)}</td>
                    <td data-col-kind="text">{movement.reasonLabel || movement.reason || movement.counterpartyName || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
