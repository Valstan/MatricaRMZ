import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { openPrintPreview } from '../utils/printPreview.js';
import { formatListDateTime } from '../utils/dateUtils.js';
import { componentTypeLabelsFromSchema } from '../utils/componentTypeLabels.js';
import { BOM_COMPARE_PRINT_CSS, buildAllBomsPrintHtml, buildBomComparisonSections, type BomPrintDoc } from '../utils/bomPrint.js';
import { BRAND_LABEL_TEXTS, lookupLabel } from '../utils/lookupLabel.js';

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
  /** Количество вариантов сборки = уникальных scope'ов (base + __kit_*) в строках BOM. */
  variantsCount: number;
  updatedAt: number;
};

function brandsLabel(ids: string[], labels: Map<string, string>): string {
  if (!ids.length) return BRAND_LABEL_TEXTS.absent;
  return ids.map((id) => lookupLabel(id, (key) => labels.get(key), BRAND_LABEL_TEXTS)).join(', ');
}

type SortKey = 'name' | 'brand' | 'version' | 'variants' | 'updatedAt';

export function EngineAssemblyBomPage(props: {
  canEdit: boolean;
  onOpen: (id: string) => void;
}) {
  const { error: refsError, lookups } = useWarehouseReferenceData();
  const [status, setStatus] = useState('');
  const [engineBrandIdFilter, setEngineBrandIdFilter] = useState<string[]>([]);
  const [rows, setRows] = useState<BomListRow[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const containerRef = useRef<HTMLDivElement | null>(null);

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
      // Идентификатор в словарь не кладём — он доезжал прямо в чип марки. Следствие,
      // названное осознанно: строки с безымянными марками попадают в один класс сортировки.
      const label = String(b.label ?? '').trim();
      if (label) map.set(id, label);
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
      else if (sortKey === 'variants') cmp = Number(a.variantsCount ?? 0) - Number(b.variantsCount ?? 0);
      else if (sortKey === 'updatedAt') cmp = Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0);
      if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      return cmp * dir;
    });
  }, [brandLabelById, rows, sortDir, sortKey]);

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

  const [printing, setPrinting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Полные BOM грузятся по одному: спецификаций единицы, отдельная серверная точка не окупается.
  const loadPrintDocs = useCallback(async (ids: string[]) => {
    const docs: BomPrintDoc[] = [];
    for (const id of ids) {
      const result = await window.matrica.warehouse.assemblyBomGet(id);
      if (result?.ok && result.bom) docs.push(result.bom as unknown as BomPrintDoc);
    }
    // Подписи и порядок типов — из живой схемы (там и типы, заведённые оператором); без неё — словарь.
    const schemaResult = await window.matrica.warehouse.assemblyBomSchemaGet();
    const typeLabels = schemaResult?.ok ? componentTypeLabelsFromSchema(schemaResult.schema) : undefined;
    const typeOrder = new Map<string, number>();
    if (schemaResult?.ok) for (const node of schemaResult.schema.nodes ?? []) typeOrder.set(String(node.typeId).toLowerCase(), Number(node.sortOrder ?? 100));
    return {
      docs,
      labels: { brandsLabel: (brandIds: string[]) => brandsLabel(brandIds, brandLabelById), ...(typeLabels ? { typeLabels } : {}), typeOrder },
    };
  }, [brandLabelById]);

  const handlePrintAll = useCallback(async () => {
    if (!sortedRows.length) return;
    setPrinting(true);
    setStatus('Загрузка BOM для печати...');
    try {
      const { docs, labels } = await loadPrintDocs(sortedRows.map((row) => String(row.id)));
      if (!docs.length) {
        setStatus('Ошибка: не удалось загрузить BOM-спецификации');
        return;
      }
      const { sections, legendHtml } = buildAllBomsPrintHtml(docs, labels);
      sections.push({ id: 'legend', title: 'Легенда компонентов', html: legendHtml, checked: true });
      openPrintPreview({
        title: 'Спецификации сборки двигателей (BOM)',
        subtitle: `Всего спецификаций: ${docs.length} · дата: ${new Date().toLocaleDateString('ru-RU')}`,
        sections,
      });
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка печати: ${String(e)}`);
    } finally {
      setPrinting(false);
    }
  }, [loadPrintDocs, sortedRows]);

  const handlePrintCompare = useCallback(async () => {
    const ids = sortedRows.map((row) => String(row.id)).filter((id) => selectedIds.has(id));
    if (ids.length < 2) return;
    setPrinting(true);
    setStatus('Загрузка BOM для сверки...');
    try {
      const { docs, labels } = await loadPrintDocs(ids);
      if (docs.length < 2) {
        setStatus('Ошибка: для сверки нужны хотя бы две загруженные спецификации');
        return;
      }
      openPrintPreview({
        title: 'Сверка спецификаций двигателей',
        subtitle: `${docs.map((d) => d.header.name).join(' · ')} · дата: ${new Date().toLocaleDateString('ru-RU')}`,
        sections: buildBomComparisonSections(docs, labels),
        extraCss: BOM_COMPARE_PRINT_CSS,
      });
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка печати: ${String(e)}`);
    } finally {
      setPrinting(false);
    }
  }, [loadPrintDocs, selectedIds, sortedRows]);

  const selectedEngineBrandId = engineBrandIdFilter.length === 1 ? engineBrandIdFilter[0] : null;

  const tableHeader = (
    <thead>
      <tr>
        <th style={{ width: 32 }} title="Отметьте две и более спецификации для печати сверки" />
        <th style={{ textAlign: 'left', cursor: 'pointer', minWidth: 220, width: '38%' }} onClick={() => onSort('name')}>
          {sortLabel('Название', 'name')}
        </th>
        <th style={{ textAlign: 'left', cursor: 'pointer', minWidth: 200 }} onClick={() => onSort('brand')}>
          {sortLabel('Марка двигателя', 'brand')}
        </th>
        <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('version')}>
          {sortLabel('Версия', 'version')}
        </th>
        <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('variants')} title="Количество вариантов сборки (включая общую базу, если есть)">
          {sortLabel('Вариантов', 'variants')}
        </th>
        <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>
          {sortLabel('Обновлено', 'updatedAt')}
        </th>
      </tr>
    </thead>
  );

  function rowProps(row: BomListRow): VirtualTableRowProps {
    return {
      style: { cursor: 'pointer' },
      onClick: () => props.onOpen(String(row.id)),
    };
  }

  function renderBomCells(row: BomListRow) {
    return (
      <>
        <td style={{ verticalAlign: 'top' }} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selectedIds.has(String(row.id))}
            onChange={() => toggleSelected(String(row.id))}
            aria-label="Выбрать для сверки"
          />
        </td>
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
        <td>{Number(row.variantsCount ?? 0)}</td>
        <td>{row.updatedAt ? formatListDateTime(Number(row.updatedAt)) : '—'}</td>
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(320px, 1fr) auto auto auto', alignItems: 'end' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Марка двигателя (фильтр списка)</span>
          <MultiSearchSelect
            values={engineBrandIdFilter}
            options={engineBrandOptions}
            placeholder="Все марки"
            onChange={(value) => {
              setEngineBrandIdFilter(value);
            }}
          />
        </label>
        <Button
          variant="ghost"
          onClick={() => void handlePrintCompare()}
          disabled={printing || selectedIds.size < 2}
          title="Одна таблица: строки — детали, колонки — отмеченные спецификации"
        >
          Сверка выбранных ({selectedIds.size})
        </Button>
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
      <div ref={containerRef} style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <VirtualTable
          scrollElementRef={containerRef}
          count={sortedRows.length}
          header={tableHeader}
          renderCells={(i) => renderBomCells(sortedRows[i]!)}
          getRowKey={(i) => sortedRows[i]!.id}
          getRowProps={(i) => rowProps(sortedRows[i]!)}
          colCount={6}
          estimateSize={48}
          emptyState="Нет BOM-спецификаций"
        />
      </div>
      <div style={{ padding: '4px 0 2px', flex: '0 0 auto', fontSize: 12, color: '#9ca3af' }}>Всего: {sortedRows.length}</div>
    </div>
  );
}
