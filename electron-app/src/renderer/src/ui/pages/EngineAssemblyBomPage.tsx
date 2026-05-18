import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { escapeHtml, openPrintPreview, type PrintSection } from '../utils/printPreview.js';

type BomListRow = {
  id: string;
  name: string;
  engineBrandIds: string[];
  engineNomenclatureId?: string | null;
  engineNomenclatureCode?: string | null;
  engineNomenclatureName?: string | null;
  version: number;
  status: string;
  isDefault: boolean;
  linesCount: number;
  updatedAt: number;
};

type BomDetailsFull = {
  header: {
    id: string;
    name: string;
    engineBrandIds: string[];
    status: string;
    isDefault: boolean;
    version: number;
    notes?: string | null;
  };
  lines: Array<{
    componentNomenclatureId: string;
    componentNomenclatureCode?: string | null;
    componentNomenclatureName?: string | null;
    componentType: string;
    qtyPerUnit: number;
    variantGroup?: string | null;
    lineKey?: string | null;
    parentLineKey?: string | null;
    isRequired: boolean;
    priority: number;
    notes?: string | null;
  }>;
};
type BomLineFull = BomDetailsFull['lines'][number];

const COMPONENT_TYPE_LABELS: Record<string, string> = {
  sleeve: 'Гильза',
  piston: 'Поршень',
  ring: 'Кольцо',
  jacket: 'Рубашка',
  head: 'Головка',
  carter: 'Картер',
  other: 'Прочее',
};

function lineLabel(line: BomLineFull): string {
  return line.componentNomenclatureName || line.componentNomenclatureCode || line.componentNomenclatureId || '—';
}

function brandsLabel(ids: string[], labels: Map<string, string>): string {
  if (!ids.length) return '—';
  return ids.map((id) => labels.get(id) ?? id).join(', ');
}

