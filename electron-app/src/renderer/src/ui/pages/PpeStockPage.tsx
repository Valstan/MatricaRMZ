import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WarehouseStockListItem } from '@matricarmz/shared';

import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SectionCard } from '../components/SectionCard.js';
import { fetchWarehouseStockAllPagesEx } from '../utils/warehousePagedFetch.js';

const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };

/**
 * Склад СИЗ: те же остатки, что у «Остатков», но только номенклатура спецодежды
 * (`category='workwear'`). Отдельная вкладка, чтобы кладовщик не строил фильтр
 * руками при каждой выдаче. Поступление/списание — общими документами склада.
 */
export function PpeStockPage() {
  const [rows, setRows] = useState<WarehouseStockListItem[]>([]);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка остатков...');
      const fetched = await fetchWarehouseStockAllPagesEx(query.trim() ? { search: query.trim() } : {});
      setRows(fetched.rows.filter((r) => String(r.category ?? '') === 'workwear'));
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          String(a.nomenclatureName ?? '').localeCompare(String(b.nomenclatureName ?? ''), 'ru') ||
          String(a.warehouseName ?? a.warehouseId ?? '').localeCompare(String(b.warehouseName ?? b.warehouseId ?? ''), 'ru'),
      ),
    [rows],
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionCard title="Склад СИЗ">
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию" style={{ flex: 1 }} />
        </div>
        {status ? (
          <div style={{ color: 'var(--muted)' }}>{status}</div>
        ) : sorted.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>
            Остатков спецодежды нет. Номенклатура попадает сюда, когда у позиции выставлена категория «workwear»; приход — документом поступления склада.
          </div>
        ) : (
          <>
            <ListCount total={sorted.length} shown={sorted.length} />
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <RowNumberHeaderCell style={ROWNUM_STYLE} />
                  <th>Позиция</th>
                  <th>Склад</th>
                  <th style={{ textAlign: 'right' }}>Остаток</th>
                  <th style={{ textAlign: 'right' }}>Резерв</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={r.id}>
                    <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                    <td>{r.nomenclatureName || '—'}</td>
                    <td>{r.warehouseName || r.warehouseId || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{r.qty}</td>
                    <td style={{ textAlign: 'right' }}>{r.reservedQty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </SectionCard>
    </div>
  );
}
