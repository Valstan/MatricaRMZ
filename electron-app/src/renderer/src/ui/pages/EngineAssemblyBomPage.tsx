import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';

type BomListRow = {
  id: string;
  name: string;
  engineNomenclatureId: string;
  engineNomenclatureCode?: string | null;
  engineNomenclatureName?: string | null;
  version: number;
  status: string;
  isDefault: boolean;
  linesCount: number;
  updatedAt: number;
};

type EngineNomenclatureRow = {
  id: string;
  code: string;
  name: string;
  itemType: string;
  category: string;
  defaultBrandId: string;
  defaultBrandName: string;
  isSerialTracked: boolean;
};

type SortKey = 'name' | 'engine' | 'version' | 'lines' | 'updatedAt';

function toEngineNomenclatureRow(input: unknown): EngineNomenclatureRow {
  const row = (input ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? '').trim(),
    code: String(row.code ?? '').trim(),
    name: String(row.name ?? '').trim(),
    itemType: String(row.itemType ?? '').trim().toLowerCase(),
    category: String(row.category ?? '').trim().toLowerCase(),
    defaultBrandId: String(row.defaultBrandId ?? '').trim(),
    defaultBrandName: String(row.defaultBrandName ?? '').trim(),
    isSerialTracked: Boolean(row.isSerialTracked),
  };
}

function isEngineLikeNomenclatureRow(row: EngineNomenclatureRow): boolean {
  if (!row.id) return false;
  if (row.itemType === 'engine') return true;
  if (row.category === 'engine') return true;
  if (row.isSerialTracked) return true;
  // Legacy imports can miss itemType but keep an engine brand link.
  if (row.defaultBrandId) return true;
  return false;
}

