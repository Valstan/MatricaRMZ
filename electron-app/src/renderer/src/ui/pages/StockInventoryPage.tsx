import React, { useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { useRecentSelectOptions } from '../hooks/useRecentSelectOptions.js';
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

type SortKey = 'code' | 'name' | 'unit' | 'book' | 'actual' | 'delta';

export function StockInventoryPage(props: {
  canEdit: boolean;
  onOpenDocument: (id: string) => void;
}) {
  const { lookups, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData();
  const { pushRecent, withRecents } = useRecentSelectOptions('matrica:stock-inventory-recents', 8);
  const [status, setStatus] = useState('');
  const [warehouseId, setWarehouseId] = useState<string | null>('default');
  const [reason, setReason] = useState('Плановая инвентаризация');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<InventoryLine[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const visibleRows = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return rows;
    return rows.filter((row) => `${row.code} ${row.name}`.toLowerCase().includes(search));
  }, [query, rows]);

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...visibleRows].sort((a, b) => {
      const actualA = Number(a.actualQty || a.bookQty);
      const actualB = Number(b.actualQty || b.bookQty);
      const deltaA = actualA - a.bookQty;
      const deltaB = actualB - b.bookQty;
      let cmp = 0;
      if (sortKey === 'code') cmp = String(a.code ?? '').localeCompare(String(b.code ?? ''), 'ru');
      else if (sortKey === 'name') cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      else if (sortKey === 'unit') cmp = String(a.unitName ?? '').localeCompare(String(b.unitName ?? ''), 'ru');
      else if (sortKey === 'book') cmp = Number(a.bookQty ?? 0) - Number(b.bookQty ?? 0);
      else if (sortKey === 'actual') cmp = actualA - actualB;
      else if (sortKey === 'delta') cmp = deltaA - deltaB;
      if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      return cmp * dir;
    });
  }, [visibleRows, sortDir, sortKey]);
  const pagedRows = useMemo(() => {
    const start = pageIndex * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [pageIndex, pageSize, sortedRows]);
  const warehouseOptions = useMemo(
    () => withRecents('warehouseId', lookupToSelectOptions(lookups.warehouses)),
    [lookups.warehouses, withRecents],
  );

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
            options={warehouseOptions}
            placeholder="Склад"
            showAllWhenEmpty
            emptyQueryLimit={15}
            onChange={(next) => {
              setWarehouseId(next);
              pushRecent('warehouseId', next);
            }}
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
          <Input
            value={query}
            onChange={(e) => {
              setPageIndex(0);
              setQuery(e.target.value);
            }}
            placeholder="Поиск по коду и номенклатуре..."
            style={{ maxWidth: 360 }}
          />
        </div>
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
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('code')}>{sortLabel('Код', 'code')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>{sortLabel('Номенклатура', 'name')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('unit')}>{sortLabel('Ед.', 'unit')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('book')}>{sortLabel('Учет', 'book')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('actual')}>{sortLabel('Факт', 'actual')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('delta')}>{sortLabel('Расхождение', 'delta')}</th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                  Загрузите остатки по складу, чтобы начать инвентаризацию.
                </td>
              </tr>
            ) : (
              pagedRows.map((row, idx) => {
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
