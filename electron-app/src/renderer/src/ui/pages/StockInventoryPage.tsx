import React, { useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useRecentSelectOptions } from '../hooks/useRecentSelectOptions.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { fetchWarehouseStockAllPages } from '../utils/warehousePagedFetch.js';
import { lookupToSelectOptions } from '../utils/warehouseUi.js';
import { matchesQueryInRecord } from '../utils/search.js';

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
  // Ф6 (G9): слепой подсчёт — факт вводится без подсказки учётным, колонки «Учет»/«Расхождение»
  // скрыты. В документ идут только строки с введённым фактом (частичная инвентаризация).
  const [blindMode, setBlindMode] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<InventoryLine[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const containerRef = useRef<HTMLDivElement | null>(null);

  const visibleRows = useMemo(
    () => rows.filter((row) => matchesQueryInRecord(query, { code: row.code, name: row.name })),
    [query, rows],
  );

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...visibleRows].sort((a, b) => {
      // G9: в слепом режиме пустой факт не подменяется учётным — сортировка по «Факт»
      // не должна выдавать учётный порядок.
      const actualA = Number(a.actualQty || (blindMode ? 0 : a.bookQty));
      const actualB = Number(b.actualQty || (blindMode ? 0 : b.bookQty));
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
  }, [visibleRows, sortDir, sortKey, blindMode]);
  const warehouseOptions = useMemo(
    () => withRecents('warehouseId', lookupToSelectOptions(lookups.warehouses)),
    [lookups.warehouses, withRecents],
  );

  function onSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(nextKey);
    setSortDir('asc');
  }

  function sortLabel(label: string, key: SortKey) {
    if (sortKey !== key) return label;
    return `${label} ${sortDir === 'asc' ? '↑' : '↓'}`;
  }

  const tableHeader = (
    <thead>
      <tr>
        <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('code')}>{sortLabel('Код', 'code')}</th>
        <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>{sortLabel('Номенклатура', 'name')}</th>
        <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('unit')}>{sortLabel('Ед.', 'unit')}</th>
        {/* G9: в слепом режиме учёт/расхождение не показываем и не даём сортировать по ним
            (порядок строк по учёту тоже подсказка). */}
        {!blindMode && (
          <th data-col-kind="num" title="Учет" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('book')}>{sortLabel('Учет', 'book')}</th>
        )}
        <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('actual')}>{sortLabel('Факт', 'actual')}</th>
        {!blindMode && (
          <th data-col-kind="num" title="Расхождение" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('delta')}>{sortLabel('Расхождение', 'delta')}</th>
        )}
      </tr>
    </thead>
  );

  function renderInventoryCells(row: InventoryLine) {
    const actualQty = Number(row.actualQty || row.bookQty);
    const delta = actualQty - row.bookQty;
    return (
      <>
        <td data-col-kind="name">{row.code || '—'}</td>
        <td data-col-kind="name">{row.name || '—'}</td>
        <td>{row.unitName || '—'}</td>
        {!blindMode && <td data-col-kind="num">{row.bookQty}</td>}
        <td>
          <Input
            type="number"
            value={row.actualQty}
            placeholder={blindMode ? 'посчитайте' : undefined}
            onChange={(e) =>
              setRows((prev) =>
                prev.map((item) =>
                  item.nomenclatureId === row.nomenclatureId && item.warehouseId === row.warehouseId ? { ...item, actualQty: e.target.value } : item,
                ),
              )
            }
          />
        </td>
        {!blindMode && (
          <td data-col-kind="num" style={{ color: delta === 0 ? 'var(--subtle)' : delta > 0 ? 'var(--success)' : 'var(--danger)' }}>{delta}</td>
        )}
      </>
    );
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
      actualQty: blindMode ? '' : String(row.qty ?? 0),
      unitName: row.unitName ?? null,
    }));
    const withId = nextRows.filter((row) => row.nomenclatureId);
    setRows(withId);
    setStatus(
      withId.length ? 'Остатки загружены. Проверьте фактическое количество и создайте документ.' : 'На выбранном складе нет остатков.',
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
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
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={blindMode}
            onChange={(e) => {
              const next = e.target.checked;
              setBlindMode(next);
              if (next && (sortKey === 'book' || sortKey === 'delta')) setSortKey('name');
              // Переключение режима сбрасывает «Факт»: вслепую — пусто, обычный — предзаполнен учётным.
              setRows((prev) => prev.map((row) => ({ ...row, actualQty: next ? '' : String(row.bookQty) })));
            }}
          />
          <span>
            Слепая инвентаризация — факт вводится без подсказки учётным; в документ попадут только строки с введённым фактом
            (частичный подсчёт).
          </span>
        </label>
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
                // G9: вслепую в документ идут только строки с введённым фактом (cycle counting).
                const sourceRows = blindMode ? rows.filter((row) => row.actualQty.trim() !== '') : rows;
                if (blindMode && sourceRows.length === 0) {
                  setStatus('Ошибка: не введено ни одного факта — вслепую в документ попадают только посчитанные строки.');
                  return;
                }
                const effectiveRows = sourceRows.map((row) => {
                  const actual = Number(row.actualQty || (blindMode ? 0 : row.bookQty));
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
                setStatus(
                  blindMode
                    ? `Документ инвентаризации создан (посчитано строк: ${effectiveRows.length} из ${rows.length}).`
                    : 'Документ инвентаризации создан',
                );
                props.onOpenDocument(String(result.id));
              }}
            >
              Создать документ инвентаризации
            </Button>
          </div>
        ) : null}
      </div>

      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ fontWeight: 700 }}>Строки инвентаризации</div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по коду и номенклатуре..."
            style={{ maxWidth: 360 }}
          />
        </div>
        {/* NB: без виртуализации — редактируемое поле «Факт» не должно размонтироваться
            при прокрутке (иначе фокус слетает посреди ввода). Sticky-шапка работает,
            т.к. скролл-контейнер (containerRef, overflow:auto) — прямой родитель таблицы
            без промежуточной overflow-обёртки. */}
        <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div style={{ border: '1px solid #e5e7eb' }}>
            <table className="list-table">
              {tableHeader}
              <tbody>
                {sortedRows.length === 0 ? (
                  <tr>
                    <td style={{ padding: 10, color: '#6b7280' }} colSpan={blindMode ? 4 : 6}>
                      Загрузите остатки по складу, чтобы начать инвентаризацию.
                    </td>
                  </tr>
                ) : (
                  sortedRows.map((row) => (
                    <tr key={`${row.nomenclatureId}-${row.warehouseId}`}>{renderInventoryCells(row)}</tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div style={{ padding: '4px 0 2px', flex: '0 0 auto', fontSize: 12, color: '#9ca3af' }}>Всего: {sortedRows.length}</div>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
    </div>
  );
}
