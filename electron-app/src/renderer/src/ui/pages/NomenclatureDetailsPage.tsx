import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA,
  readWarehouseNomenclatureComponentTypeId,
  sanitizeWarehouseBomRelationSchema,
  type EngineInstanceListItem,
  type NomenclatureItemType,
  type PartDimension,
  type PartMetadata,
  type PartSpec,
  type PartSpecBrandLink,
  type WarehouseBomRelationSchema,
  type WarehouseMovementListItem,
  type WarehouseNomenclatureListItem,
  type WarehouseStockListItem,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { formatListDateTime } from '../utils/dateUtils.js';
import { Input } from '../components/Input.js';
import { NomenclatureTemplateCompositionEditor } from '../components/NomenclatureTemplateCompositionEditor.js';
import { PartDetailsPage } from './PartDetailsPage.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';
import { SectionCard } from '../components/SectionCard.js';
import { useRecentSelectOptions } from '../hooks/useRecentSelectOptions.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { mapEntityRowsToSearchOptions } from '../utils/selectOptions.js';
import { buildPartSpecPayload } from '../utils/partSpecPayload.js';
import {
  appendTemplateProperty,
  parseTemplatePropertiesJson,
  serializeTemplatePropertiesJson,
} from '../utils/nomenclatureTemplateProperties.js';
import { lookupToSelectOptions, WAREHOUSE_ITEM_TYPE_OPTIONS, warehouseDocTypeLabel } from '../utils/warehouseUi.js';

function parseEnumValuesFromOptionsJson(optionsJson: string | null | undefined): string[] {
  if (!optionsJson?.trim()) return [];
  try {
    const v = JSON.parse(optionsJson) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v) && 'values' in v && Array.isArray((v as { values: unknown }).values)) {
      return ((v as { values: unknown[] }).values ?? []).map((x) => String(x));
    }
    if (Array.isArray(v)) return v.map((x) => String(x));
  } catch {
    /* ignore */
  }
  return [];
}

