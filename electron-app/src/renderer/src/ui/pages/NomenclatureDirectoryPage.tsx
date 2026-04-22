import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { tryParseWarehousePartNomenclatureMirror, type NomenclatureItemType, type WarehouseNomenclatureListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { WarehouseListPager, type WarehouseListPageSize } from '../components/WarehouseListPager.js';
import { buildNomenclatureCode } from '../utils/nomenclatureCode.js';

type CreateConfig = {
  codePrefix: string;
  name: string;
  itemType: NomenclatureItemType;
  category: string;
};

type SortKey = 'code' | 'name' | 'sku' | 'parts' | 'price';

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
}) {
  const [rows, setRows] = useState<WarehouseNomenclatureListItem[]>([]);
  const [servicePrices, setServicePrices] = useState<Record<string, number | null>>({});
  const [brandPartCounts, setBrandPartCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [pageSize, setPageSize] = useState<WarehouseListPageSize>(50);
  const [pageIndex, setPageIndex] = useState(0);
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

  async function createSourceEntityForDirectoryKind(kind: string, label: string): Promise<string | null> {
    const normalizedKind = String(kind ?? '').trim().toLowerCase();
    if (!normalizedKind) return null;
    const typeCandidates: Record<string, string[]> = {
      part: ['part'],
      tool: ['tool'],
      good: ['good', 'product'],
      service: ['service'],
      engine_brand: ['engine_brand'],
    };
    const candidates = typeCandidates[normalizedKind] ?? [normalizedKind];
    const typeList = await window.matrica.admin.entityTypes.list();
    if (!typeList?.ok || !Array.isArray(typeList.types)) return null;
    const found = candidates
      .map((code) =>
        (typeList.types as Array<Record<string, unknown>>).find(
          (row) => String(row.code ?? '').trim().toLowerCase() === code,
        ),
      )
      .find(Boolean) as Record<string, unknown> | undefined;
    const typeId = String(found?.id ?? '').trim();
    if (!typeId) return null;
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created?.ok || !created.id) return null;
    const entityId = String(created.id);
    const trimmedLabel = String(label ?? '').trim() || 'Новая позиция';
    for (const attrCode of ['name', 'title', 'label']) {
      const setRes = await window.matrica.admin.entities.setAttr(entityId, attrCode, trimmedLabel);
      if (setRes?.ok) break;
    }
    return entityId;
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
        const partsResult = await window.matrica.parts.list({ limit: 5000, offset: 0 });
        if (!alive || !partsResult?.ok) return;
        const counts: Record<string, number> = {};
        for (const part of partsResult.parts ?? []) {
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
      if (cmp === 0) cmp = String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      return cmp * dir;
    });
  }, [rows, sortDir, sortKey, brandPartCounts, servicePrices]);
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

  useEffect(() => {
    if (!canView) return;
    if (props.directoryKind !== 'service') {
      setServicePrices({});
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const next: Record<string, number | null> = {};
        const toLoad: Array<{ id: string; directoryRefId: string | null }> = [];
        for (const row of rows) {
          const parsedPrice = parsePriceFromSpec(row.specJson);
          if (parsedPrice != null) {
            next[String(row.id)] = parsedPrice;
          } else {
            toLoad.push({
              id: String(row.id),
              directoryRefId: row.directoryRefId ? String(row.directoryRefId) : null,
            });
          }
        }
        if (toLoad.length > 0) {
          const loaded = await Promise.all(
            toLoad.map(async (row) => {
              if (!row.directoryRefId) return { id: row.id, price: null as number | null };
              const details = await window.matrica.admin.entities.get(row.directoryRefId).catch(() => null);
              const attrs = (details as any)?.attributes ?? {};
              const value = Number(attrs.price);
              return { id: row.id, price: Number.isFinite(value) ? Math.max(0, value) : null };
            }),
          );
          for (const row of loaded) next[row.id] = row.price;
        }
        if (alive) setServicePrices(next);
      } catch {
        if (alive) setServicePrices({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [canView, props.directoryKind, rows]);

  if (!canView) {
    return <div style={{ color: 'var(--subtle)' }}>{props.noAccessText ?? 'Недостаточно прав для просмотра.'}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {props.canCreate ? (
          <Button
            onClick={async () => {
              if (props.directoryKind === 'part') {
                const createdPart = await window.matrica.parts.create({
                  attributes: {
                    name: props.createConfig.name,
                  },
                });
                if (!createdPart?.ok || !createdPart.part?.id) {
                  const duplicateMatch = String(createdPart && 'error' in createdPart ? createdPart.error ?? '' : '').match(
                    /duplicate part exists:\s*([0-9a-f-]{36})/i,
                  );
                  if (duplicateMatch?.[1]) {
                    const existingId = String(duplicateMatch[1]);
                    await refresh();
                    await props.onOpen(existingId);
                    setStatus(`Деталь уже существовала, открыта существующая карточка (${existingId.slice(0, 8)}...).`);
                    return;
                  }
                  setStatus(`Ошибка: ${String(createdPart && 'error' in createdPart ? createdPart.error : 'не удалось создать деталь')}`);
                  return;
                }
                await refresh();
                await props.onOpen(String(createdPart.part.id));
                return;
              }
              const sourceId = await createSourceEntityForDirectoryKind(props.directoryKind, props.createConfig.name);
              if (!sourceId) {
                setStatus(`Ошибка: не удалось создать карточку источника для "${props.directoryKind}".`);
                return;
              }
              const lookups = await window.matrica.warehouse.lookupsGet();
              if (!lookups?.ok) {
                setStatus(`Ошибка: ${String(lookups?.error ?? 'не удалось загрузить справочники')}`);
                return;
              }
              const groupId = String(lookups.lookups?.nomenclatureGroups?.[0]?.id ?? '').trim();
              const unitId = String(lookups.lookups?.units?.[0]?.id ?? '').trim();
              if (!groupId || !unitId) {
                setStatus('Ошибка: не найдены группа номенклатуры или единица измерения по умолчанию.');
                return;
              }
              const templatesRes = await window.matrica.warehouse.nomenclatureTemplatesList();
              if (!templatesRes?.ok) {
                setStatus(`Ошибка: ${String(templatesRes?.error ?? 'не удалось загрузить шаблоны номенклатуры')}`);
                return;
              }
              const templates = (templatesRes.rows ?? []).map((row) => ({
                id: String((row as { id?: string }).id ?? ''),
                itemTypeCode: String((row as { itemTypeCode?: string }).itemTypeCode ?? '').trim().toLowerCase(),
                directoryKind: String((row as { directoryKind?: string }).directoryKind ?? '').trim().toLowerCase(),
              }));
              const itemTypeCode = String(props.createConfig.itemType ?? '').trim().toLowerCase();
              const directoryKind = String(props.directoryKind ?? '').trim().toLowerCase();
              const bestTemplate =
                templates.find((t) => t.id && t.itemTypeCode === itemTypeCode && t.directoryKind === directoryKind) ??
                templates.find((t) => t.id && t.itemTypeCode === itemTypeCode && !t.directoryKind) ??
                templates.find((t) => t.id && !t.itemTypeCode && (t.directoryKind === directoryKind || !t.directoryKind)) ??
                null;
              if (!bestTemplate?.id) {
                setStatus(
                  `Ошибка: не найден шаблон номенклатуры для типа "${itemTypeCode}" и источника "${directoryKind}". Требуется настроить шаблон перед созданием.`,
                );
                return;
              }
              const created = await window.matrica.warehouse.nomenclatureUpsert({
                code: buildNomenclatureCode(props.createConfig.codePrefix),
                name: props.createConfig.name,
                itemType: props.createConfig.itemType,
                category: props.createConfig.category,
                directoryKind: props.directoryKind,
                directoryRefId: sourceId,
                groupId,
                unitId,
                specJson: JSON.stringify({ templateId: bestTemplate.id, propertyValues: {} }),
                isActive: true,
              });
              if (!created?.ok) {
                setStatus(`Ошибка: ${String(created.error ?? 'не удалось создать')}`);
                return;
              }
              if (!created.id) {
                setStatus('Ошибка: не удалось создать');
                return;
              }
              await refresh();
              await props.onOpen(String(created.id));
            }}
          >
            {props.createButtonText}
          </Button>
        ) : null}

        {props.secondaryAction}

        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => { setPageIndex(0); setQuery(e.target.value); }} placeholder={props.searchPlaceholder} />
        </div>
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
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('code')}>{sortLabel('Код', 'code')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('name')}>{sortLabel('Наименование', 'name')}</th>
              <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('sku')}>{sortLabel('SKU', 'sku')}</th>
              {props.directoryKind === 'engine_brand' ? (
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('parts')}>
                  {sortLabel('Прикреплено деталей', 'parts')}
                </th>
              ) : null}
              {props.directoryKind === 'service' ? (
                <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => onSort('price')}>
                  {sortLabel('Цена', 'price')}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={
                    3 + (props.directoryKind === 'engine_brand' ? 1 : 0) + (props.directoryKind === 'service' ? 1 : 0)
                  }
                  style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}
                >
                  {props.emptyText}
                </td>
              </tr>
            ) : (
              pagedRows.map((row) => (
                <tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => void props.onOpen(String(row.id))}>
                  <td>{row.code || '—'}</td>
                  <td>{row.name || '—'}</td>
                  <td>{row.sku || '—'}</td>
                  {props.directoryKind === 'engine_brand' ? <td>{brandPartCounts[String(row.id)] ?? 0}</td> : null}
                  {props.directoryKind === 'service' ? <td>{formatPrice(servicePrices[String(row.id)])}</td> : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
