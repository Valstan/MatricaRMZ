import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  WAREHOUSE_LOCATION_REPAIR_FUND,
  WAREHOUSE_LOCATION_LABELS,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { useRecentSelectOptions } from '../hooks/useRecentSelectOptions.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { fetchWarehouseStockAllPages } from '../utils/warehousePagedFetch.js';
import { matchesQueryInRecord } from '../utils/search.js';

const REPAIR_FUND = WAREHOUSE_LOCATION_REPAIR_FUND;
const REPAIR_FUND_LABEL = WAREHOUSE_LOCATION_LABELS[REPAIR_FUND] ?? 'Ремонтный фонд';

type FundLine = {
  nomenclatureId: string;
  code: string;
  name: string;
  /** Текущий остаток в ремфонде (0 для добавленных вручную позиций). */
  bookQty: number;
  /** Фактическое количество (редактируемое). */
  actualQty: string;
  unitName: string | null;
  /** Добавлена оператором (не была в фонде на момент загрузки). */
  isNew: boolean;
};

/**
 * Фаза 0 учёта ремфонда (план docs/plans/repair-fund-2026-06.md): инструмент
 * массового прямого ввода списка деталей в ремонтный фонд, минуя дефектовку.
 * Семантика ревизии (set-абсолют): показывает текущее содержимое ремфонда,
 * оператор правит фактические количества и/или добавляет детали, затем проводит
 * → остатки локации `repair_fund` приводятся к внесённым (документ инвентаризации,
 * delta = факт − учёт). Личные номера — отдельной фазой.
 */
