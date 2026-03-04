import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type Row = {
  id: string;
  warehouseId?: string | null;
  nomenclatureCode?: string | null;
  nomenclatureName?: string | null;
  itemType?: string | null;
  qty?: number;
  reservedQty?: number;
  minStock?: number | null;
  maxStock?: number | null;
};

export function StockBalancesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка...');
      const result = await window.matrica.warehouse.stockList({
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(warehouseId.trim() ? { warehouseId: warehouseId.trim() } : {}),
        ...(lowStockOnly ? { lowStockOnly: true } : {}),
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setRows((result.rows ?? []) as Row[]);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [lowStockOnly, query, warehouseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => {
          acc.qty += Number(row.qty ?? 0);
          acc.reserved += Number(row.reservedQty ?? 0);
          return acc;
        },
        { qty: 0, reserved: 0 },
      ),
    [rows],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по коду и наименованию..." />
        <Input value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="Склад (ID)" />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={lowStockOnly} onChange={(e) => setLowStockOnly(e.target.checked)} />
          Ниже минимального
        </label>
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
        Всего остаток: <b>{totals.qty}</b> | в резерве: <b>{totals.reserved}</b>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Склад</th>
              <th style={{ textAlign: 'left' }}>Код</th>
              <th style={{ textAlign: 'left' }}>Номенклатура</th>
              <th style={{ textAlign: 'left' }}>Тип</th>
              <th style={{ textAlign: 'left' }}>Остаток</th>
              <th style={{ textAlign: 'left' }}>Резерв</th>
              <th style={{ textAlign: 'left' }}>Мин</th>
              <th style={{ textAlign: 'left' }}>Макс</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 12 }}>
                  Нет данных
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const qty = Number(row.qty ?? 0);
                const min = row.minStock == null ? null : Number(row.minStock);
                const isLow = min != null && qty <= min;
                return (
                  <tr key={row.id} style={isLow ? { background: 'rgba(239, 68, 68, 0.08)' } : undefined}>
                    <td>{row.warehouseId || 'default'}</td>
                    <td>{row.nomenclatureCode || '—'}</td>
                    <td>{row.nomenclatureName || '—'}</td>
                    <td>{row.itemType || '—'}</td>
                    <td>{qty}</td>
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
    </div>
  );
}