export function EngineAssemblyBomPage(props: {
  canEdit: boolean;
  onOpen: (id: string) => void;
}) {
  const { error: refsError, lookups } = useWarehouseReferenceData();
  const [status, setStatus] = useState('');
  const [engineBrandIdFilter, setEngineBrandIdFilter] = useState<string | null>(null);
  const [engineRows, setEngineRows] = useState<EngineNomenclatureRow[]>([]);
  const [rows, setRows] = useState<BomListRow[]>([]);
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка BOM...');
      const result = await window.matrica.warehouse.assemblyBomList();
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      let nextRows = (result.rows ?? []) as BomListRow[];
      if (engineBrandIdFilter) {
        const allowedEngineIds = new Set(
          engineRows
            .filter((row) => row.defaultBrandId === engineBrandIdFilter)
            .map((row) => row.id),
        );
        nextRows = nextRows.filter((row) => allowedEngineIds.has(String(row.engineNomenclatureId)));
      }
      setRows(nextRows);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [engineBrandIdFilter, engineRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    const loadEngineOptions = async () => {
      const list = await window.matrica.warehouse.nomenclatureList({
        isActive: true,
        limit: 5000,
      });
      if (!alive || !list?.ok) return;
      const parsed = (list.rows ?? []).map(toEngineNomenclatureRow);
      const nextEngineRows = parsed.filter(isEngineLikeNomenclatureRow);
      setEngineRows(nextEngineRows);
    };
    void loadEngineOptions();
    return () => {
      alive = false;
    };
  }, []);

  const engineBrandOptions = useMemo(
    () =>
      (lookups.engineBrands ?? [])
        .map((brand) => ({
          id: String(brand.id ?? ''),
          label: String(brand.label ?? ''),
          hintText: brand.code ? String(brand.code) : undefined,
        }))
        .filter((brand) => brand.id && brand.label)
        .sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    [lookups.engineBrands],
  );

  const brandByEngineNomenclatureId = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of engineRows) {
      if (!row.id || !row.defaultBrandName) continue;
      map.set(row.id, row.defaultBrandName);
    }
    return map;
  }, [engineRows]);

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      else if (sortKey === 'engine') cmp = String(a.engineNomenclatureName ?? a.engineNomenclatureCode ?? '').localeCompare(String(b.engineNomenclatureName ?? b.engineNomenclatureCode ?? ''), 'ru');
      else if (sortKey === 'version') cmp = Number(a.version ?? 0) - Number(b.version ?? 0);
      else if (sortKey === 'lines') cmp = Number(a.linesCount ?? 0) - Number(b.linesCount ?? 0);
      else if (sortKey === 'updatedAt') cmp = Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0);
      if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      return cmp * dir;
    });
  }, [rows, sortDir, sortKey]);
  const pagedRows = useMemo(() => {
    const start = pageIndex * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [pageIndex, pageSize, sortedRows]);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(320px, 1fr) auto auto' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Марка двигателя</span>
          <SearchSelect
            value={engineBrandIdFilter}
            options={engineBrandOptions}
            placeholder="Выберите марку двигателя"
            showAllWhenEmpty
            onChange={(value) => {
              setPageIndex(0);
              setEngineBrandIdFilter(value);
            }}
          />
        </label>
        {props.canEdit ? (
          <Button
            onClick={async () => {
              if (!engineBrandIdFilter) {
                setStatus('Ошибка: сначала выберите марку двигателя.');
                return;
              }
              const enginesForBrand = engineRows
                .filter((row) => row.defaultBrandId === engineBrandIdFilter)
                .sort((a, b) => (a.name || a.code || a.id).localeCompare(b.name || b.code || b.id, 'ru'));
              const selectedEngine = enginesForBrand[0] ?? null;
              if (!selectedEngine?.id) {
                setStatus('Ошибка: для выбранной марки не найдена номенклатура двигателя.');
                return;
              }
              const existing = rows.find((row) => String(row.engineNomenclatureId) === String(selectedEngine.id));
              if (existing?.id) {
                setStatus('Для выбранного двигателя спецификация уже существует. Открываем текущую карточку.');
                props.onOpen(String(existing.id));
                return;
              }
              if (enginesForBrand.length > 1) {
                setStatus(`Выбрана первая номенклатура двигателя для марки: ${selectedEngine.name || selectedEngine.code || selectedEngine.id}.`);
              }
              const created = await window.matrica.warehouse.assemblyBomUpsert({
                name: `BOM ${engineBrandOptions.find((brand) => brand.id === engineBrandIdFilter)?.label ?? 'марки двигателя'}`,
                engineNomenclatureId: selectedEngine.id,
                status: 'active',
                isDefault: true,
                lines: [],
              });
              if (!created?.ok || !created.id) {
                setStatus(`Ошибка: ${String(!created?.ok && created ? created.error : 'не удалось создать BOM')}`);
                return;
              }
              await refresh();
              props.onOpen(String(created.id));
            }}
            disabled={!engineBrandIdFilter}
          >
            Создать BOM
          </Button>
        ) : null}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" onClick={() => void refresh()}>
            Обновить
          </Button>
          {engineBrandIdFilter ? (
            <Button
              variant="ghost"
              onClick={() => {
                setEngineBrandIdFilter(null);
                setPageIndex(0);
              }}
            >
              Сбросить фильтр
            </Button>
          ) : null}
        </div>
      </div>
      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
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
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>{sortLabel('Название', 'name')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('engine')}>{sortLabel('Марка двигателя', 'engine')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('version')}>{sortLabel('Версия', 'version')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('lines')}>{sortLabel('Строк', 'lines')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>{sortLabel('Обновлено', 'updatedAt')}</th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 12 }}>
                  Нет BOM-спецификаций
                </td>
              </tr>
            ) : (
              pagedRows.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(String(row.id))}>
                  <td>{row.name || '—'}</td>
                  <td>{brandByEngineNomenclatureId.get(String(row.engineNomenclatureId)) || row.engineNomenclatureName || row.engineNomenclatureCode || row.engineNomenclatureId}</td>
                  <td>{Number(row.version ?? 1)}</td>
                  <td>{Number(row.linesCount ?? 0)}</td>
                  <td>{row.updatedAt ? new Date(Number(row.updatedAt)).toLocaleString('ru-RU') : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
