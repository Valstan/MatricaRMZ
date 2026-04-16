import React, { useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { fetchWarehouseStockAllPages } from '../utils/warehousePagedFetch.js';
import { lookupToSelectOptions } from '../utils/warehouseUi.js';

type InventoryLine = {
  nomenclatureId: string;
  code: string;
  name: string;
  warehouseId: string;
  bookQty: number;
  actualQty: string;
  unitName: string | null;
};

export function StockInventoryPage(props: {
  canEdit: boolean;
  onOpenDocument: (id: string) => void;
}) {
  const { lookups, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData();
  const [status, setStatus] = useState('');
  const [warehouseId, setWarehouseId] = useState<string | null>('default');
  const [reason, setReason] = useState('Плановая инвентаризация');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<InventoryLine[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);

  const visibleRows = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return rows;
    return rows.filter((row) => `${row.code} ${row.name}`.toLowerCase().includes(search));
  }, [query, rows]);

  async function loadBalances() {
    if (!warehouseId) {
      setStatus('Выберите склад для загрузки остатков.');
      return;
    }
    setLoadingRows(true);
    setStatus('Загрузка учетных остатков...');
    let stockRows: Awaited<ReturnType<typeof fetchWarehouseStockAllPages>>;
    try {
      stockRows = await fetchWarehouseStockAllPages({ warehouseId });
    } catch (e) {
      setLoadingRows(false);
      setStatus(`Ошибка: ${String(e)}`);
      return;
    }
    setLoadingRows(false);
    const nextRows = stockRows.map((row) => ({
      nomenclatureId: String(row.nomenclatureId ?? ''),
      code: String(row.nomenclatureCode ?? ''),
      name: String(row.nomenclatureName ?? ''),
      warehouseId: String(row.warehouseId ?? warehouseId),
      bookQty: Number(row.qty ?? 0),
      actualQty: String(row.qty ?? 0),
      unitName: row.unitName ?? null,
    }));
    const withId = nextRows.filter((row) => row.nomenclatureId);
    setRows(withId);
    setStatus(
      withId.length ? 'Остатки загружены. Проверьте фактическое количество и создайте документ.' : 'На выбранном складе нет остатков.',
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Инвентаризация склада</div>
        <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
          Загрузите учетные остатки по складу, внесите фактическое количество и создайте документ инвентаризации с автоматически подготовленными строками.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'center' }}>
          <div>Склад</div>
          <SearchSelect
            value={warehouseId}
            options={lookupToSelectOptions(lookups.warehouses)}
            placeholder="Склад"
            onChange={setWarehouseId}
          />
          <div>Основание</div>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
        {props.canEdit ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => void loadBalances()}>
              {loadingRows ? 'Загрузка...' : 'Загрузить остатки'}
            </Button>
            <Button variant="ghost" onClick={() => void refreshRefs()}>
              Обновить справочники
            </Button>
            <Button
              onClick={async () => {
                const effectiveRows = rows.map((row) => {
                  const actual = Number(row.actualQty || row.bookQty);
                  return {
                    qty: 0,
                    nomenclatureId: row.nomenclatureId,
                    warehouseId: row.warehouseId,
                    bookQty: row.bookQty,
                    actualQty: Number.isFinite(actual) ? actual : row.bookQty,
                  };
                });
                const now = Date.now();
                const result = await window.matrica.warehouse.documentCreate({
                  docType: 'stock_inventory',
                  docNo: `INV-${String(now).slice(-8)}`,
                  docDate: now,
                  header: {
                    warehouseId: warehouseId ?? 'default',
                    reason: reason.trim() || null,
                    counterpartyId: null,
                  },
                  lines: effectiveRows,
                });
                if (!result?.ok || !result.id) {
                  setStatus(`Ошибка: ${String(!result?.ok && result ? result.error : 'не удалось создать документ')}`);
                  return;
                }
                setStatus('Документ инвентаризации создан');
                props.onOpenDocument(String(result.id));
              }}
            >
              Создать документ инвентаризации
            </Button>
          </div>
        ) : null}
      </div>

      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ fontWeight: 700 }}>Строки инвентаризации</div>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по коду и номенклатуре..." style={{ maxWidth: 360 }} />
        </div>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Код</th>
              <th style={{ textAlign: 'left' }}>Номенклатура</th>
              <th style={{ textAlign: 'left' }}>Ед.</th>
              <th style={{ textAlign: 'left' }}>Учет</th>
              <th style={{ textAlign: 'left' }}>Факт</th>
              <th style={{ textAlign: 'left' }}>Расхождение</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                  Загрузите остатки по складу, чтобы начать инвентаризацию.
                </td>
              </tr>
            ) : (
              visibleRows.map((row, idx) => {
                const actualQty = Number(row.actualQty || row.bookQty);
                const delta = actualQty - row.bookQty;
                return (
                  <tr key={`${row.nomenclatureId}-${row.warehouseId}-${idx}`}>
                    <td>{row.code || '—'}</td>
                    <td>{row.name || '—'}</td>
                    <td>{row.unitName || '—'}</td>
                    <td>{row.bookQty}</td>
                    <td>
                      <Input
                        type="number"
                        value={row.actualQty}
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((item) =>
                              item.nomenclatureId === row.nomenclatureId && item.warehouseId === row.warehouseId ? { ...item, actualQty: e.target.value } : item,
                            ),
                          )
                        }
                      />
                    </td>
                    <td style={{ color: delta === 0 ? 'var(--subtle)' : delta > 0 ? 'var(--success)' : 'var(--danger)' }}>{delta}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
    </div>
  );
}
