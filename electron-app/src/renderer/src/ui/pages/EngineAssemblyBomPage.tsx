import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { pickEngineNomenclatureIdForEngineBrand } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';

type BomListRow = {
  id: string;
  name: string;
  engineBrandId: string;
  engineNomenclatureId?: string | null;
  engineNomenclatureCode?: string | null;
  engineNomenclatureName?: string | null;
  version: number;
  status: string;
  isDefault: boolean;
  linesCount: number;
  updatedAt: number;
};

type SortKey = 'name' | 'brand' | 'version' | 'lines' | 'updatedAt';

export function EngineAssemblyBomPage(props: {
  canEdit: boolean;
  onOpen: (id: string) => void;
}) {
  const { error: refsError, lookups } = useWarehouseReferenceData();
  const [status, setStatus] = useState('');
  const [engineBrandIdFilter, setEngineBrandIdFilter] = useState<string | null>(null);
  const [rows, setRows] = useState<BomListRow[]>([]);
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [nomenclatureMetaRows, setNomenclatureMetaRows] = useState<
    Array<{ id: string; defaultBrandId?: string | null; itemType?: string | null; category?: string | null }>
  >([]);

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка BOM...');
      const result = await window.matrica.warehouse.assemblyBomList(
        engineBrandIdFilter ? { engineBrandId: engineBrandIdFilter } : undefined,
      );
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setRows((result.rows ?? []) as BomListRow[]);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [engineBrandIdFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const result = await window.matrica.warehouse.nomenclatureList({ isActive: true, limit: 5000 });
      if (!alive || !result?.ok) return;
      const rows = result.rows ?? [];
      setNomenclatureMetaRows(
        rows.map((row) => ({
          id: String((row as { id?: string }).id ?? ''),
          defaultBrandId: ((row as { defaultBrandId?: string | null }).defaultBrandId ?? null) as string | null,
          itemType: ((row as { itemType?: string | null }).itemType ?? null) as string | null,
          category: ((row as { category?: string | null }).category ?? null) as string | null,
        })),
      );
    };
    void load();
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
          ...(brand.code ? { hintText: String(brand.code) } : {}),
        }))
        .filter((brand) => brand.id && brand.label)
        .sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    [lookups.engineBrands],
  );

  const brandLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of lookups.engineBrands ?? []) {
      const id = String(b.id ?? '').trim();
      if (!id) continue;
      map.set(id, String(b.label ?? '').trim() || id);
    }
    return map;
  }, [lookups.engineBrands]);

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      else if (sortKey === 'brand') {
        const la = brandLabelById.get(String(a.engineBrandId)) ?? String(a.engineBrandId ?? '');
        const lb = brandLabelById.get(String(b.engineBrandId)) ?? String(b.engineBrandId ?? '');
        cmp = la.localeCompare(lb, 'ru');
      } else if (sortKey === 'version') cmp = Number(a.version ?? 0) - Number(b.version ?? 0);
      else if (sortKey === 'lines') cmp = Number(a.linesCount ?? 0) - Number(b.linesCount ?? 0);
      else if (sortKey === 'updatedAt') cmp = Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0);
      if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      return cmp * dir;
    });
  }, [brandLabelById, rows, sortDir, sortKey]);
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
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(320px, 1fr) auto', alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Марка двигателя (фильтр списка)</span>
          <SearchSelect
            value={engineBrandIdFilter}
            options={engineBrandOptions}
            placeholder="Все марки"
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
              const existing = rows.find((row) => String(row.engineBrandId) === String(engineBrandIdFilter));
              if (existing?.id) {
                setStatus('Для выбранной марки спецификация уже есть. Открываем текущую карточку.');
                props.onOpen(String(existing.id));
                return;
              }
              const engineNomId = pickEngineNomenclatureIdForEngineBrand(nomenclatureMetaRows, engineBrandIdFilter);
              if (!engineNomId) {
                setStatus(
                  'Ошибка: для выбранной марки не найдена номенклатура «двигатель» (тип engine с полем «марка по умолчанию»). Создайте её в номенклатуре склада и повторите.',
                );
                return;
              }
              const created = await window.matrica.warehouse.assemblyBomUpsert({
                name: `BOM ${engineBrandOptions.find((brand) => brand.id === engineBrandIdFilter)?.label ?? 'марки двигателя'}`,
                engineBrandId: engineBrandIdFilter,
                engineNomenclatureId: engineNomId,
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
              <th style={{ textAlign: 'left', cursor: 'pointer', minWidth: 220, width: '38%' }} onClick={() => onSort('name')}>
                {sortLabel('Название', 'name')}
              </th>
              <th style={{ textAlign: 'left', cursor: 'pointer', minWidth: 200 }} onClick={() => onSort('brand')}>
                {sortLabel('Марка двигателя', 'brand')}
              </th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('version')}>
                {sortLabel('Версия', 'version')}
              </th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('lines')}>
                {sortLabel('Строк', 'lines')}
              </th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>
                {sortLabel('Обновлено', 'updatedAt')}
              </th>
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
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word', verticalAlign: 'top' }}>{row.name || '—'}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word', verticalAlign: 'top' }}>
                    <div>{brandLabelById.get(String(row.engineBrandId)) || row.engineBrandId || '—'}</div>
                    {row.engineNomenclatureName || row.engineNomenclatureCode ? (
                      <div style={{ fontSize: 12, color: 'var(--subtle)', marginTop: 2 }}>
                        Устар. номенклатура: {row.engineNomenclatureName || row.engineNomenclatureCode || row.engineNomenclatureId || '—'}
                      </div>
                    ) : null}
                  </td>
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
