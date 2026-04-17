import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WarehouseMovementListItem, WarehouseStockListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { lookupToSelectOptions, warehouseDocTypeLabel } from '../utils/warehouseUi.js';

type BalanceSortKey = 'warehouse' | 'code' | 'name' | 'group' | 'unit' | 'qty' | 'available' | 'reserved' | 'min' | 'max';
type MovementSortKey = 'date' | 'doc' | 'docType' | 'operation' | 'qty' | 'reason';

export function StockBalancesPage(props: {
  onOpenDocument: (id: string) => void;
  onOpenNomenclature: (id: string) => void;
}) {
  const { lookups, nomenclature, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData({ loadNomenclature: true });
  const [rows, setRows] = useState<WarehouseStockListItem[]>([]);
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
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [balanceSortKey, setBalanceSortKey] = useState<BalanceSortKey>('name');
  const [balanceSortDir, setBalanceSortDir] = useState<'asc' | 'desc'>('asc');
  const [movementSortKey, setMovementSortKey] = useState<MovementSortKey>('date');
  const [movementSortDir, setMovementSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    setPageIndex(0);
  }, [lowStockOnly, nomenclatureId, query, warehouseId]);

  useEffect(() => {
    setSelectedRowId(null);
  }, [pageIndex, pageSize]);

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка остатков...');
      const result = await window.matrica.warehouse.stockList({
        limit: pageSize,
        offset: pageIndex * pageSize,
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(nomenclatureId ? { nomenclatureId } : {}),
        ...(lowStockOnly ? { lowStockOnly: true } : {}),
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      const fetched = (result.rows ?? []) as WarehouseStockListItem[];
      const filteredRows = fetched.filter((row) => {
        if (itemTypeFilter && String(row.itemType ?? '') !== itemTypeFilter) return false;
        if (categoryFilter && String(row.category ?? '') !== categoryFilter) return false;
        return true;
      });
      setRows(filteredRows);
      setHasMore(Boolean(result.hasMore));
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [categoryFilter, itemTypeFilter, lowStockOnly, nomenclatureId, pageIndex, pageSize, query, warehouseId]);

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

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => {
          acc.qty += Number(row.qty ?? 0);
          acc.reserved += Number(row.reservedQty ?? 0);
          acc.available += Number(row.availableQty ?? 0);
          return acc;
        },
        { qty: 0, reserved: 0, available: 0 },
      ),
    [rows],
  );

  const sortedRows = useMemo(() => {
    const dir = balanceSortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
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
  }, [rows, balanceSortDir, balanceSortKey]);

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

      <WarehouseListPager
        pageSize={pageSize}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPageIndex(0);
        }}
        pageIndex={pageIndex}
        onPageIndexChange={setPageIndex}
        rowCount={rows.length}
        hasMore={hasMore}
        disabled={status === 'Загрузка остатков...'}
      />

      <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
        Итого по текущей странице — остаток: <b>{totals.qty}</b> | доступно: <b>{totals.available}</b> | в резерве:{' '}
        <b>{totals.reserved}</b>
      </div>

      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('warehouse')}>{label('Склад', balanceSortKey === 'warehouse', balanceSortDir)}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('code')}>{label('Код', balanceSortKey === 'code', balanceSortDir)}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('name')}>{label('Номенклатура', balanceSortKey === 'name', balanceSortDir)}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('group')}>{label('Группа', balanceSortKey === 'group', balanceSortDir)}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('unit')}>{label('Ед.', balanceSortKey === 'unit', balanceSortDir)}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('qty')}>{label('Остаток', balanceSortKey === 'qty', balanceSortDir)}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('available')}>{label('Доступно', balanceSortKey === 'available', balanceSortDir)}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('reserved')}>{label('Резерв', balanceSortKey === 'reserved', balanceSortDir)}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('min')}>{label('Мин', balanceSortKey === 'min', balanceSortDir)}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onBalanceSort('max')}>{label('Макс', balanceSortKey === 'max', balanceSortDir)}</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 12 }}>
                  Нет данных
                </td>
              </tr>
            ) : (
              sortedRows.map((row) => {
                const qty = Number(row.qty ?? 0);
                const min = row.minStock == null ? null : Number(row.minStock);
                const isLow = min != null && qty <= min;
                const isSelected = row.id === selectedRowId;
                return (
                  <tr
                    key={row.id}
                    style={
                      isSelected
                        ? { background: 'rgba(59, 130, 246, 0.12)' }
                        : isLow
                          ? { background: 'rgba(239, 68, 68, 0.08)' }
                          : undefined
                    }
                    onClick={() => setSelectedRowId(row.id)}
                  >
                    <td>{row.warehouseName || row.warehouseId || 'Основной склад'}</td>
                    <td>{row.nomenclatureCode || '—'}</td>
                    <td>
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
                    <td>{qty}</td>
                    <td>{Number(row.availableQty ?? 0)}</td>
                    <td>{Number(row.reservedQty ?? 0)}</td>
                    <td>{row.minStock == null ? '—' : Number(row.minStock)}</td>
                    <td>{row.maxStock == null ? '—' : Number(row.maxStock)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
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
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('date')}>
                  {label('Дата', movementSortKey === 'date', movementSortDir)}
                </th>
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('doc')}>{label('Документ', movementSortKey === 'doc', movementSortDir)}</th>
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('docType')}>{label('Тип', movementSortKey === 'docType', movementSortDir)}</th>
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('operation')}>{label('Операция', movementSortKey === 'operation', movementSortDir)}</th>
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('qty')}>{label('Кол-во', movementSortKey === 'qty', movementSortDir)}</th>
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onMovementSort('reason')}>{label('Основание', movementSortKey === 'reason', movementSortDir)}</th>
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
                    <td>{movement.performedAt ? new Date(Number(movement.performedAt)).toLocaleString('ru-RU') : '—'}</td>
                    <td>
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
                    <td>{Number(movement.qty ?? 0)}</td>
                    <td>{movement.reasonLabel || movement.reason || movement.counterpartyName || '—'}</td>
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
