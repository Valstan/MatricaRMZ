import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WarehouseMovementListItem, WarehouseStockListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { lookupToSelectOptions, warehouseDocTypeLabel } from '../utils/warehouseUi.js';

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
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [movements, setMovements] = useState<WarehouseMovementListItem[]>([]);
  const [movementsStatus, setMovementsStatus] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка остатков...');
      const result = await window.matrica.warehouse.stockList({
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(nomenclatureId ? { nomenclatureId } : {}),
        ...(lowStockOnly ? { lowStockOnly: true } : {}),
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setRows(result.rows ?? []);
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
      const result = await window.matrica.warehouse.movementsList({
        nomenclatureId: selectedRow.nomenclatureId,
        warehouseId: selectedRow.warehouseId,
        limit: 20,
      });
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'minmax(220px, 1.2fr) minmax(220px, 1fr) minmax(260px, 1.1fr) auto auto' }}>
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

      <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
        Всего остаток: <b>{totals.qty}</b> | доступно: <b>{totals.available}</b> | в резерве: <b>{totals.reserved}</b>
      </div>

      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Склад</th>
              <th style={{ textAlign: 'left' }}>Код</th>
              <th style={{ textAlign: 'left' }}>Номенклатура</th>
              <th style={{ textAlign: 'left' }}>Группа</th>
              <th style={{ textAlign: 'left' }}>Ед.</th>
              <th style={{ textAlign: 'left' }}>Остаток</th>
              <th style={{ textAlign: 'left' }}>Доступно</th>
              <th style={{ textAlign: 'left' }}>Резерв</th>
              <th style={{ textAlign: 'left' }}>Мин</th>
              <th style={{ textAlign: 'left' }}>Макс</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 12 }}>
                  Нет данных
                </td>
              </tr>
            ) : (
              rows.map((row) => {
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
                <th style={{ textAlign: 'left' }}>Дата</th>
                <th style={{ textAlign: 'left' }}>Документ</th>
                <th style={{ textAlign: 'left' }}>Тип</th>
                <th style={{ textAlign: 'left' }}>Операция</th>
                <th style={{ textAlign: 'left' }}>Кол-во</th>
                <th style={{ textAlign: 'left' }}>Основание</th>
              </tr>
            </thead>
            <tbody>
              {movements.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 10, textAlign: 'center', color: 'var(--subtle)' }}>
                    Движения не найдены
                  </td>
                </tr>
              ) : (
                movements.map((movement) => (
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