function buildAllBomsPrintHtml(
  boms: BomDetailsFull[],
  brandLabelById: Map<string, string>,
): { sections: PrintSection[]; legendHtml: string } {
  const componentSet = new Map<string, { name: string; code: string; type: string }>();
  const sections: PrintSection[] = [];

  for (const bom of boms) {
    const brands = (bom.header.engineBrandIds ?? []).map((id) => brandLabelById.get(String(id)) ?? String(id)).join(', ') || '—';
    const lines = [...bom.lines].sort((a, b) => {
      const ap = Number(a.priority ?? 100);
      const bp = Number(b.priority ?? 100);
      if (ap !== bp) return ap - bp;
      return lineLabel(a).localeCompare(lineLabel(b), 'ru');
    });

    for (const line of lines) {
      const id = String(line.componentNomenclatureId ?? '');
      if (id && !componentSet.has(id)) {
        componentSet.set(id, {
          name: line.componentNomenclatureName || '—',
          code: line.componentNomenclatureCode || '—',
          type: COMPONENT_TYPE_LABELS[line.componentType] || line.componentType || '—',
        });
      }
    }

    const rowsHtml = lines
      .map((line) => {
        const type = COMPONENT_TYPE_LABELS[line.componentType] || escapeHtml(line.componentType || '—');
        const component = escapeHtml(lineLabel(line));
        const qty = String(Number(line.qtyPerUnit ?? 0));
        const required = line.isRequired !== false ? 'Да' : '—';
        const vg = String(line.variantGroup ?? '').trim();
        return `<tr><td>${type}</td><td>${component}</td><td style="text-align:center">${escapeHtml(qty)}</td><td style="text-align:center">${required}</td>${vg ? `<td>${escapeHtml(vg)}</td>` : '<td>—</td>'}</tr>`;
      })
      .join('');

    const tableHtml = `<div style="margin-bottom:4px;font-size:11px;color:#6b7280">Марки: ${escapeHtml(brands)} · версия ${bom.header.version} · строк: ${lines.length}</div>
<table><thead><tr><th>Тип</th><th>Компонент</th><th style="text-align:center">Кол-во/двиг.</th><th style="text-align:center">Обяз.</th><th>Вариант</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;

    sections.push({
      id: `bom-${bom.header.id}`,
      title: String(bom.header.name || 'BOM без названия'),
      html: tableHtml,
      checked: true,
    });
  }

  const legendRows = Array.from(componentSet.entries())
    .sort((a, b) => a[1].type.localeCompare(b[1].type, 'ru') || a[1].name.localeCompare(b[1].name, 'ru'))
    .map(([, c]) => `<tr><td>${escapeHtml(c.type)}</td><td>${escapeHtml(c.code)}</td><td>${escapeHtml(c.name)}</td></tr>`)
    .join('');

  const legendHtml = legendRows
    ? `<table><thead><tr><th>Тип</th><th>Код</th><th>Наименование</th></tr></thead><tbody>${legendRows}</tbody></table>`
    : '<div class="muted">Нет компонентов</div>';

  return { sections, legendHtml };
}

type SortKey = 'name' | 'brand' | 'version' | 'lines' | 'updatedAt';

export function EngineAssemblyBomPage(props: {
  canEdit: boolean;
  onOpen: (id: string) => void;
}) {
  const { error: refsError, lookups } = useWarehouseReferenceData();
  const [status, setStatus] = useState('');
  const [engineBrandIdFilter, setEngineBrandIdFilter] = useState<string[]>([]);
  const [rows, setRows] = useState<BomListRow[]>([]);
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка BOM...');
      const result = await window.matrica.warehouse.assemblyBomList(
        engineBrandIdFilter.length > 0 ? { engineBrandIds: engineBrandIdFilter } : undefined,
      );
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      setRows((result.rows ?? []) as unknown as BomListRow[]);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [engineBrandIdFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        const la = brandsLabel(a.engineBrandIds ?? [], brandLabelById);
        const lb = brandsLabel(b.engineBrandIds ?? [], brandLabelById);
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

  const [printing, setPrinting] = useState(false);

  const handlePrintAll = useCallback(async () => {
    if (!sortedRows.length) return;
    setPrinting(true);
    setStatus('Загрузка BOM для печати...');
    try {
      const details: BomDetailsFull[] = [];
      for (const row of sortedRows) {
        const result = await window.matrica.warehouse.assemblyBomGet(String(row.id));
        if (result?.ok) {
          const bom = (result as { ok: true; bom: unknown }).bom as BomDetailsFull;
          if (bom) details.push(bom);
        }
      }
      if (!details.length) {
        setStatus('Ошибка: не удалось загрузить BOM-спецификации');
        return;
      }
      const { sections, legendHtml } = buildAllBomsPrintHtml(details, brandLabelById);
      sections.push({
        id: 'legend',
        title: 'Легенда компонентов',
        html: legendHtml,
        checked: true,
      });
      openPrintPreview({
        title: 'Спецификации сборки двигателей (BOM)',
        subtitle: `Всего спецификаций: ${details.length} · дата: ${new Date().toLocaleDateString('ru-RU')}`,
        sections,
      });
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка печати: ${String(e)}`);
    } finally {
      setPrinting(false);
    }
  }, [brandLabelById, sortedRows]);

  const selectedEngineBrandId = engineBrandIdFilter.length === 1 ? engineBrandIdFilter[0] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(320px, 1fr) auto auto', alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Марка двигателя (фильтр списка)</span>
          <MultiSearchSelect
            values={engineBrandIdFilter}
            options={engineBrandOptions}
            placeholder="Все марки"
            onChange={(value) => {
              setPageIndex(0);
              setEngineBrandIdFilter(value);
            }}
          />
        </label>
        <Button
          onClick={() => void handlePrintAll()}
          disabled={printing || sortedRows.length === 0}
        >
          {printing ? 'Загрузка...' : 'Печать всех BOM'}
        </Button>
        {props.canEdit ? (
          <Button
            onClick={async () => {
              if (!selectedEngineBrandId) {
                setStatus('Ошибка: сначала выберите одну марку двигателя.');
                return;
              }
              const created = await window.matrica.warehouse.assemblyBomUpsert({
                name: `BOM ${engineBrandOptions.find((brand) => brand.id === selectedEngineBrandId)?.label ?? 'марки двигателя'}`,
                engineBrandIds: [selectedEngineBrandId],
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
            disabled={!selectedEngineBrandId}
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
                    <div>{brandsLabel(row.engineBrandIds ?? [], brandLabelById)}</div>
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