export function NomenclatureDetailsPage(props: {
  id: string;
  canEdit: boolean;
  onClose: () => void;
  // Stage E.2: when the nomenclature row is a part class, the card embeds the legacy
  // part-EAV card (description/supplier/status/attachments/usage/custom fields) keyed by
  // the same id (directory_parts.id == nomenclature id). These props feed that embed.
  canViewFiles?: boolean;
  canUploadFiles?: boolean;
  onOpenCustomer?: (customerId: string) => void;
  onOpenContract?: (contractId: string) => void;
  onOpenEngineBrand?: (engineBrandId: string) => void;
  onOpenByCode?: Record<string, ((id: string) => void) | undefined>;
}) {
  const { confirm } = useConfirm();
  // Phase 3 Stage E: the embedded part card registers a provider returning its directory
  // metadata blob; we fold it into the unified nomenclaturePartSpecUpdate on save.
  const embeddedPartMetadataRef = useRef<(() => PartMetadata) | null>(null);
  const registerEmbeddedPartMetadata = useCallback((provider: (() => PartMetadata) | null) => {
    embeddedPartMetadataRef.current = provider;
  }, []);
  const [partMetadata, setPartMetadata] = useState<PartMetadata | null>(null);
  const { lookups, error: refsError, refresh: refreshRefs } = useWarehouseReferenceData();
  const [status, setStatus] = useState('');
  const [row, setRow] = useState<WarehouseNomenclatureListItem | null>(null);
  const [balances, setBalances] = useState<WarehouseStockListItem[]>([]);
  const [movements, setMovements] = useState<WarehouseMovementListItem[]>([]);
  const [instances, setInstances] = useState<EngineInstanceListItem[]>([]);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [itemType, setItemType] = useState('material');
  const [category, setCategory] = useState<'engine' | 'component' | 'assembly'>('component');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [barcode, setBarcode] = useState('');
  const [minStock, setMinStock] = useState('');
  const [maxStock, setMaxStock] = useState('');
  const [defaultBrandId, setDefaultBrandId] = useState<string | null>(null);
  const [isSerialTracked, setIsSerialTracked] = useState(false);
  const [defaultWarehouseId, setDefaultWarehouseId] = useState<string | null>(null);
  const [specJson, setSpecJson] = useState('');
  const [componentTypeId, setComponentTypeId] = useState<string | null>(null);
  const [bomRelationSchema, setBomRelationSchema] = useState<WarehouseBomRelationSchema>(DEFAULT_WAREHOUSE_BOM_RELATION_SCHEMA);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [propertyValues, setPropertyValues] = useState<Record<string, unknown>>({});
  const [typeOptions, setTypeOptions] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [templateRows, setTemplateRows] = useState<
    Array<{ id: string; code: string; name: string; itemTypeCode: string; directoryKind: string; propertiesJson: string }>
  >([]);
  const [propertyRows, setPropertyRows] = useState<Array<{ id: string; code: string; name: string; dataType?: string | null; optionsJson?: string | null }>>([]);
  const [templateCompositionOpen, setTemplateCompositionOpen] = useState(false);
  const [showAdvancedSpec, setShowAdvancedSpec] = useState(false);
  const [addPropertyPickId, setAddPropertyPickId] = useState<string | null>(null);
  const [quickPropCode, setQuickPropCode] = useState('');
  const [quickPropName, setQuickPropName] = useState('');
  const [quickPropDataType, setQuickPropDataType] = useState('text');
  const [instanceSerial, setInstanceSerial] = useState('');
  const [instanceContractId, setInstanceContractId] = useState<string | null>(null);
  const [instanceContractSectionNumber, setInstanceContractSectionNumber] = useState<string | null>(null);
  const [instanceWarehouseId, setInstanceWarehouseId] = useState<string | null>('default');
  const [contractSections, setContractSections] = useState<string[]>([]);
  // Phase 2 Stage E.1: part-spec subpanel (directory_parts via Stage C endpoint). The
  // part-template axis was removed in Phase 3.5 (plans/parts-templates-deprecation-2026-06.md);
  // templateId/propertyValues above are the NOMENCLATURE template (specJson), unrelated.
  const [partSpec, setPartSpec] = useState<PartSpec | null>(null);
  const [specDimensions, setSpecDimensions] = useState<PartDimension[]>([]);
  const [specBrandLinks, setSpecBrandLinks] = useState<PartSpecBrandLink[]>([]);
  const [specEngineBrandOptions, setSpecEngineBrandOptions] = useState<SearchSelectOption[]>([]);
  const { pushRecent, withRecents } = useRecentSelectOptions(`matrica:nomenclature-field-recents:${props.id}`, 8);

  const createLookupEntity = useCallback(async (typeCode: string, label: string): Promise<string | null> => {
    const clean = String(label ?? '').trim();
    if (!clean) return null;
    const types = await window.matrica.admin.entityTypes.list();
    const type = types.find((row) => String(row.code ?? '').trim().toLowerCase() === typeCode);
    const typeId = String(type?.id ?? '').trim();
    if (!typeId) return null;
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created?.ok || !created.id) return null;
    const entityId = String(created.id);
    await window.matrica.admin.entities.setAttr(entityId, 'name', clean).catch(() => null);
    await window.matrica.admin.entities.setAttr(entityId, 'code', clean).catch(() => null);
    return entityId;
  }, []);

  const load = useCallback(async () => {
    try {
      setStatus('Загрузка...');
      const [list, stock, movementRes, instancesRes, specRes] = await Promise.all([
        window.matrica.warehouse.nomenclatureList({ id: props.id }),
        window.matrica.warehouse.stockList({ nomenclatureId: props.id }),
        window.matrica.warehouse.movementsList({ nomenclatureId: props.id, limit: 20 }),
        window.matrica.warehouse.engineInstancesList({ nomenclatureId: props.id, limit: 100, offset: 0 }),
        window.matrica.warehouse.nomenclaturePartSpecGet({ nomenclatureId: props.id }),
      ]);
      if (!list?.ok) {
        setStatus(`Ошибка: ${String(list?.error ?? 'unknown')}`);
        return;
      }
      const found = (list.rows ?? [])[0] ?? null;
      if (!found) {
        setStatus('Позиция не найдена');
        return;
      }
      setRow(found);
      setCode(String(found.code ?? found.sku ?? ''));
      setName(String(found.name ?? ''));
      setItemType(String(found.itemType ?? 'material'));
      setCategory((String(found.category ?? 'component') as 'engine' | 'component' | 'assembly') ?? 'component');
      setGroupId(found.groupId ?? null);
      setUnitId(found.unitId ?? null);
      setBarcode(String(found.barcode ?? ''));
      setMinStock(found.minStock == null ? '' : String(found.minStock));
      setMaxStock(found.maxStock == null ? '' : String(found.maxStock));
      setDefaultBrandId(found.defaultBrandId ?? null);
      setIsSerialTracked(found.isSerialTracked === true);
      setDefaultWarehouseId(found.defaultWarehouseId ?? null);
      setSpecJson(String(found.specJson ?? ''));
      // v1.22.0 block D: prefer the resolved value from list payload (backend uses native
      // component_type_id column with spec_json fallback). Legacy spec_json.componentTypeId
      // is still respected because backend resolver covers it during transitional period.
      setComponentTypeId(
        found.componentTypeId ?? readWarehouseNomenclatureComponentTypeId(found.specJson ?? null),
      );
      try {
        const parsedSpec = found.specJson ? (JSON.parse(String(found.specJson)) as Record<string, unknown>) : {};
        const parsedTemplateId = typeof parsedSpec.templateId === 'string' && parsedSpec.templateId.trim() ? parsedSpec.templateId.trim() : null;
        const parsedPropertyValues =
          parsedSpec.propertyValues && typeof parsedSpec.propertyValues === 'object' && !Array.isArray(parsedSpec.propertyValues)
            ? (parsedSpec.propertyValues as Record<string, unknown>)
            : {};
        setTemplateId(parsedTemplateId);
        setPropertyValues(parsedPropertyValues);
      } catch {
        setTemplateId(null);
        setPropertyValues({});
      }
      setPartMetadata(specRes?.ok ? specRes.metadata ?? null : null);
      if (specRes?.ok && specRes.spec) {
        setPartSpec(specRes.spec);
        setSpecDimensions(specRes.spec.dimensions ?? []);
        setSpecBrandLinks(specRes.spec.brandLinks ?? []);
      } else {
        setPartSpec(null);
        setSpecDimensions([]);
        setSpecBrandLinks([]);
      }
      if (stock?.ok) {
        setBalances(stock.rows ?? []);
      } else {
        setBalances([]);
      }
      setMovements(movementRes?.ok ? movementRes.rows ?? [] : []);
      setInstances(instancesRes?.ok ? ((instancesRes.rows ?? []) as EngineInstanceListItem[]) : []);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await window.matrica.warehouse.assemblyBomSchemaGet();
        if (!alive || !res?.ok || !res.schema) return;
        setBomRelationSchema(sanitizeWarehouseBomRelationSchema(res.schema));
      } catch {
        /* схема остаётся дефолтной */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const bomComponentTypeOptions = useMemo<SearchSelectOption[]>(() => {
    const rootId = String(bomRelationSchema.rootTypeId ?? 'engine').trim().toLowerCase();
    return (bomRelationSchema.nodes ?? [])
      .filter((node) => node.isActive !== false && node.typeId !== rootId)
      .map((node) => ({ id: String(node.typeId), label: String(node.label || node.typeId) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [bomRelationSchema]);

  useEffect(() => {
    if (instanceContractId) {
      window.matrica.warehouse.contractSectionsGet(instanceContractId).then((res) => {
        if (res?.ok) {
          setContractSections(res.sections ?? []);
        } else {
          setContractSections([]);
        }
      }).catch(() => {
        setContractSections([]);
      });
    } else {
      setContractSections([]);
    }
    setInstanceContractSectionNumber(null);
  }, [instanceContractId]);

  const reloadTemplateGovernance = useCallback(async () => {
    const [typesRes, templatesRes, propertiesRes] = await Promise.all([
      window.matrica.warehouse.nomenclatureItemTypesList(),
      window.matrica.warehouse.nomenclatureTemplatesList(),
      window.matrica.warehouse.nomenclaturePropertiesList(),
    ]);
    if (typesRes?.ok) {
      setTypeOptions(
        ((typesRes.rows ?? []) as Array<Record<string, unknown>>)
          .map((row) => ({
            id: String(row.id ?? ''),
            code: String(row.code ?? '').trim(),
            name: String(row.name ?? '').trim(),
          }))
          .filter((row) => row.id && row.code && row.name),
      );
    }
    if (templatesRes?.ok) {
      setTemplateRows(
        ((templatesRes.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id ?? ''),
          code: String(row.code ?? '').trim(),
          name: String(row.name ?? '').trim(),
          itemTypeCode: String(row.itemTypeCode ?? ''),
          directoryKind: String(row.directoryKind ?? ''),
          propertiesJson: String(row.propertiesJson ?? '[]'),
        })),
      );
    }
    if (propertiesRes?.ok) {
      setPropertyRows(
        ((propertiesRes.rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id ?? ''),
          code: String(row.code ?? '').trim(),
          name: String(row.name ?? '').trim(),
          dataType: row.dataType == null ? null : String(row.dataType ?? ''),
          optionsJson: row.optionsJson == null ? null : String(row.optionsJson ?? ''),
        })),
      );
    }
  }, []);

  useEffect(() => {
    void reloadTemplateGovernance();
  }, [reloadTemplateGovernance]);

  // Drop a dangling templateId (points to a removed template): the backend rejects an unknown
  // template on save («Указанный шаблон номенклатуры не найден»), which made legacy items with a
  // stale specJson.templateId unsavable. Once the template list is loaded and the current id
  // isn't in it, clear the stale reference so the field shows empty and the card saves cleanly.
  useEffect(() => {
    if (templateId && templateRows.length > 0 && !templateRows.some((t) => t.id === templateId)) {
      setTemplateId(null);
    }
  }, [templateId, templateRows]);

  const totalQty = useMemo(() => balances.reduce((sum, row) => sum + Number(row.qty ?? 0), 0), [balances]);
  const itemTypeSelectOptions = useMemo(() => {
    if (typeOptions.length > 0) return typeOptions.map((row) => ({ id: row.code, label: row.name }));
    return WAREHOUSE_ITEM_TYPE_OPTIONS.filter((item) => item.id).map((item) => ({ id: String(item.id), label: item.label }));
  }, [typeOptions]);
  const propertyById = useMemo(() => new Map(propertyRows.map((row) => [row.id, row] as const)), [propertyRows]);
  const selectedTemplateProperties = useMemo(() => {
    const template = templateRows.find((row) => row.id === templateId);
    if (!template?.propertiesJson) return [];
    return parseTemplatePropertiesJson(template.propertiesJson);
  }, [templateRows, templateId]);

  const templateForCompositionEditor = useMemo(() => {
    if (!templateId) return null;
    const t = templateRows.find((row) => row.id === templateId);
    if (!t) return null;
    return {
      id: t.id,
      code: t.code,
      name: t.name,
      itemTypeCode: t.itemTypeCode,
      directoryKind: t.directoryKind,
      propertiesJson: t.propertiesJson,
    };
  }, [templateId, templateRows]);

  const canEditNomenclatureFields = props.canEdit;

  // Phase 2 Stage E.1: show the part-spec subpanel when this nomenclature is a part. A
  // non-null spec means a directory_parts row exists (covers backfilled + created parts —
  // createPart seeds a stub row); the itemType check is a fallback when the stub is missing.
  const isPartClass = partSpec !== null || itemType === 'part';

  useEffect(() => {
    if (!isPartClass) return;
    let alive = true;
    void (async () => {
      try {
        const types = await window.matrica.admin.entityTypes.list();
        const type = (types as Array<{ id?: unknown; code?: unknown }>).find((t) => String(t.code ?? '') === 'engine_brand');
        if (!alive || !type?.id) return;
        const rows = await window.matrica.admin.entities.listByEntityType(String(type.id));
        if (!alive) return;
        setSpecEngineBrandOptions(mapEntityRowsToSearchOptions(rows, { fallbackToShortId: true }));
      } catch {
        /* options stay empty */
      }
    })();
    return () => {
      alive = false;
    };
  }, [isPartClass]);

  const propertyOptionsForAdd = useMemo(() => {
    const inTpl = new Set(selectedTemplateProperties.map((p) => p.propertyId));
    return propertyRows
      .filter((p) => p.id && !inTpl.has(p.id))
      .map((p) => ({
        id: p.id,
        label: `${p.name} (${p.code})`,
        hintText: p.dataType ?? '',
      }));
  }, [propertyRows, selectedTemplateProperties]);

  async function appendPropertyToCurrentTemplate(propertyId: string) {
    if (!canEditNomenclatureFields) return;
    const pid = String(propertyId ?? '').trim();
    if (!pid) return;
    if (!templateId) {
      setStatus('Сначала выберите шаблон номенклатуры.');
      return;
    }
    const tpl = templateRows.find((r) => r.id === templateId);
    if (!tpl) {
      setStatus('Шаблон не найден в списке. Обновите страницу.');
      return;
    }
    const rows = parseTemplatePropertiesJson(tpl.propertiesJson);
    if (rows.some((r) => r.propertyId === pid)) {
      setStatus('Это свойство уже есть в шаблоне.');
      return;
    }
    const next = appendTemplateProperty(rows, pid);
    const up = await window.matrica.warehouse.nomenclatureTemplateUpsert({
      id: tpl.id,
      code: tpl.code.trim(),
      name: tpl.name.trim(),
      itemTypeCode: tpl.itemTypeCode.trim() || null,
      directoryKind: tpl.directoryKind.trim() || null,
      propertiesJson: serializeTemplatePropertiesJson(next),
    });
    if (!up?.ok) {
      setStatus(`Ошибка: ${String(up?.error ?? 'не удалось обновить шаблон')}`);
      return;
    }
    await reloadTemplateGovernance();
    setPropertyValues((prev) => ({ ...prev, [pid]: prev[pid] ?? '' }));
    setAddPropertyPickId(null);
    setStatus('Свойство добавлено в шаблон. Сохраните карточку при необходимости.');
    setTimeout(() => setStatus(''), 2500);
  }

  async function createQuickPropertyAndAppend() {
    const code = quickPropCode.trim().toLowerCase();
    const name = quickPropName.trim();
    if (!code || !name) {
      setStatus('Укажите код и наименование нового свойства.');
      return;
    }
    const created = await window.matrica.warehouse.nomenclaturePropertyUpsert({
      code,
      name,
      dataType: quickPropDataType,
    });
    if (!created?.ok || !created.id) {
      setStatus(`Ошибка: ${String(!created?.ok && created ? created.error : 'не удалось создать свойство')}`);
      return;
    }
    setQuickPropCode('');
    setQuickPropName('');
    setQuickPropDataType('text');
    await reloadTemplateGovernance();
    await appendPropertyToCurrentTemplate(String(created.id));
  }
  const templateOptions = useMemo(
    () =>
      withRecents(
        'templateId',
        templateRows.map((t) => ({ id: t.id, label: t.name, hintText: t.code })),
      ),
    [templateRows, withRecents],
  );
  const groupOptions = useMemo(() => withRecents('groupId', lookupToSelectOptions(lookups.nomenclatureGroups)), [lookups.nomenclatureGroups, withRecents]);
  const unitOptions = useMemo(() => withRecents('unitId', lookupToSelectOptions(lookups.units)), [lookups.units, withRecents]);
  const brandOptions = useMemo(() => withRecents('defaultBrandId', lookupToSelectOptions(lookups.engineBrands)), [lookups.engineBrands, withRecents]);
  const warehouseOptions = useMemo(() => withRecents('defaultWarehouseId', lookupToSelectOptions(lookups.warehouses)), [lookups.warehouses, withRecents]);
  const instanceWarehouseOptions = useMemo(
    () => withRecents('instanceWarehouseId', lookupToSelectOptions(lookups.warehouses)),
    [lookups.warehouses, withRecents],
  );
  const contractOptions = useMemo(
    () => withRecents('instanceContractId', lookupToSelectOptions(lookups.contracts)),
    [lookups.contracts, withRecents],
  );

  async function saveAll(): Promise<boolean> {
    const result = await window.matrica.warehouse.nomenclatureUpsert({
      id: props.id,
      code: code.trim(),
      sku: null,
      name: name.trim(),
      itemType: itemType as NomenclatureItemType,
      category,
      groupId,
      unitId,
      barcode: barcode.trim() || null,
      minStock: minStock.trim() ? Number(minStock) : null,
      maxStock: maxStock.trim() ? Number(maxStock) : null,
      defaultBrandId,
      isSerialTracked,
      defaultWarehouseId,
      specJson: JSON.stringify({
        ...(specJson.trim() ? { raw: specJson.trim() } : {}),
        ...(templateId ? { templateId } : {}),
        propertyValues,
      }),
      // v1.22.0 block D: componentTypeId is now a dedicated column on
      // erp_nomenclature (migration 0053). UI no longer stores it inside specJson.
      // Pass `null` explicitly so backend can clear the column if the operator unset it.
      componentTypeId: componentTypeId ?? null,
      isActive: true,
    });
    if (!result?.ok) {
      setStatus(`Ошибка: ${String(result?.error ?? 'не удалось сохранить')}`);
      return false;
    }
    if (isPartClass) {
      // Persist part-spec to directory_parts via Stage C endpoint. Nomenclature is
      // saved first so the upsert's name fallback always finds a row. code is
      // round-tripped untouched — the card's «Код» field owns erp_nomenclature.code.
      // Phase 3 Stage E: residual part fields (description/supplier/status/dates/
      // attachments/contract...) now persist in directory_parts.metadataJson in the
      // same unified write — no more per-field parts.updateAttribute path.
      const embeddedMetadata = embeddedPartMetadataRef.current ? embeddedPartMetadataRef.current() : undefined;
      const specRes = await window.matrica.warehouse.nomenclaturePartSpecUpdate({
        nomenclatureId: props.id,
        spec: buildPartSpecPayload({
          code: partSpec?.code ?? null,
          dimensions: specDimensions,
          brandLinks: specBrandLinks,
        }),
        ...(embeddedMetadata ? { metadata: embeddedMetadata } : {}),
      });
      if (!specRes?.ok) {
        setStatus(`Ошибка спецификации: ${String(specRes?.error ?? 'не удалось сохранить спецификацию')}`);
        return false;
      }
    }
    setStatus('Сохранено');
    setTimeout(() => setStatus(''), 1200);
    await load();
    return true;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {canEditNomenclatureFields ? (
          <Button onClick={() => void saveAll()}>Сохранить</Button>
        ) : null}
        {canEditNomenclatureFields ? (
          <Button
            onClick={() =>
              void (async () => {
                const ok = await saveAll();
                if (ok) props.onClose();
              })()
            }
          >
            Сохранить и выйти
          </Button>
        ) : null}
        {canEditNomenclatureFields ? (
          <Button
            variant="ghost"
            style={{ color: 'var(--danger)' }}
            onClick={async () => {
              const ok = await confirm({
                detail: `Будет удалена номенклатурная позиция «${name.trim() || code.trim() || props.id}» (код: ${code.trim() || '—'}). Связанные складские документы могут потребовать проверки.`,
              });
              if (!ok) return;
              const result = await window.matrica.warehouse.nomenclatureDelete(props.id);
              if (!result?.ok) {
                setStatus(`Ошибка: ${String(result?.error ?? 'не удалось удалить')}`);
                return;
              }
              props.onClose();
            }}
          >
            Удалить
          </Button>
        ) : null}
        <Button variant="ghost" onClick={props.onClose}>
          Назад
        </Button>
      </div>

      {refsError ? <div style={{ color: 'var(--danger)' }}>Справочники склада: {refsError}</div> : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'center' }}>
          <div>Код</div>
          <Input value={code} disabled={!canEditNomenclatureFields} onChange={(e) => setCode(e.target.value)} placeholder="Внутренний код / артикул" />
          <div>Наименование</div>
          <Input value={name} disabled={!canEditNomenclatureFields} onChange={(e) => setName(e.target.value)} />
          <div>Тип</div>
          <select value={itemType} disabled={!canEditNomenclatureFields} onChange={(e) => setItemType(e.target.value)} style={{ padding: '8px 10px' }}>
            {itemTypeSelectOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div title="Тип компонента в спецификации сборки двигателя (BOM). Определяет, в какой группе появится номенклатура при выборе в строке BOM.">Тип компонента BOM</div>
          <SearchSelect
            value={componentTypeId}
            disabled={!canEditNomenclatureFields}
            options={bomComponentTypeOptions}
            placeholder="(не используется в BOM)"
            showAllWhenEmpty
            emptyQueryLimit={20}
            onChange={(next) => setComponentTypeId(next)}
          />
          <div>Шаблон</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <SearchSelect
                value={templateId}
                disabled={!canEditNomenclatureFields}
                options={templateOptions}
                placeholder="Шаблон номенклатуры"
                showAllWhenEmpty
                emptyQueryLimit={15}
                onChange={(next) => {
                  setTemplateId(next);
                  pushRecent('templateId', next);
                }}
                {...(canEditNomenclatureFields
                  ? {
                      createLabel: 'Новый шаблон',
                      onCreate: async (label: string) => {
                        const up = await window.matrica.warehouse.nomenclatureTemplateUpsert({
                          code: `TPL-${Date.now().toString(36).toUpperCase()}`,
                          name: String(label ?? '').trim() || 'Новый шаблон',
                          itemTypeCode: String(itemType ?? '').trim() || null,
                          directoryKind: row?.directoryKind ? String(row.directoryKind) : null,
                          propertiesJson: '[]',
                        });
                        if (!up?.ok) {
                          setStatus(`Ошибка: ${String(up?.error ?? 'не удалось создать шаблон')}`);
                          return null;
                        }
                        await reloadTemplateGovernance();
                        pushRecent('templateId', up.id);
                        return String(up.id);
                      },
                    }
                  : {})}
              />
            </div>
            {canEditNomenclatureFields && templateId ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setTemplateCompositionOpen(true)}>
                Состав шаблона
              </Button>
            ) : null}
          </div>
          <div>Группа</div>
          <SearchSelect
            value={groupId}
            disabled={!canEditNomenclatureFields}
            options={groupOptions}
            placeholder="Группа номенклатуры"
            showAllWhenEmpty
            emptyQueryLimit={15}
            onChange={(next) => {
              setGroupId(next);
              pushRecent('groupId', next);
            }}
            {...(canEditNomenclatureFields
              ? {
                  createLabel: 'Новая группа',
                  onCreate: async (label: string) => {
                    const id = await createLookupEntity('nomenclature_group', label);
                    if (!id) {
                      setStatus('Ошибка: не удалось создать группу номенклатуры');
                      return null;
                    }
                    await refreshRefs();
                    pushRecent('groupId', id);
                    return id;
                  },
                }
              : {})}
          />
          <div>Единица измерения</div>
          <SearchSelect
            value={unitId}
            disabled={!canEditNomenclatureFields}
            options={unitOptions}
            placeholder="Единица измерения"
            showAllWhenEmpty
            emptyQueryLimit={15}
            onChange={(next) => {
              setUnitId(next);
              pushRecent('unitId', next);
            }}
            {...(canEditNomenclatureFields
              ? {
                  createLabel: 'Новая единица',
                  onCreate: async (label: string) => {
                    const id = await createLookupEntity('unit', label);
                    if (!id) {
                      setStatus('Ошибка: не удалось создать единицу измерения');
                      return null;
                    }
                    await refreshRefs();
                    pushRecent('unitId', id);
                    return id;
                  },
                }
              : {})}
          />
          {itemType !== 'service' && (
            <>
              <div>Штрихкод</div>
              <Input value={barcode} disabled={!canEditNomenclatureFields} onChange={(e) => setBarcode(e.target.value)} />
              <div>Мин. остаток</div>
              <Input value={minStock} type="number" disabled={!canEditNomenclatureFields} onChange={(e) => setMinStock(e.target.value)} />
              <div>Макс. остаток</div>
              <Input value={maxStock} type="number" disabled={!canEditNomenclatureFields} onChange={(e) => setMaxStock(e.target.value)} />
            </>
          )}
          <div>Марка по умолчанию</div>
          <SearchSelect
            value={defaultBrandId}
            disabled={!canEditNomenclatureFields}
            options={brandOptions}
            placeholder="Марка двигателя"
            showAllWhenEmpty
            emptyQueryLimit={15}
            onChange={(next) => {
              setDefaultBrandId(next);
              pushRecent('defaultBrandId', next);
            }}
            {...(canEditNomenclatureFields
              ? {
                  createLabel: 'Новая марка',
                  onCreate: async (label: string) => {
                    const id = await createLookupEntity('engine_brand', label);
                    if (!id) {
                      setStatus('Ошибка: не удалось создать марку двигателя');
                      return null;
                    }
                    await refreshRefs();
                    pushRecent('defaultBrandId', id);
                    return id;
                  },
                }
              : {})}
          />
          {itemType !== 'service' && (
            <>
              <div>Серийный учет</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={isSerialTracked} disabled={!canEditNomenclatureFields} onChange={(e) => setIsSerialTracked(e.target.checked)} />
                Вести по серийным номерам
              </label>
            </>
          )}
          {itemType !== 'service' && (
            <>
              <div>Склад по умолчанию</div>
              <SearchSelect
                value={defaultWarehouseId}
                disabled={!canEditNomenclatureFields}
                options={warehouseOptions}
                placeholder="Склад по умолчанию"
                showAllWhenEmpty
                emptyQueryLimit={15}
                onChange={(next) => {
                  setDefaultWarehouseId(next);
                  pushRecent('defaultWarehouseId', next);
                }}
                {...(canEditNomenclatureFields
                  ? {
                      createLabel: 'Новый склад',
                      onCreate: async (label: string) => {
                        const id = await createLookupEntity('warehouse_ref', label);
                        if (!id) {
                          setStatus('Ошибка: не удалось создать склад');
                          return null;
                        }
                        await refreshRefs();
                        pushRecent('defaultWarehouseId', id);
                        return id;
                      },
                    }
                  : {})}
              />
            </>
          )}
          <div style={{ gridColumn: '1 / -1' }}>
            <button type="button" onClick={() => setShowAdvancedSpec((v) => !v)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#2563eb', fontSize: 13 }}>
              {showAdvancedSpec ? '▼' : '▸'} Спецификация (JSON, для отладки)
            </button>
            {showAdvancedSpec ? (
              <textarea
                value={specJson}
                disabled={!canEditNomenclatureFields}
                onChange={(e) => setSpecJson(e.target.value)}
                rows={5}
                style={{ width: '100%', marginTop: 8 }}
              />
            ) : null}
          </div>
          {canEditNomenclatureFields && templateId ? (
            <>
              <div style={{ gridColumn: '1 / -1', fontWeight: 600, marginTop: 4 }}>Добавить свойство в шаблон этой номенклатуры</div>
              <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>
                Свойство будет закреплено в выбранном шаблоне и появится в форме ниже (сохраните карточку, чтобы записать значения).
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end', marginBottom: 8 }}>
                <SearchSelect
                  value={addPropertyPickId}
                  options={propertyOptionsForAdd}
                  placeholder="Выберите свойство из справочника…"
                  showAllWhenEmpty
                  emptyQueryLimit={20}
                  onChange={(next) => setAddPropertyPickId(next)}
                />
                <Button type="button" variant="outline" size="sm" disabled={!addPropertyPickId} onClick={() => void appendPropertyToCurrentTemplate(addPropertyPickId!)}>
                  Добавить в шаблон
                </Button>
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr 100px auto', gap: 8, alignItems: 'end', marginBottom: 8 }}>
                <Input value={quickPropCode} onChange={(e) => setQuickPropCode(e.target.value)} placeholder="Код нового свойства" />
                <Input value={quickPropName} onChange={(e) => setQuickPropName(e.target.value)} placeholder="Наименование" />
                <select value={quickPropDataType} onChange={(e) => setQuickPropDataType(e.target.value)} style={{ padding: '8px 10px' }}>
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="date">date</option>
                  <option value="enum">enum</option>
                  <option value="json">json</option>
                </select>
                <Button type="button" variant="outline" size="sm" onClick={() => void createQuickPropertyAndAppend()}>
                  Создать и в шаблон
                </Button>
              </div>
            </>
          ) : null}
          {selectedTemplateProperties.length > 0 ? (
            <div style={{ gridColumn: '1 / -1', fontWeight: 600, marginTop: 6 }}>Значения по шаблону</div>
          ) : null}
          {selectedTemplateProperties.map((templateProp) => {
            const property = propertyById.get(templateProp.propertyId);
            const value = propertyValues[templateProp.propertyId];
            const dataType = String(property?.dataType ?? 'text').toLowerCase();
            const enumOpts = dataType === 'enum' ? parseEnumValuesFromOptionsJson(property?.optionsJson ?? null) : [];
            return (
              <React.Fragment key={templateProp.propertyId}>
                <div>
                  {property?.name || templateProp.propertyId}
                  {templateProp.required ? ' *' : ''}
                </div>
                {dataType === 'boolean' ? (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      disabled={!canEditNomenclatureFields}
                      onChange={(e) => setPropertyValues((prev) => ({ ...prev, [templateProp.propertyId]: e.target.checked }))}
                    />
                    Да/Нет
                  </label>
                ) : dataType === 'enum' && enumOpts.length > 0 ? (
                  <select
                    value={value == null ? '' : String(value)}
                    disabled={!canEditNomenclatureFields}
                    onChange={(e) => setPropertyValues((prev) => ({ ...prev, [templateProp.propertyId]: e.target.value }))}
                    style={{ padding: '8px 10px', width: '100%' }}
                  >
                    <option value="">—</option>
                    {enumOpts.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={value == null ? '' : String(value)}
                    disabled={!canEditNomenclatureFields}
                    onChange={(e) => setPropertyValues((prev) => ({ ...prev, [templateProp.propertyId]: e.target.value }))}
                    placeholder={property?.code || templateProp.propertyId}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {isPartClass && (
        <div style={{ border: '1px solid var(--border)', padding: 12, display: 'grid', gap: 12 }}>
          <div style={{ fontWeight: 700 }}>Спецификация детали</div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontWeight: 600 }}>Размеры детали</div>
              {canEditNomenclatureFields ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSpecDimensions((prev) => [...prev, { id: crypto.randomUUID(), name: '', value: '' }])}
                >
                  Добавить размер
                </Button>
              ) : null}
            </div>
            {specDimensions.length === 0 ? (
              <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Размеры не заданы</div>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {specDimensions.map((dim, index) => (
                  <div key={dim.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8 }}>
                    <Input
                      value={dim.name}
                      disabled={!canEditNomenclatureFields}
                      placeholder="Наименование"
                      onChange={(e) => setSpecDimensions((prev) => prev.map((d, i) => (i === index ? { ...d, name: e.target.value } : d)))}
                    />
                    <Input
                      value={dim.value}
                      disabled={!canEditNomenclatureFields}
                      placeholder="Значение"
                      onChange={(e) => setSpecDimensions((prev) => prev.map((d, i) => (i === index ? { ...d, value: e.target.value } : d)))}
                    />
                    {canEditNomenclatureFields ? (
                      <Button
                        type="button"
                        variant="ghost"
                        style={{ color: 'var(--danger)' }}
                        onClick={async () => {
                          const ok = await confirm({ detail: `Удалить размер${dim.name.trim() ? ` «${dim.name.trim()}»` : ''}?` });
                          if (!ok) return;
                          setSpecDimensions((prev) => prev.filter((_, i) => i !== index));
                        }}
                      >
                        Удалить
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontWeight: 600 }}>Применяемость (марки двигателей)</div>
              {canEditNomenclatureFields ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSpecBrandLinks((prev) => [...prev, { id: crypto.randomUUID(), engineBrandId: null, assemblyUnitNumber: null, quantity: 1 }])
                  }
                >
                  Добавить марку
                </Button>
              ) : null}
            </div>
            {specBrandLinks.length === 0 ? (
              <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Применяемость не задана</div>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) 1fr 120px auto', gap: 8, fontSize: 12, color: 'var(--subtle)' }}>
                  <div>Марка двигателя</div>
                  <div>Сборочная единица</div>
                  <div>Количество</div>
                  <div />
                </div>
                {specBrandLinks.map((link, index) => (
                  <div key={link.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) 1fr 120px auto', gap: 8, alignItems: 'center' }}>
                    <SearchSelect
                      value={link.engineBrandId}
                      disabled={!canEditNomenclatureFields}
                      options={specEngineBrandOptions}
                      placeholder="Марка двигателя"
                      showAllWhenEmpty
                      emptyQueryLimit={15}
                      onChange={(next) => setSpecBrandLinks((prev) => prev.map((b, i) => (i === index ? { ...b, engineBrandId: next } : b)))}
                    />
                    <Input
                      value={link.assemblyUnitNumber ?? ''}
                      disabled={!canEditNomenclatureFields}
                      placeholder="Номер сб. единицы"
                      onChange={(e) => setSpecBrandLinks((prev) => prev.map((b, i) => (i === index ? { ...b, assemblyUnitNumber: e.target.value } : b)))}
                    />
                    <Input
                      value={Number.isFinite(link.quantity) ? String(link.quantity) : ''}
                      type="number"
                      disabled={!canEditNomenclatureFields}
                      onChange={(e) => setSpecBrandLinks((prev) => prev.map((b, i) => (i === index ? { ...b, quantity: Number(e.target.value) } : b)))}
                    />
                    {canEditNomenclatureFields ? (
                      <Button
                        type="button"
                        variant="ghost"
                        style={{ color: 'var(--danger)' }}
                        onClick={async () => {
                          const label = link.engineBrandId
                            ? specEngineBrandOptions.find((o) => o.id === link.engineBrandId)?.label ?? link.engineBrandId
                            : '';
                          const ok = await confirm({ detail: `Удалить применяемость${label ? ` к марке «${label}»` : ''}?` });
                          if (!ok) return;
                          setSpecBrandLinks((prev) => prev.filter((_, i) => i !== index));
                        }}
                      >
                        Удалить
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {isPartClass && (
        <div style={{ border: '1px solid var(--border)', padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Поля детали</div>
          <PartDetailsPage
            embedded
            partId={props.id}
            canEdit={props.canEdit}
            canDelete={false}
            canViewFiles={props.canViewFiles ?? false}
            canUploadFiles={props.canUploadFiles ?? false}
            {...(props.onOpenCustomer ? { onOpenCustomer: props.onOpenCustomer } : {})}
            {...(props.onOpenContract ? { onOpenContract: props.onOpenContract } : {})}
            {...(props.onOpenEngineBrand ? { onOpenEngineBrand: props.onOpenEngineBrand } : {})}
            {...(props.onOpenByCode ? { onOpenByCode: props.onOpenByCode } : {})}
            onClose={() => {}}
            {...(partMetadata ? { partMetadata } : {})}
            onRegisterMetadataProvider={registerEmbeddedPartMetadata}
          />
        </div>
      )}

      {itemType !== 'service' && (
        <SectionCard title={`Серийные экземпляры (${instances.length})`} collapsible defaultCollapsed style={{ padding: 12 }}>
        {canEditNomenclatureFields ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr minmax(220px, 1fr) minmax(220px, 1fr) minmax(220px, 1fr) auto', gap: 8, marginBottom: 10 }}>
            <Input value={instanceSerial} onChange={(e) => setInstanceSerial(e.target.value)} placeholder="Серийный номер" />
            <SearchSelect
              value={instanceContractId}
              options={contractOptions}
              placeholder="Контракт (опционально)"
              showAllWhenEmpty
              emptyQueryLimit={15}
              onChange={(next) => {
                setInstanceContractId(next);
                pushRecent('instanceContractId', next);
              }}
            />
            <SearchSelect
              value={instanceContractSectionNumber}
              options={contractSections.map((s) => ({ id: s, label: s }))}
              placeholder="ДС контракта (опционально)"
              showAllWhenEmpty
              disabled={!instanceContractId}
              onChange={setInstanceContractSectionNumber}
            />
            <SearchSelect
              value={instanceWarehouseId}
              options={instanceWarehouseOptions}
              placeholder="Склад"
              showAllWhenEmpty
              emptyQueryLimit={15}
              onChange={(next) => {
                setInstanceWarehouseId(next);
                pushRecent('instanceWarehouseId', next);
              }}
              {...(canEditNomenclatureFields
                ? {
                    createLabel: 'Новый склад',
                    onCreate: async (label: string) => {
                      const id = await createLookupEntity('warehouse_ref', label);
                      if (!id) {
                        setStatus('Ошибка: не удалось создать склад');
                        return null;
                      }
                      await refreshRefs();
                      pushRecent('instanceWarehouseId', id);
                      return id;
                    },
                  }
                : {})}
            />
            <Button
              type="button"
              onClick={async () => {
                if (!instanceSerial.trim()) {
                  setStatus('Укажите серийный номер экземпляра.');
                  return;
                }
                const up = await window.matrica.warehouse.engineInstanceUpsert({
                  nomenclatureId: props.id,
                  serialNumber: instanceSerial.trim(),
                  contractId: instanceContractId,
                  contractSectionNumber: instanceContractSectionNumber,
                  warehouseId: instanceWarehouseId || 'default',
                  currentStatus: 'in_stock',
                });
                if (!up?.ok) {
                  setStatus(`Ошибка: ${String(up?.error ?? 'не удалось создать экземпляр')}`);
                  return;
                }
                setInstanceSerial('');
                await load();
              }}
            >
              Добавить экземпляр
            </Button>
          </div>
        ) : null}
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }} data-col-kind="name">Серийник</th>
              <th style={{ textAlign: 'left' }} data-col-kind="text">Статус</th>
              <th style={{ textAlign: 'left' }} data-col-kind="name">Склад</th>
              <th style={{ textAlign: 'left' }} data-col-kind="name">Контракт</th>
              <th style={{ textAlign: 'left' }} data-col-kind="date" title="Создан">Создан</th>
            </tr>
          </thead>
          <tbody>
            {instances.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 10 }}>
                  Экземпляры не созданы
                </td>
              </tr>
            ) : (
              instances.map((instance) => (
                <tr key={instance.id}>
                  <td data-col-kind="name">{instance.serialNumber}</td>
                  <td data-col-kind="text">{instance.currentStatus}</td>
                  <td data-col-kind="name">
                    {instance.warehouseName ||
                      (String(instance.warehouseId ?? '') === 'default' ? 'Склад по умолчанию' : instance.warehouseId || '—')}
                  </td>
                  <td data-col-kind="name">{instance.contractName || instance.contractCode || instance.contractId || '—'}</td>
                  <td data-col-kind="date">{instance.createdAt ? formatListDateTime(Number(instance.createdAt)) : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </SectionCard>
      )}

      {itemType !== 'service' && (
        <SectionCard title={`Остатки по складам (всего: ${totalQty})`} collapsible defaultCollapsed style={{ padding: 12 }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }} data-col-kind="name">Склад</th>
              <th style={{ textAlign: 'left' }} data-col-kind="num" title="Доступно">Доступно</th>
              <th style={{ textAlign: 'left' }} data-col-kind="num" title="Остаток">Остаток</th>
              <th style={{ textAlign: 'left' }} data-col-kind="num" title="Резерв">Резерв</th>
            </tr>
          </thead>
          <tbody>
            {balances.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 10 }}>
                  Нет остатков
                </td>
              </tr>
            ) : (
              balances.map((balance) => (
                <tr key={balance.id}>
                  <td data-col-kind="name">
                    {balance.warehouseName ||
                      (String(balance.warehouseId ?? '') === 'default' ? 'Склад по умолчанию' : balance.warehouseId || '—')}
                  </td>
                  <td data-col-kind="num">{Number(balance.availableQty ?? 0)}</td>
                  <td data-col-kind="num">{Number(balance.qty ?? 0)}</td>
                  <td data-col-kind="num">{Number(balance.reservedQty ?? 0)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </SectionCard>
      )}

      {itemType !== 'service' && (
        <SectionCard title={`Последние движения (${movements.length})`} collapsible defaultCollapsed style={{ padding: 12 }}>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }} data-col-kind="date" title="Дата">Дата</th>
              <th style={{ textAlign: 'left' }} data-col-kind="name">Склад</th>
              <th style={{ textAlign: 'left' }} data-col-kind="name">Документ</th>
              <th style={{ textAlign: 'left' }} data-col-kind="text">Тип</th>
              <th style={{ textAlign: 'left' }} data-col-kind="text">Операция</th>
              <th style={{ textAlign: 'left' }} data-col-kind="num" title="Кол-во">Кол-во</th>
              <th style={{ textAlign: 'left' }} data-col-kind="text">Основание</th>
            </tr>
          </thead>
          <tbody>
            {movements.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ color: 'var(--subtle)', textAlign: 'center', padding: 10 }}>
                  Нет движений
                </td>
              </tr>
            ) : (
              movements.map((movement) => (
                <tr key={movement.id}>
                  <td data-col-kind="date">{movement.performedAt ? formatListDateTime(Number(movement.performedAt)) : '—'}</td>
                  <td data-col-kind="name">{movement.warehouseName || movement.warehouseId || '—'}</td>
                  <td data-col-kind="name">{movement.documentDocNo || '—'}</td>
                  <td data-col-kind="text">{warehouseDocTypeLabel(movement.documentDocType)}</td>
                  <td data-col-kind="text">{movement.movementType}</td>
                  <td data-col-kind="num">{Number(movement.qty ?? 0)}</td>
                  <td data-col-kind="text">{movement.reasonLabel || movement.reason || movement.counterpartyName || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </SectionCard>
      )}

      {row ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--subtle)', fontSize: 12 }}>
          <span>ID: {row.id}</span>
          <Button variant="ghost" onClick={() => void refreshRefs()}>
            Обновить справочники
          </Button>
        </div>
      ) : null}

      <NomenclatureTemplateCompositionEditor
        open={templateCompositionOpen && templateForCompositionEditor != null}
        template={templateForCompositionEditor}
        propertyOptions={propertyRows.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          dataType: String(p.dataType ?? 'text'),
        }))}
        onClose={() => setTemplateCompositionOpen(false)}
        onSaved={() => {
          void reloadTemplateGovernance();
          void load();
        }}
      />
    </div>
  );
}