export function RepairFundAuditPage(props: {
  canEdit: boolean;
  onOpenDocument: (id: string) => void;
}) {
  const { nomenclature, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData({ loadNomenclature: true });
  const { pushRecent, withRecents } = useRecentSelectOptions('matrica:repair-fund-audit-recents', 8);
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('Ревизия ремонтного фонда');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<FundLine[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [posting, setPosting] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const nomById = useMemo(() => new Map(nomenclature.map((i) => [String(i.id), i])), [nomenclature]);
  const nomenclatureOptions = useMemo(
    () => withRecents('nomenclatureId', nomenclature.map((item) => ({ id: item.id, label: `${item.name} (${item.code})` }))),
    [nomenclature, withRecents],
  );

  const visibleRows = useMemo(
    () => rows.filter((row) => matchesQueryInRecord(query, { code: row.code, name: row.name })),
    [query, rows],
  );

  const changedCount = useMemo(
    () => rows.filter((row) => Number(row.actualQty || row.bookQty) !== row.bookQty).length,
    [rows],
  );

  async function loadFund() {
    setLoadingRows(true);
    setStatus('Загрузка ремонтного фонда...');
    let stockRows: Awaited<ReturnType<typeof fetchWarehouseStockAllPages>>;
    try {
      stockRows = await fetchWarehouseStockAllPages({ warehouseId: REPAIR_FUND });
    } catch (e) {
      setLoadingRows(false);
      setStatus(`Ошибка: ${String(e)}`);
      return;
    }
    setLoadingRows(false);
    const fundRows: FundLine[] = stockRows
      .map((row) => ({
        nomenclatureId: String(row.nomenclatureId ?? ''),
        code: String(row.nomenclatureCode ?? ''),
        name: String(row.nomenclatureName ?? ''),
        bookQty: Number(row.qty ?? 0),
        actualQty: String(row.qty ?? 0),
        unitName: row.unitName ?? null,
        isNew: false,
      }))
      .filter((row) => row.nomenclatureId);
    // Сохраняем добавленные вручную позиции, которых ещё нет в фонде.
    setRows((prev) => {
      const fundIds = new Set(fundRows.map((r) => r.nomenclatureId));
      const keptNew = prev.filter((r) => r.isNew && !fundIds.has(r.nomenclatureId));
      return [...keptNew, ...fundRows];
    });
    setStatus(
      fundRows.length
        ? 'Фонд загружен. Поправьте количества и/или добавьте детали, затем проведите ревизию.'
        : 'В ремонтном фонде пусто. Добавьте детали из списка ниже и укажите количество.',
    );
  }

  useEffect(() => {
    void loadFund();
  }, []);

  function addRowById(id: string | null) {
    if (!id) return;
    if (rows.some((row) => row.nomenclatureId === id)) {
      setStatus('Эта деталь уже в списке.');
      return;
    }
    const item = nomById.get(id);
    if (!item) return;
    setRows((prev) => [
      {
        nomenclatureId: id,
        code: String(item.code ?? ''),
        name: String(item.name ?? ''),
        bookQty: 0,
        actualQty: '',
        unitName: item.unitName ?? null,
        isNew: true,
      },
      ...prev,
    ]);
    pushRecent('nomenclatureId', id);
    setStatus('');
  }

  function removeRow(nomenclatureId: string) {
    setRows((prev) => prev.filter((row) => row.nomenclatureId !== nomenclatureId));
  }

  async function postAudit() {
    const lines = rows
      .map((row) => {
        const actual = Number(row.actualQty || row.bookQty);
        return {
          qty: 0,
          nomenclatureId: row.nomenclatureId,
          warehouseId: REPAIR_FUND,
          bookQty: row.bookQty,
          actualQty: Number.isFinite(actual) ? actual : row.bookQty,
        };
      })
      .filter((line) => line.actualQty !== line.bookQty);
    if (lines.length === 0) {
      setStatus('Нет изменений для проведения: фактические количества совпадают с учётными.');
      return;
    }
    setPosting(true);
    setStatus('Создаю и провожу документ ревизии...');
    try {
      const now = Date.now();
      const created = await window.matrica.warehouse.documentCreate({
        docType: 'stock_inventory',
        docNo: `RF-${String(now).slice(-8)}`,
        docDate: now,
        header: {
          warehouseId: REPAIR_FUND,
          reason: reason.trim() || 'Ревизия ремонтного фонда',
          counterpartyId: null,
        },
        lines,
      });
      if (!created?.ok || !created.id) {
        setStatus(`Ошибка: ${String(!created?.ok && created ? created.error : 'не удалось создать документ')}`);
        return;
      }
      const posted = await window.matrica.warehouse.documentPost(String(created.id));
      if (!posted?.ok) {
        setStatus(
          `Документ создан, но не проведён: ${String((posted as { error?: string })?.error ?? 'ошибка проводки')}. Открываю документ — проведите вручную.`,
        );
        props.onOpenDocument(String(created.id));
        return;
      }
      setStatus(`Ревизия проведена (${lines.length} строк). Остатки ремонтного фонда обновлены.`);
      await loadFund();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setPosting(false);
    }
  }

  function renderRow(row: FundLine) {
    const actualQty = Number(row.actualQty || row.bookQty);
    const delta = actualQty - row.bookQty;
    return (
      <tr key={row.nomenclatureId}>
        <td data-col-kind="name">{row.code || '—'}</td>
        <td data-col-kind="name">
          {row.name || '—'}
          {row.isNew ? <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--success)' }}>новая</span> : null}
        </td>
        <td>{row.unitName || '—'}</td>
        <td data-col-kind="num">{row.bookQty}</td>
        <td>
          <Input
            type="number"
            value={row.actualQty}
            disabled={!props.canEdit}
            onChange={(e) =>
              setRows((prev) =>
                prev.map((item) => (item.nomenclatureId === row.nomenclatureId ? { ...item, actualQty: e.target.value } : item)),
              )
            }
          />
        </td>
        <td data-col-kind="num" style={{ color: delta === 0 ? 'var(--subtle)' : delta > 0 ? 'var(--success)' : 'var(--danger)' }}>
          {delta > 0 ? `+${delta}` : delta}
        </td>
        <td>
          {props.canEdit && row.isNew ? (
            <Button variant="ghost" size="sm" title="Убрать строку" onClick={() => removeRow(row.nomenclatureId)}>
              ✕
            </Button>
          ) : null}
        </td>
      </tr>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Ревизия ремонтного фонда</div>
        <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
          Прямой ввод деталей в «{REPAIR_FUND_LABEL}» (детали, ожидающие ремонта). Добавьте детали и укажите фактическое
          количество — при проведении остатки фонда приводятся к внесённым. Учёт количественный (личные номера — отдельной фазой).
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'center' }}>
          <div>Основание</div>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} disabled={!props.canEdit} />
          <div>Добавить деталь</div>
          <SearchSelect
            value={null}
            options={nomenclatureOptions}
            placeholder="Найдите деталь и выберите — она добавится в список"
            showAllWhenEmpty
            emptyQueryLimit={20}
            disabled={!props.canEdit}
            onChange={(next) => addRowById(next)}
          />
        </div>
        {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="ghost" onClick={() => void loadFund()} disabled={loadingRows}>
            {loadingRows ? 'Загрузка...' : 'Обновить фонд'}
          </Button>
          <Button variant="ghost" onClick={() => void refreshRefs()}>
            Обновить справочники
          </Button>
          {props.canEdit ? (
            <Button onClick={() => void postAudit()} disabled={posting || changedCount === 0}>
              {posting ? 'Провожу...' : `Провести ревизию${changedCount ? ` (${changedCount})` : ''}`}
            </Button>
          ) : null}
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ fontWeight: 700 }}>Детали в фонде</div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по коду и наименованию..."
            style={{ maxWidth: 360 }}
          />
        </div>
        {/* Без виртуализации — редактируемое поле «Факт» не должно размонтироваться при прокрутке. */}
        <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div style={{ border: '1px solid #e5e7eb' }}>
            <table className="list-table">
              <thead>
                <tr>
                  <th data-col-kind="name" style={{ textAlign: 'left' }}>Код</th>
                  <th data-col-kind="name" style={{ textAlign: 'left' }}>Деталь</th>
                  <th style={{ textAlign: 'left' }}>Ед.</th>
                  <th data-col-kind="num" title="Текущий остаток в фонде" style={{ textAlign: 'left' }}>В фонде</th>
                  <th style={{ textAlign: 'left' }}>Факт</th>
                  <th data-col-kind="num" title="Изменение" style={{ textAlign: 'left' }}>Изменение</th>
                  <th style={{ textAlign: 'left' }}></th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 ? (
                  <tr>
                    <td style={{ padding: 10, color: '#6b7280' }} colSpan={7}>
                      Список пуст. Добавьте детали через поле «Добавить деталь» выше.
                    </td>
                  </tr>
                ) : (
                  visibleRows.map((row) => renderRow(row))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div style={{ padding: '4px 0 2px', flex: '0 0 auto', fontSize: 12, color: '#9ca3af' }}>Всего: {visibleRows.length}</div>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
    </div>
  );
}
