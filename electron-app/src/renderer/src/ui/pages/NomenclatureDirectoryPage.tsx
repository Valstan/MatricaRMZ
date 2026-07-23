import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tryParseWarehousePartNomenclatureMirror, type NomenclatureItemType, type WarehouseNomenclatureListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { Input } from '../components/Input.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { listHeaderKindProps, listCellKindProps, type ListColumnKind } from '../utils/listColumnKinds.js';
import { createNomenclatureLineFromPreset } from '../utils/createWarehouseNomenclatureFromDirectory.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { promptNomenclatureArticle } from '../utils/promptNomenclatureArticle.js';
import { parseIdArray } from '../utils/groupBrandIds.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';

type CreateConfig = {
  codePrefix: string;
  name: string;
  itemType: NomenclatureItemType;
  category: string;
};

type SortKey = 'code' | 'name' | 'sku' | 'parts' | 'price' | 'brands' | 'unit' | 'description' | 'attachments' | 'updatedAt';


export function NomenclatureDirectoryPage(props: {
  onOpen: (id: string) => Promise<void>;
  onOpenNomenclatureCatalog?: () => void;
  canCreate: boolean;
  canView?: boolean;
  noAccessText?: string;
  directoryKind: string;
  emptyText: string;
  searchPlaceholder: string;
  createButtonText: string;
  createConfig: CreateConfig;
  secondaryAction?: React.ReactNode;
  /**
   * Deferred-create (товары/услуги): кнопка создания НЕ пишет в базу, а открывает пустую
   * карточку с клиентским UUID — сущность и номенклатурная строка материализуются первым
   * «Сохранить» в карточке. Без пропа — легаси-путь (немедленное создание по пресету).
   */
  onCreateDeferred?: () => void;
}) {
  const [rows, setRows] = useState<WarehouseNomenclatureListItem[]>([]);
  const { promptText } = useConfirm();
  const [servicePrices, setServicePrices] = useState<Record<string, number | null>>({});
  const [serviceBrandIds, setServiceBrandIds] = useState<Record<string, string[]>>({});
  const [serviceUnits, setServiceUnits] = useState<Record<string, string>>({});
  const [serviceDescriptions, setServiceDescriptions] = useState<Record<string, string>>({});
  const [serviceAttachmentsCount, setServiceAttachmentsCount] = useState<Record<string, number>>({});
  const [engineBrandNames, setEngineBrandNames] = useState<Record<string, string>>({});
  const [brandPartCounts, setBrandPartCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const width = useWindowWidth();
  const { isMultiColumn } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const canView = props.canView !== false;
  const directoryLabel = ({ part: 'деталь', tool: 'инструмент', good: 'товар', service: 'услуга' } as Record<string, string>)[
    String(props.directoryKind ?? '').trim().toLowerCase()
  ] ?? props.directoryKind;

  function buildCreateHint(statusText: string): string | null {
    const text = String(statusText ?? '');
    if (!text.startsWith('Ошибка')) return null;
    if (text.includes('карточку источника')) {
      return 'Не создана карточка в исходном справочнике. Проверьте права на справочники и повторите создание.';
    }
    if (text.includes('не найден шаблон номенклатуры')) {
      return `Для создания "${directoryLabel}" нужен шаблон номенклатуры: откройте "Склад → Номенклатура", блок "Шаблоны номенклатуры", добавьте шаблон для источника "${props.directoryKind}" и текущего типа, затем повторите.`;
    }
    if (text.includes('группа номенклатуры') || text.includes('единица измерения')) {
      return 'Не настроены базовые справочники склада. Добавьте хотя бы одну группу номенклатуры и одну единицу измерения в "Склад → Номенклатура".';
    }
    if (text.includes('не удалось загрузить шаблоны номенклатуры') || text.includes('не удалось загрузить справочники')) {
      return 'Проверьте соединение с сервером/синхронизацию и права доступа, затем нажмите "Обновить".';
    }
    return null;
  }

  function shouldShowOpenNomenclatureAction(statusText: string): boolean {
    const text = String(statusText ?? '');
    if (!text.startsWith('Ошибка')) return false;
    return (
      text.includes('шаблон номенклатуры') ||
      text.includes('группа номенклатуры') ||
      text.includes('единица измерения')
    );
  }

  function parsePriceFromSpec(specJson: string | null | undefined): number | null {
    if (!specJson) return null;
    try {
      const parsed = JSON.parse(String(specJson)) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return null;
      const direct = Number((parsed as any).price);
      if (Number.isFinite(direct)) return Math.max(0, direct);
      const attrsPrice = Number((parsed as any)?.attributes?.price);
      if (Number.isFinite(attrsPrice)) return Math.max(0, attrsPrice);
      return null;
    } catch {
      return null;
    }
  }

  function formatPrice(value: number | null | undefined): string {
    if (!Number.isFinite(Number(value))) return '—';
    const rounded = Math.round(Number(value));
    return `${rounded.toLocaleString('ru-RU')} ₽`;
  }

  function looksLikeLegacyDirectoryRow(row: WarehouseNomenclatureListItem): boolean {
    const code = String((row as any).code ?? '').trim().toLowerCase();
    const itemType = String((row as any).itemType ?? '').trim().toLowerCase();
    const specRaw = String((row as any).specJson ?? '');
    const specJson = specRaw.trim().toLowerCase();
    const directoryKind = String((row as any).directoryKind ?? '').trim().toLowerCase();
    const category = String((row as any).category ?? '').trim().toLowerCase();
    const isPartMirror = tryParseWarehousePartNomenclatureMirror(specRaw) != null;

    if (props.directoryKind === 'part') {
      return itemType === 'component' || code.startsWith('det-') || specJson.includes('"source":"part"');
    }
    if (props.directoryKind === 'tool') {
      if (['part', 'good', 'service', 'engine_brand'].includes(directoryKind)) return false;
      if (isPartMirror) return false;
      return directoryKind === 'tool' || itemType === 'tool_consumable' || code.startsWith('tls-');
    }
    if (props.directoryKind === 'good') {
      if (['part', 'tool', 'service', 'engine_brand'].includes(directoryKind)) return false;
      if (isPartMirror) return false;
      if (directoryKind === 'good') return true;
      return (itemType === 'product' && category === 'assembly') || code.startsWith('prd-') || specJson.includes('"source":"good"');
    }
    if (props.directoryKind === 'service') {
      if (['part', 'tool', 'good', 'engine_brand'].includes(directoryKind)) return false;
      if (isPartMirror) return false;
      if (directoryKind === 'service') return true;
      return (itemType === 'product' && category === 'service') || code.startsWith('srv-') || specJson.includes('"source":"service"');
    }
    return false;
  }

  const refresh = useCallback(async () => {
    if (!canView) return;
    try {
      setStatus('Загрузка...');
      const result = await window.matrica.warehouse.nomenclatureList({
        directoryKind: props.directoryKind,
        ...(query.trim() ? { search: query.trim() } : {}),
        limit: 1000,
        offset: 0,
      });
      if (!result?.ok) {
        setStatus(`Ошибка: ${String(result?.error ?? 'unknown')}`);
        return;
      }
      const strictRows = (result.rows ?? []) as WarehouseNomenclatureListItem[];
      const legacyDirectoryKinds = new Set(['part', 'tool', 'good', 'service']);
      const tryLegacyFallback = strictRows.length === 0 && legacyDirectoryKinds.has(props.directoryKind);
      if (strictRows.length > 0 || !tryLegacyFallback) {
        setRows(strictRows);
        setStatus('');
        return;
      }
      // Legacy fallback: позиции из единой номенклатуры склада без заполненного directory_kind (или со старыми признаками).
      const fallback = await window.matrica.warehouse.nomenclatureList({
        ...(query.trim() ? { search: query.trim() } : {}),
        limit: 1000,
        offset: 0,
      });
      if (!fallback?.ok) {
        setRows(strictRows);
        setStatus('');
        return;
      }
      const fallbackRows = ((fallback.rows ?? []) as WarehouseNomenclatureListItem[]).filter(looksLikeLegacyDirectoryRow);
      setRows(fallbackRows);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [canView, props.directoryKind, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!canView) return;
    if (props.directoryKind !== 'engine_brand') {
      setBrandPartCounts({});
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const specsResult = await window.matrica.warehouse.nomenclaturePartSpecsList();
        if (!alive || !specsResult?.ok) return;
        const counts: Record<string, number> = {};
        for (const part of specsResult.rows ?? []) {
          for (const link of part.brandLinks ?? []) {
            const brandId = String(link.engineBrandId ?? '').trim();
            if (!brandId) continue;
            counts[brandId] = (counts[brandId] ?? 0) + 1;
          }
        }
        if (alive) setBrandPartCounts(counts);
      } catch {
        if (alive) setBrandPartCounts({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [canView, props.directoryKind, rows]);

  const sortedRows = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'code') cmp = String(a.code ?? '').localeCompare(String(b.code ?? ''), 'ru');
      else if (sortKey === 'name') cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      else if (sortKey === 'sku') cmp = String(a.sku ?? '').localeCompare(String(b.sku ?? ''), 'ru');
      else if (sortKey === 'parts') cmp = (brandPartCounts[String(a.id)] ?? 0) - (brandPartCounts[String(b.id)] ?? 0);
      else if (sortKey === 'price') cmp = Number(servicePrices[String(a.id)] ?? -1) - Number(servicePrices[String(b.id)] ?? -1);
      else if (sortKey === 'brands') cmp = (serviceBrandIds[String(a.id)]?.length ?? 0) - (serviceBrandIds[String(b.id)]?.length ?? 0);
      else if (sortKey === 'unit') cmp = String(serviceUnits[String(a.id)] ?? '').localeCompare(String(serviceUnits[String(b.id)] ?? ''), 'ru');
      else if (sortKey === 'description') cmp = String(serviceDescriptions[String(a.id)] ?? '').localeCompare(String(serviceDescriptions[String(b.id)] ?? ''), 'ru');
      else if (sortKey === 'attachments') cmp = (serviceAttachmentsCount[String(a.id)] ?? 0) - (serviceAttachmentsCount[String(b.id)] ?? 0);
      else if (sortKey === 'updatedAt') cmp = Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0);
      if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      return cmp * dir;
    });
  }, [rows, sortDir, sortKey, brandPartCounts, servicePrices, serviceBrandIds, serviceUnits, serviceDescriptions, serviceAttachmentsCount]);

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

  type ServiceColumnDef = {
    id: string;
    label: string;
    sortKey: SortKey;
    align?: 'left' | 'right';
    kind?: ListColumnKind;
    render: (row: WarehouseNomenclatureListItem) => React.ReactNode;
  };

  const serviceColumns = useMemo<ServiceColumnDef[]>(
    () => [
      { id: 'name', label: 'Наименование', sortKey: 'name', kind: 'name', render: (row) => row.name || '—' },
      {
        id: 'price',
        label: 'Цена',
        sortKey: 'price',
        align: 'right',
        kind: 'num',
        render: (row) => formatPrice(servicePrices[String(row.id)]),
      },
      {
        id: 'brands',
        label: 'Марки двигателей',
        sortKey: 'brands',
        kind: 'text',
        render: (row) => {
          const ids = serviceBrandIds[String(row.id)] ?? [];
          if (ids.length === 0) return <span style={{ color: 'var(--subtle)' }}>универсальная</span>;
          return ids
            .map((id) => engineBrandNames[id] ?? id)
            .sort((a, b) => a.localeCompare(b, 'ru'))
            .join(', ');
        },
      },
      {
        id: 'unit',
        label: 'Ед. измерения',
        sortKey: 'unit',
        render: (row) => serviceUnits[String(row.id)] || '—',
      },
      { id: 'code', label: 'Код', sortKey: 'code', kind: 'name', render: (row) => row.code || '—' },
      { id: 'sku', label: 'SKU', sortKey: 'sku', kind: 'name', render: (row) => row.sku || '—' },
      {
        id: 'description',
        label: 'Описание',
        sortKey: 'description',
        kind: 'text',
        render: (row) => {
          const text = serviceDescriptions[String(row.id)] || '';
          if (!text) return '—';
          return text.length > 80 ? `${text.slice(0, 80)}…` : text;
        },
      },
      {
        id: 'attachments',
        label: 'Файлов',
        sortKey: 'attachments',
        align: 'right',
        kind: 'num',
        render: (row) => {
          const n = serviceAttachmentsCount[String(row.id)] ?? 0;
          return n > 0 ? String(n) : '—';
        },
      },
      {
        id: 'updatedAt',
        label: 'Дата изменения',
        sortKey: 'updatedAt',
        kind: 'date',
        render: (row) => (row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—'),
      },
    ],
    [servicePrices, serviceBrandIds, engineBrandNames, serviceUnits, serviceDescriptions, serviceAttachmentsCount],
  );
  const serviceColumnIds = useMemo(() => serviceColumns.map((c) => c.id), [serviceColumns]);
  const serviceDefaultHidden = useMemo(() => ['code', 'sku', 'description', 'attachments'], []);
  const serviceColumnLayout = useColumnLayout('list:supply-services', serviceColumnIds, serviceDefaultHidden);
  const serviceColumnsById = useMemo(() => new Map(serviceColumns.map((c) => [c.id, c])), [serviceColumns]);
  const visibleServiceColumns = useMemo(
    () =>
      serviceColumnLayout.order
        .map((id) => serviceColumnsById.get(id))
        .filter((c): c is ServiceColumnDef => Boolean(c))
        .filter((c) => serviceColumnLayout.isVisible(c.id)),
    [serviceColumnLayout.order, serviceColumnLayout.hidden, serviceColumnsById],
  );
  const serviceColumnDescriptors = useMemo<ColumnDescriptor[]>(
    () =>
      serviceColumns.map((c) => ({
        id: c.id,
        label: c.label,
        ...(c.id === 'name' ? { alwaysVisible: true } : {}),
      })),
    [serviceColumns],
  );

  useEffect(() => {
    if (!canView) return;
    if (props.directoryKind !== 'service') {
      setEngineBrandNames({});
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const types = await window.matrica.admin.entityTypes.list().catch(
          () => [] as Array<{ id: string; code: string }>,
        );
        const engineBrandType = (types as Array<{ id: string; code: string }>).find(
          (t) => String(t.code) === 'engine_brand',
        );
        if (!engineBrandType?.id) return;
        const brandRows = await window.matrica.admin.entities.listByEntityType(String(engineBrandType.id));
        const map: Record<string, string> = {};
        for (const row of (brandRows ?? []) as Array<{ id: string; attributes?: Record<string, unknown>; name?: string }>) {
          const id = String(row.id);
          const name = String(row.attributes?.name ?? row.name ?? id);
          map[id] = name;
        }
        if (alive) setEngineBrandNames(map);
      } catch {
        if (alive) setEngineBrandNames({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [canView, props.directoryKind]);

  useEffect(() => {
    if (!canView) return;
    if (props.directoryKind !== 'service') {
      setServicePrices({});
      setServiceBrandIds({});
      setServiceUnits({});
      setServiceDescriptions({});
      setServiceAttachmentsCount({});
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const priceMap: Record<string, number | null> = {};
        const brandsMap: Record<string, string[]> = {};
        const unitMap: Record<string, string> = {};
        const descMap: Record<string, string> = {};
        const attachMap: Record<string, number> = {};
        const toLoad: Array<{ id: string; directoryRefId: string | null; hasPrice: boolean }> = [];
        for (const row of rows) {
          const parsedPrice = parsePriceFromSpec(row.specJson);
          if (parsedPrice != null) priceMap[String(row.id)] = parsedPrice;
          brandsMap[String(row.id)] = [];
          unitMap[String(row.id)] = '';
          descMap[String(row.id)] = '';
          attachMap[String(row.id)] = 0;
          toLoad.push({
            id: String(row.id),
            directoryRefId: row.directoryRefId ? String(row.directoryRefId) : null,
            hasPrice: parsedPrice != null,
          });
        }
        const loaded = await Promise.all(
          toLoad.map(async (row) => {
            if (!row.directoryRefId) {
              return {
                id: row.id,
                price: null as number | null,
                brands: [] as string[],
                unit: '',
                description: '',
                attachmentsCount: 0,
              };
            }
            const details = await window.matrica.admin.entities.get(row.directoryRefId).catch(() => null);
            const attrs = (details as { attributes?: Record<string, unknown> } | null)?.attributes ?? {};
            const value = Number(attrs.price);
            const price = Number.isFinite(value) ? Math.max(0, value) : null;
            const brands = parseIdArray(attrs.engine_brand_ids);
            const unit = String(attrs.unit ?? '').trim();
            const description = String(attrs.description ?? '').trim();
            const rawAttachments = attrs.attachments;
            const attachmentsCount = Array.isArray(rawAttachments) ? rawAttachments.length : 0;
            return { id: row.id, price, brands, unit, description, attachmentsCount };
          }),
        );
        for (const row of loaded) {
          if (!toLoad.find((t) => t.id === row.id)?.hasPrice) priceMap[row.id] = row.price;
          brandsMap[row.id] = row.brands;
          unitMap[row.id] = row.unit;
          descMap[row.id] = row.description;
          attachMap[row.id] = row.attachmentsCount;
        }
        if (alive) {
          setServicePrices(priceMap);
          setServiceBrandIds(brandsMap);
          setServiceUnits(unitMap);
          setServiceDescriptions(descMap);
          setServiceAttachmentsCount(attachMap);
        }
      } catch {
        if (alive) {
          setServicePrices({});
          setServiceBrandIds({});
          setServiceUnits({});
          setServiceDescriptions({});
          setServiceAttachmentsCount({});
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [canView, props.directoryKind, rows]);

  if (!canView) {
    return <div style={{ color: 'var(--subtle)' }}>{props.noAccessText ?? 'Недостаточно прав для просмотра.'}</div>;
  }

  const colCount =
    (props.directoryKind === 'service'
      ? Math.max(visibleServiceColumns.length, 1)
      : 3 + (props.directoryKind === 'engine_brand' ? 1 : 0)) + 1;

  const tableHeader = (
    <thead>
      {props.directoryKind === 'service' ? (
        <tr>
          {visibleServiceColumns.map((col) => (
            <th
              key={col.id}
              {...listHeaderKindProps(col.kind, col.label)}
              style={{ textAlign: col.align ?? 'left', cursor: 'pointer' }}
              onClick={() => onSort(col.sortKey)}
            >
              {sortLabel(col.label, col.sortKey)}
            </th>
          ))}
          <th className="list-col-filler" aria-hidden="true" />
        </tr>
      ) : (
        <tr>
          <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('code')}>{sortLabel('Код', 'code')}</th>
          <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>{sortLabel('Наименование', 'name')}</th>
          <th data-col-kind="name" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('sku')}>{sortLabel('SKU', 'sku')}</th>
          {props.directoryKind === 'engine_brand' ? (
            <th data-col-kind="num" title="Прикреплено деталей" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('parts')}>
              {sortLabel('Прикреплено деталей', 'parts')}
            </th>
          ) : null}
          <th data-col-kind="date" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('updatedAt')}>
            {sortLabel('Дата изменения', 'updatedAt')}
          </th>
          <th className="list-col-filler" aria-hidden="true" />
        </tr>
      )}
    </thead>
  );

  function renderRowCells(row: WarehouseNomenclatureListItem) {
    if (props.directoryKind === 'service') {
      return (
        <>
          {visibleServiceColumns.map((col) => (
            <td key={col.id} {...listCellKindProps(col.kind)} style={{ textAlign: col.align ?? 'left', fontSize: col.id === 'brands' || col.id === 'description' ? 12 : undefined }}>
              {col.render(row)}
            </td>
          ))}
          <td className="list-col-filler" aria-hidden="true" />
        </>
      );
    }
    return (
      <>
        <td data-col-kind="name">{row.code || '—'}</td>
        <td data-col-kind="name">{row.name || '—'}</td>
        <td data-col-kind="name">{row.sku || '—'}</td>
        {props.directoryKind === 'engine_brand' ? <td data-col-kind="num">{brandPartCounts[String(row.id)] ?? 0}</td> : null}
        <td data-col-kind="date">{row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—'}</td>
        <td className="list-col-filler" aria-hidden="true" />
      </>
    );
  }

  function rowProps(row: WarehouseNomenclatureListItem): VirtualTableRowProps {
    return {
      style: { cursor: 'pointer' },
      onClick: () => void props.onOpen(String(row.id)),
    };
  }

  function renderTable(items: WarehouseNomenclatureListItem[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'clip' }}>
        <table className="list-table">
          {tableHeader}
          <tbody>
            {items.map((row) => (
              <tr key={String(row.id)} {...rowProps(row)}>
                {renderRowCells(row)}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={colCount}>
                  {props.emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate && props.onCreateDeferred ? (
          <Button onClick={() => props.onCreateDeferred?.()}>{props.createButtonText}</Button>
        ) : props.canCreate ? (
          <Button
            onClick={async () => {
              const article = await promptNomenclatureArticle(promptText, props.createConfig.name);
              if (article === null) return;
              const r = await createNomenclatureLineFromPreset({
                directoryKind: props.directoryKind,
                createConfig: props.createConfig,
                displayName: props.createConfig.name,
                article,
              });
              if (!r.ok) {
                if ('duplicateNomenclatureId' in r) {
                  await refresh();
                  await props.onOpen(r.duplicateNomenclatureId);
                  setStatus(`Позиция уже существовала, открыта существующая карточка (${r.duplicateNomenclatureId.slice(0, 8)}...).`);
                  return;
                }
                setStatus(`Ошибка: ${r.error}`);
                return;
              }
              await refresh();
              await props.onOpen(r.nomenclatureId);
            }}
          >
            {props.createButtonText}
          </Button>
        ) : null}

        {props.secondaryAction}

        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={props.searchPlaceholder} />
        </div>
        {props.directoryKind === 'service' ? (
          <ColumnSettingsButton
            columns={serviceColumnDescriptors}
            order={serviceColumnLayout.order}
            isVisible={serviceColumnLayout.isVisible}
            onToggleVisible={serviceColumnLayout.setVisible}
            onMove={serviceColumnLayout.moveColumn}
            onReset={serviceColumnLayout.resetToDefault}
          />
        ) : null}
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </div>

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
      {status.startsWith('Ошибка') && buildCreateHint(status) ? (
        <div
          style={{
            border: '1px solid rgba(245, 158, 11, 0.45)',
            background: 'rgba(254, 243, 199, 0.45)',
            color: '#92400e',
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 12,
            lineHeight: 1.35,
          }}
        >
          Подсказка: {buildCreateHint(status)}
          {props.onOpenNomenclatureCatalog && shouldShowOpenNomenclatureAction(status) ? (
            <div style={{ marginTop: 8 }}>
              <Button
                variant="ghost"
                onClick={() => props.onOpenNomenclatureCatalog?.()}
                style={{ padding: '4px 10px', minHeight: 0 }}
              >
                Открыть Склад → Номенклатура
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {twoCol ? (
          <TwoColumnList items={sortedRows} enabled renderColumn={(items) => renderTable(items)} />
        ) : (
          <VirtualTable
            scrollElementRef={containerRef}
            count={sortedRows.length}
            header={tableHeader}
            renderCells={(i) => renderRowCells(sortedRows[i]!)}
            getRowKey={(i) => String(sortedRows[i]!.id)}
            getRowProps={(i) => rowProps(sortedRows[i]!)}
            colCount={colCount}
            estimateSize={40}
            emptyState={props.emptyText}
          />
        )}
      </div>
      <div style={{ padding: '4px 0 2px', flex: '0 0 auto', fontSize: 12, color: '#9ca3af' }}>Всего: {sortedRows.length}</div>
    </div>
  );
}
