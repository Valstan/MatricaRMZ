import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { LedgerTableName } from '@matricarmz/ledger';
import { PART_TEMPLATE_ID_ATTR_CODE, WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART } from '@matricarmz/shared';

import { db } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  directoryEngineBrands,
  directoryGoods,
  directoryParts,
  directoryServices,
  directoryTools,
  entities,
  entityTypes,
  erpCounterparties,
  erpContracts,
  erpDocumentHeaders,
  erpDocumentLines,
  erpEngineInstances,
  erpEmployeeCards,
  erpJournalDocuments,
  erpNomenclature,
  erpNomenclatureEngineBrand,
  erpPlannedIncoming,
  erpRegStockBalance,
  erpRegStockMovements,
} from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';

const INCOMING_DOC_TYPES = ['inventory_opening', 'purchase_receipt', 'production_release', 'repair_recovery', 'engine_dismantling'] as const;
const STOCK_DOC_TYPES = [...INCOMING_DOC_TYPES, 'stock_receipt', 'stock_issue', 'stock_transfer', 'stock_writeoff', 'stock_inventory'] as const;
type StockDocType = (typeof STOCK_DOC_TYPES)[number];
type IncomingDocType = (typeof INCOMING_DOC_TYPES)[number];

type ResultOk<T> = { ok: true } & T;
type ResultErr = { ok: false; error: string };
type Result<T> = ResultOk<T> | ResultErr;

type Actor = { id: string; username: string; role?: string };

type DocLineInput = {
  qty: number;
  price?: number | null;
  cost?: number | null;
  partCardId?: string | null;
  nomenclatureId?: string | null;
  unit?: string | null;
  batch?: string | null;
  note?: string | null;
  warehouseId?: string | null;
  fromWarehouseId?: string | null;
  toWarehouseId?: string | null;
  adjustmentQty?: number | null;
  bookQty?: number | null;
  actualQty?: number | null;
  reason?: string | null;
  payloadJson?: string | null;
};

type HeaderPayloadInput = {
  warehouseId?: string | null;
  expectedDate?: number | null;
  sourceType?: string | null;
  sourceRef?: string | null;
  contractId?: string | null;
  reason?: string | null;
  counterpartyId?: string | null;
};

type LookupOption = {
  id: string;
  label: string;
  code: string | null;
  meta?: Record<string, unknown>;
};

type PlannedMovement = {
  nomenclatureId: string;
  warehouseId: string;
  movementType: string;
  direction: 'in' | 'out';
  qty: number;
  delta: number;
  reason: string | null;
  counterpartyId: string | null;
};

type PlannedIncomingRow = {
  documentHeaderId: string;
  expectedDate: number;
  warehouseId: string;
  nomenclatureId: string;
  qty: number;
  unit: string | null;
  sourceType: string;
  sourceRef: string | null;
  note: string | null;
};

const PART_DETAILS_GROUP_NAME = 'Детали';
const WAREHOUSE_PART_MIRROR_MODE = String(process.env.MATRICA_WAREHOUSE_PART_MIRROR_MODE ?? 'directory').trim().toLowerCase();

function isLegacyPartMirrorMode() {
  return WAREHOUSE_PART_MIRROR_MODE === 'legacy';
}

function nomenclatureRowIsLinkedPart(specJson: string | null | undefined): boolean {
  const spec = parseJsonObject(specJson ?? null);
  return strField(spec, 'source') === WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART;
}

function nowMs() {
  return Date.now();
}

function isStockDocType(value: string): value is StockDocType {
  return (STOCK_DOC_TYPES as readonly string[]).includes(value);
}

function isIncomingDocType(value: string): value is IncomingDocType {
  return (INCOMING_DOC_TYPES as readonly string[]).includes(value);
}

function resolveIncomingSourceType(docType: string): string {
  if (docType === 'inventory_opening') return 'opening_balance';
  if (docType === 'purchase_receipt') return 'supplier_purchase';
  if (docType === 'production_release') return 'production_release';
  if (docType === 'repair_recovery') return 'repair_recovery';
  if (docType === 'engine_dismantling') return 'engine_dismantling';
  return 'supplier_purchase';
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function strField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  const asNum = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(asNum) ? asNum : undefined;
}

function parseJsonScalar(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (parsed == null) return null;
    if (typeof parsed === 'string') {
      const trimmed = parsed.trim();
      return trimmed ? trimmed : null;
    }
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
    return null;
  } catch {
    const trimmed = String(raw).trim();
    return trimmed ? trimmed : null;
  }
}

/** Скаляры как строка; объекты/массивы — JSON-строка (нужно для `properties_json` шаблонов и др. JSON-полей). */
function parseMasterdataAttrValue(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed == null) return null;
    if (typeof parsed === 'object') return JSON.stringify(parsed);
    if (typeof parsed === 'string') {
      const trimmed = parsed.trim();
      return trimmed ? trimmed : null;
    }
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
    return null;
  } catch {
    return s;
  }
}

function buildLookupMap(rows: LookupOption[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function readLookupLabel(rows: Map<string, LookupOption>, id: string | null | undefined): string | null {
  const safeId = String(id ?? '').trim();
  if (!safeId) return null;
  return rows.get(safeId)?.label ?? null;
}

function normalizeItemTypeToCategory(itemType: string): 'engine' | 'component' | 'assembly' {
  const t = String(itemType || '').toLowerCase();
  if (t === 'engine') return 'engine';
  if (t === 'product' || t === 'semi_product' || t === 'assembly') return 'assembly';
  return 'component';
}

const NOMENCLATURE_ITEM_TYPE_CODE = 'nomenclature_item_type';
const NOMENCLATURE_PROPERTY_CODE = 'nomenclature_property';
const NOMENCLATURE_TEMPLATE_CODE = 'nomenclature_template';

type GovernanceTemplatePayload = {
  templateId: string;
  propertyValues: Record<string, unknown>;
};

async function getEntityTypeIdByCode(typeCode: string): Promise<string | null> {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, typeCode), isNull(entityTypes.deletedAt)))
    .limit(1);
  return typeRows[0]?.id ? String(typeRows[0].id) : null;
}

async function ensureTypeAndDefs(
  typeCode: string,
  typeName: string,
  defs: Array<{ code: string; name: string; dataType: string; sortOrder: number; isRequired?: boolean }>,
): Promise<string> {
  const ts = nowMs();
  let typeId = await getEntityTypeIdByCode(typeCode);
  if (!typeId) {
    typeId = randomUUID();
    await db.insert(entityTypes).values({
      id: typeId,
      code: typeCode,
      name: typeName,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
      lastServerSeq: null,
    });
  }
  const existingDefs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)));
  const existingCodeSet = new Set(existingDefs.map((row) => String(row.code)));
  for (const def of defs) {
    if (existingCodeSet.has(def.code)) continue;
    await db.insert(attributeDefs).values({
      id: randomUUID(),
      entityTypeId: typeId as any,
      code: def.code,
      name: def.name,
      dataType: def.dataType,
      isRequired: Boolean(def.isRequired),
      sortOrder: def.sortOrder,
      metaJson: null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
      lastServerSeq: null,
    });
  }
  return typeId;
}

async function ensureNomenclatureGovernanceMeta(): Promise<void> {
  await ensureTypeAndDefs(NOMENCLATURE_ITEM_TYPE_CODE, 'Типы номенклатуры', [
    { code: 'code', name: 'Код', dataType: 'text', sortOrder: 10, isRequired: true },
    { code: 'name', name: 'Название', dataType: 'text', sortOrder: 20, isRequired: true },
    { code: 'description', name: 'Описание', dataType: 'text', sortOrder: 30 },
  ]);
  await ensureTypeAndDefs(NOMENCLATURE_PROPERTY_CODE, 'Свойства номенклатуры', [
    { code: 'code', name: 'Код', dataType: 'text', sortOrder: 10, isRequired: true },
    { code: 'name', name: 'Название', dataType: 'text', sortOrder: 20, isRequired: true },
    { code: 'data_type', name: 'Тип значения', dataType: 'text', sortOrder: 30, isRequired: true },
    { code: 'is_required', name: 'Обязательное', dataType: 'boolean', sortOrder: 40 },
    { code: 'options_json', name: 'Опции', dataType: 'json', sortOrder: 50 },
    { code: 'description', name: 'Описание', dataType: 'text', sortOrder: 60 },
  ]);
  await ensureTypeAndDefs(NOMENCLATURE_TEMPLATE_CODE, 'Шаблоны номенклатуры', [
    { code: 'code', name: 'Код', dataType: 'text', sortOrder: 10, isRequired: true },
    { code: 'name', name: 'Название', dataType: 'text', sortOrder: 20, isRequired: true },
    { code: 'item_type_code', name: 'Код типа', dataType: 'text', sortOrder: 30 },
    { code: 'directory_kind', name: 'Источник', dataType: 'text', sortOrder: 40 },
    { code: 'properties_json', name: 'Состав свойств', dataType: 'json', sortOrder: 50 },
    { code: 'description', name: 'Описание', dataType: 'text', sortOrder: 60 },
  ]);
}

const DEFAULT_NOMENCLATURE_PROPERTY_SEEDS: Array<{
  code: string;
  name: string;
  dataType: string;
  description?: string;
  optionsJson?: string | null;
}> = [
  { code: 'partner_sku', name: 'Артикул поставщика', dataType: 'text', description: 'Код номенклатуры у поставщика' },
  { code: 'manufacturer', name: 'Производитель', dataType: 'text' },
  { code: 'country_origin', name: 'Страна происхождения', dataType: 'text' },
  { code: 'tnved', name: 'ТН ВЭД', dataType: 'text', description: 'Код ТН ВЭД ЕАЭС' },
  { code: 'okpd2', name: 'ОКПД2', dataType: 'text' },
  { code: 'weight_net_kg', name: 'Вес нетто, кг', dataType: 'number' },
  { code: 'volume_m3', name: 'Объём, м³', dataType: 'number' },
  { code: 'dimensions_mm', name: 'Габариты (Д×Ш×В), мм', dataType: 'text' },
  { code: 'material', name: 'Материал', dataType: 'text' },
  { code: 'quality_grade', name: 'Сорт / качество', dataType: 'text' },
  { code: 'warranty_months', name: 'Гарантия, мес', dataType: 'number' },
  { code: 'accounting_group', name: 'Группа фин. учёта', dataType: 'text' },
  { code: 'storage_conditions', name: 'Условия хранения', dataType: 'text' },
  { code: 'purchase_note', name: 'Комментарий для закупки', dataType: 'text' },
  { code: 'vat_rate', name: 'Ставка НДС, %', dataType: 'number' },
  { code: 'min_ship_qty', name: 'Мин. партия отгрузки', dataType: 'number' },
];

const DEFAULT_NOMENCLATURE_KIND_TO_PROPERTY_CODES: Record<string, string[]> = {
  part: ['manufacturer', 'material', 'partner_sku', 'weight_net_kg', 'dimensions_mm', 'tnved', 'okpd2', 'quality_grade'],
  tool: ['manufacturer', 'material', 'partner_sku', 'warranty_months', 'storage_conditions', 'purchase_note', 'country_origin'],
  good: ['manufacturer', 'partner_sku', 'tnved', 'vat_rate', 'min_ship_qty', 'weight_net_kg', 'purchase_note'],
  service: ['purchase_note', 'vat_rate', 'accounting_group', 'partner_sku'],
  engine_brand: ['manufacturer', 'country_origin', 'purchase_note'],
};

function isEmptyTemplatePropertiesJson(raw: string | null | undefined): boolean {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return true;
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) && v.length === 0;
  } catch {
    return false;
  }
}

function buildNomenclatureTemplatePropertiesPayload(propertyIds: string[]): string {
  const arr = propertyIds.filter(Boolean).map((id, i) => ({ propertyId: id, sortOrder: i * 10 }));
  return JSON.stringify(arr);
}

function defaultNomenclatureTemplateLabel(kind: string): string {
  switch (kind) {
    case 'part':
      return 'Стандарт: детали';
    case 'tool':
      return 'Стандарт: инструмент';
    case 'good':
      return 'Стандарт: товары';
    case 'service':
      return 'Стандарт: услуги';
    case 'engine_brand':
      return 'Стандарт: марки двигателей';
    default:
      return `Стандарт: ${kind}`;
  }
}

let defaultNomenclatureGovernanceSeed: Promise<void> | null = null;

async function runDefaultNomenclatureGovernanceSeed(): Promise<void> {
  const propRows = await listMasterdataEntitiesWithAttrs(NOMENCLATURE_PROPERTY_CODE);
  const propertyIdByCode = new Map(propRows.map((r) => [String(r.attrs.code ?? '').trim().toLowerCase(), r.id]));

  for (const p of DEFAULT_NOMENCLATURE_PROPERTY_SEEDS) {
    const code = p.code.trim().toLowerCase();
    const existingId = propertyIdByCode.get(code);
    const res = await upsertWarehouseNomenclatureProperty({
      ...(existingId ? { id: existingId } : {}),
      code,
      name: p.name,
      dataType: p.dataType,
      description: p.description ?? null,
      optionsJson: p.optionsJson ?? null,
      isRequired: false,
    });
    if (!res.ok) throw new Error(res.error);
    propertyIdByCode.set(code, res.id);
  }

  const refreshedProps = await listMasterdataEntitiesWithAttrs(NOMENCLATURE_PROPERTY_CODE);
  const idByCode = new Map(refreshedProps.map((r) => [String(r.attrs.code ?? '').trim().toLowerCase(), r.id]));

  const templateRows = await listMasterdataEntitiesWithAttrs(NOMENCLATURE_TEMPLATE_CODE);

  for (const kind of Object.keys(DEFAULT_NOMENCLATURE_KIND_TO_PROPERTY_CODES)) {
    const templateCode = `default_${kind}`;
    const codes = DEFAULT_NOMENCLATURE_KIND_TO_PROPERTY_CODES[kind] ?? [];
    const ids = codes.map((c) => idByCode.get(c.toLowerCase())).filter((x): x is string => Boolean(x));
    if (!ids.length) continue;
    const existing = templateRows.find((r) => String(r.attrs.code ?? '').trim().toLowerCase() === templateCode);
    const itemTypeCode = kind === 'tool' ? 'tool_consumable' : 'product';
    const res = await upsertWarehouseNomenclatureTemplate({
      ...(existing ? { id: existing.id } : {}),
      code: templateCode,
      name: defaultNomenclatureTemplateLabel(kind),
      itemTypeCode,
      directoryKind: kind,
      propertiesJson: buildNomenclatureTemplatePropertiesPayload(ids),
      description: 'Автоматически созданный шаблон; состав можно менять в справочнике.',
    });
    if (!res.ok) throw new Error(res.error);
  }

  const templatesAfter = await listMasterdataEntitiesWithAttrs(NOMENCLATURE_TEMPLATE_CODE);
  for (const row of templatesAfter) {
    const code = String(row.attrs.code ?? '').trim().toLowerCase();
    if (!code.startsWith('legacy_')) continue;
    const rawJson = row.attrs.properties_json;
    if (!isEmptyTemplatePropertiesJson(rawJson == null ? '' : String(rawJson))) continue;
    const dk = String(row.attrs.directory_kind ?? '').trim().toLowerCase();
    const codes = DEFAULT_NOMENCLATURE_KIND_TO_PROPERTY_CODES[dk];
    if (!codes?.length) continue;
    const ids = codes.map((c) => idByCode.get(c.toLowerCase())).filter((x): x is string => Boolean(x));
    if (!ids.length) continue;
    const res = await upsertWarehouseNomenclatureTemplate({
      id: row.id,
      code,
      name: String(row.attrs.name ?? code).trim() || code,
      itemTypeCode: row.attrs.item_type_code == null || String(row.attrs.item_type_code).trim() === '' ? null : String(row.attrs.item_type_code),
      directoryKind: dk || null,
      propertiesJson: buildNomenclatureTemplatePropertiesPayload(ids),
      description: row.attrs.description == null || String(row.attrs.description).trim() === '' ? null : String(row.attrs.description),
    });
    if (!res.ok) throw new Error(res.error);
  }
}

async function ensureDefaultNomenclatureGovernanceSeeded(): Promise<void> {
  if (defaultNomenclatureGovernanceSeed) {
    await defaultNomenclatureGovernanceSeed;
    return;
  }
  defaultNomenclatureGovernanceSeed = (async () => {
    await runDefaultNomenclatureGovernanceSeed();
  })();
  try {
    await defaultNomenclatureGovernanceSeed;
  } catch (e) {
    defaultNomenclatureGovernanceSeed = null;
    throw e;
  }
}

function parseGovernanceSpecPayload(raw: string | null | undefined): GovernanceTemplatePayload | null {
  const payload = parseJsonObject(raw ?? null);
  const templateId = strField(payload, 'templateId');
  if (!templateId) return null;
  const propertyValuesRaw = payload.propertyValues;
  const propertyValues =
    propertyValuesRaw && typeof propertyValuesRaw === 'object' && !Array.isArray(propertyValuesRaw)
      ? (propertyValuesRaw as Record<string, unknown>)
      : {};
  return { templateId, propertyValues };
}

async function listMasterdataLookup(typeCode: string): Promise<LookupOption[]> {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, typeCode), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id ? String(typeRows[0].id) : '';
  if (!typeId) return [];

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)))
    .orderBy(asc(attributeDefs.sortOrder), asc(attributeDefs.code));
  const defById = new Map(defs.map((def) => [String(def.id), String(def.code)]));
  const knownCodes = new Set(defs.map((def) => String(def.code)));

  const rows = await db
    .select({ id: entities.id, updatedAt: entities.updatedAt })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)))
    .orderBy(asc(entities.updatedAt));
  if (!rows.length) return [];

  const entityIds = rows.map((row) => String(row.id));
  const defIds = defs.map((def) => String(def.id));
  const values =
    defIds.length > 0
      ? await db
          .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(
            and(
              inArray(attributeValues.entityId, entityIds as any),
              inArray(attributeValues.attributeDefId, defIds as any),
              isNull(attributeValues.deletedAt),
            ),
          )
      : [];

  const attrsByEntity = new Map<string, Record<string, string | null>>();
  for (const row of values) {
    const entityId = String(row.entityId);
    const attrCode = defById.get(String(row.attributeDefId));
    if (!attrCode) continue;
    const current = attrsByEntity.get(entityId) ?? {};
    current[attrCode] = parseJsonScalar(row.valueJson);
    attrsByEntity.set(entityId, current);
  }

  const labelCode = ['name', 'title', 'label'].find((code) => knownCodes.has(code)) ?? (knownCodes.has('code') ? 'code' : null);
  return rows
    .map((row) => {
      const entityId = String(row.id);
      const attrs = attrsByEntity.get(entityId) ?? {};
      const label = String((labelCode ? attrs[labelCode] : null) ?? attrs.code ?? entityId).trim();
      const code = attrs.code ?? null;
      const meta = Object.fromEntries(
        Object.entries({
          address: attrs.address ?? null,
          description: attrs.description ?? null,
        }).filter((entry) => entry[1] != null),
      );
      return {
        id: entityId,
        label,
        code,
        ...(Object.keys(meta).length ? { meta } : {}),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label, 'ru'));
}

async function listMasterdataEntitiesWithAttrs(
  typeCode: string,
): Promise<Array<{ id: string; attrs: Record<string, string | null> }>> {
  const typeId = await getEntityTypeIdByCode(typeCode);
  if (!typeId) return [];
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)));
  const defById = new Map(defs.map((def) => [String(def.id), String(def.code)] as const));
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt)));
  const entityIds = rows.map((row) => String(row.id));
  if (entityIds.length === 0) return [];
  const values = await db
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, entityIds as any), isNull(attributeValues.deletedAt)));
  const attrsByEntity = new Map<string, Record<string, string | null>>();
  for (const value of values) {
    const entityId = String(value.entityId);
    const code = defById.get(String(value.attributeDefId));
    if (!code) continue;
    const bag = attrsByEntity.get(entityId) ?? {};
    bag[code] = parseMasterdataAttrValue(value.valueJson);
    attrsByEntity.set(entityId, bag);
  }
  return rows.map((row) => ({
    id: String(row.id),
    attrs: attrsByEntity.get(String(row.id)) ?? {},
  }));
}

async function upsertMasterdataEntityByTypeCode(args: {
  typeCode: string;
  typeName: string;
  defs: Array<{ code: string; name: string; dataType: string; sortOrder: number; isRequired?: boolean }>;
  id?: string;
  attrs: Record<string, string | null>;
}): Promise<Result<{ id: string }>> {
  try {
    const typeId = await ensureTypeAndDefs(args.typeCode, args.typeName, args.defs);
    const ts = nowMs();
    const id = String(args.id || randomUUID());
    await db
      .insert(entities)
      .values({
        id,
        typeId: typeId as any,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
        lastServerSeq: null,
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: { typeId: typeId as any, updatedAt: ts, deletedAt: null, syncStatus: 'synced' },
      });
    const defs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)));
    const defMap = new Map(defs.map((row) => [String(row.code), String(row.id)] as const));
    for (const [code, value] of Object.entries(args.attrs)) {
      const defId = defMap.get(code);
      if (!defId) continue;
      await db
        .insert(attributeValues)
        .values({
          id: randomUUID(),
          entityId: id as any,
          attributeDefId: defId as any,
          valueJson: value == null ? null : JSON.stringify(value),
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'synced',
          lastServerSeq: null,
        })
        .onConflictDoUpdate({
          target: [attributeValues.entityId, attributeValues.attributeDefId],
          set: {
            valueJson: value == null ? null : JSON.stringify(value),
            updatedAt: ts,
            deletedAt: null,
            syncStatus: 'synced',
          },
        });
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function deleteMasterdataEntityByTypeCode(args: { typeCode: string; id: string }): Promise<Result<{ id: string }>> {
  try {
    const typeId = await getEntityTypeIdByCode(args.typeCode);
    if (!typeId) return { ok: false, error: `Не найден тип справочника: ${args.typeCode}` };
    const ts = nowMs();
    await db
      .update(entities)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(and(eq(entities.id, args.id), eq(entities.typeId, typeId as any), isNull(entities.deletedAt)));
    return { ok: true, id: args.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function ensureDefaultWarehouse(rows: LookupOption[]): LookupOption[] {
  if (rows.some((row) => row.id === 'default')) return rows;
  /** Плейсхолдер id не меняем (`default`); `code: null` — чтобы в UI не дублировалось «(default)» рядом с названием. */
  return [{ id: 'default', label: 'Склад по умолчанию', code: null }, ...rows];
}

async function ensurePartNomenclatureGroup(): Promise<string | null> {
  const ts = nowMs();
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'nomenclature_group'), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id ? String(typeRows[0].id) : '';
  if (!typeId) return null;

  const attrRows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)));
  const nameDefId = attrRows.find((row) => String(row.code) === 'name')?.id;
  const kindDefId = attrRows.find((row) => String(row.code) === 'kind')?.id;
  if (!nameDefId) return null;

  const rows = await db
    .select({ id: entities.id, valueJson: attributeValues.valueJson })
    .from(entities)
    .innerJoin(attributeValues, and(eq(attributeValues.entityId, entities.id), eq(attributeValues.attributeDefId, nameDefId as any)))
    .where(and(eq(entities.typeId, typeId as any), isNull(entities.deletedAt), isNull(attributeValues.deletedAt)));
  const existing = rows.find((row) => parseJsonScalar(row.valueJson) === PART_DETAILS_GROUP_NAME);
  if (existing?.id) return String(existing.id);

  const entityId = randomUUID();
  await db.insert(entities).values({
    id: entityId,
    typeId: typeId as any,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  await db.insert(attributeValues).values({
    id: randomUUID(),
    entityId: entityId as any,
    attributeDefId: nameDefId as any,
    valueJson: JSON.stringify(PART_DETAILS_GROUP_NAME),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  if (kindDefId) {
    await db.insert(attributeValues).values({
      id: randomUUID(),
      entityId: entityId as any,
      attributeDefId: kindDefId as any,
      valueJson: JSON.stringify('Продукция'),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
  }
  return entityId;
}

async function syncPartsToWarehouseNomenclature(args: { detailsGroupId: string | null }) {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'part'), isNull(entityTypes.deletedAt)))
    .limit(1);
  const partTypeId = typeRows[0]?.id ? String(typeRows[0].id) : '';
  if (!partTypeId) return;

  const partDefs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, partTypeId as any), isNull(attributeDefs.deletedAt)));
  const nameDefId = partDefs.find((row) => String(row.code) === 'name')?.id;
  const articleDefId = partDefs.find((row) => String(row.code) === 'article')?.id;
  const templateDefId = partDefs.find((row) => String(row.code) === PART_TEMPLATE_ID_ATTR_CODE)?.id;
  if (!nameDefId) return;

  const partRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, partTypeId as any), isNull(entities.deletedAt)));
  if (!partRows.length) return;

  const partIds = partRows.map((row) => String(row.id));
  const defIds = [nameDefId, articleDefId, templateDefId].filter((v): v is string => Boolean(v)).map((v) => String(v));
  const valRows =
    defIds.length > 0
      ? await db
          .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
          .from(attributeValues)
          .where(and(inArray(attributeValues.entityId, partIds as any), inArray(attributeValues.attributeDefId, defIds as any), isNull(attributeValues.deletedAt)))
      : [];
  const attrsByPart = new Map<string, Record<string, string | null>>();
  const codeByDefId = new Map(
    partDefs
      .filter((row) => defIds.includes(String(row.id)))
      .map((row) => [String(row.id), String(row.code)] as const),
  );
  for (const row of valRows) {
    const partId = String(row.entityId);
    const code = codeByDefId.get(String(row.attributeDefId));
    if (!code) continue;
    const bag = attrsByPart.get(partId) ?? {};
    bag[code] = parseJsonScalar(row.valueJson);
    attrsByPart.set(partId, bag);
  }

  const existingRows =
    partIds.length > 0
      ? await db
          .select()
          .from(erpNomenclature)
          .where(and(inArray(erpNomenclature.id, partIds as any), isNull(erpNomenclature.deletedAt)))
      : [];
  const existingById = new Map(existingRows.map((row) => [String(row.id), row]));

  for (const partId of partIds) {
    const attrs = attrsByPart.get(partId) ?? {};
    const name = String(attrs.name ?? '').trim() || `Деталь ${partId.slice(0, 8)}`;
    const article = String(attrs.article ?? '').trim();
    const templateId = String(attrs[PART_TEMPLATE_ID_ATTR_CODE] ?? '').trim();
    const specJson = JSON.stringify({
      source: WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART,
      partId,
      ...(templateId ? { templateId } : {}),
      ...(article ? { article } : {}),
    });
    const code = article || `DET-${partId.slice(0, 8).toUpperCase()}`;
    const existing = existingById.get(partId);
    const upsertRes = await upsertWarehouseNomenclature({
      id: partId,
      code,
      name,
      itemType: 'product',
      directoryKind: 'part',
      directoryRefId: partId,
      groupId: args.detailsGroupId ?? null,
      unitId: existing?.unitId ?? null,
      barcode: existing?.barcode ?? null,
      minStock: existing?.minStock ?? null,
      maxStock: existing?.maxStock ?? null,
      defaultWarehouseId: existing?.defaultWarehouseId ?? null,
      specJson,
      isActive: true,
      _syncFromPart: true,
    });
    if (!upsertRes.ok) {
      console.warn('[warehouse] part→nomenclature mirror failed', partId, upsertRes.error);
    }
  }

  const activePartSet = new Set(partIds);
  const mirrorCandidates = await db
    .select({ id: erpNomenclature.id, specJson: erpNomenclature.specJson })
    .from(erpNomenclature)
    .where(isNull(erpNomenclature.deletedAt));
  for (const row of mirrorCandidates) {
    if (!nomenclatureRowIsLinkedPart(row.specJson)) continue;
    const spec = parseJsonObject(row.specJson);
    const pid = strField(spec, 'partId') ?? String(row.id);
    if (activePartSet.has(pid)) continue;
    const delRes = await deleteWarehouseNomenclature({ id: String(row.id), allowLinkedPartMirror: true });
    if (!delRes.ok) {
      console.warn('[warehouse] failed to retire part nomenclature mirror', row.id, delRes.error);
    }
  }
}

async function listWarehouseReferenceData() {
  if (isLegacyPartMirrorMode()) {
    await ensurePartNomenclatureGroup();
  }
  const [warehousesRaw, nomenclatureGroups, units, writeoffReasons, counterpartiesRows, employeesRows, engineBrands] = await Promise.all([
    listMasterdataLookup('warehouse_ref'),
    listMasterdataLookup('nomenclature_group'),
    listMasterdataLookup('unit'),
    listMasterdataLookup('stock_write_off_reason'),
    db.select().from(erpCounterparties).where(isNull(erpCounterparties.deletedAt)).orderBy(asc(erpCounterparties.name)),
    db.select().from(erpEmployeeCards).where(isNull(erpEmployeeCards.deletedAt)).orderBy(asc(erpEmployeeCards.fullName)),
    listMasterdataLookup('engine_brand'),
  ]);

  const warehouses = ensureDefaultWarehouse(warehousesRaw);
  const counterparties: LookupOption[] = counterpartiesRows.map((row) => ({
    id: String(row.id),
    label: String(row.name),
    code: row.code == null ? null : String(row.code),
  }));
  const employees: LookupOption[] = employeesRows.map((row) => ({
    id: String(row.id),
    label: String(row.fullName),
    code: row.personnelNo == null ? null : String(row.personnelNo),
  }));

  return {
    warehouses,
    nomenclatureGroups,
    units,
    writeoffReasons,
    counterparties,
    employees,
    engineBrands,
    warehouseById: buildLookupMap(warehouses),
    groupById: buildLookupMap(nomenclatureGroups),
    unitById: buildLookupMap(units),
    writeoffReasonById: buildLookupMap(writeoffReasons),
    counterpartyById: buildLookupMap(counterparties),
    employeeById: buildLookupMap(employees),
    engineBrandById: buildLookupMap(engineBrands),
  };
}

function parseWarehouseHeaderPayload(raw: string | null | undefined) {
  const payload = parseJsonObject(raw);
  return {
    warehouseId: strField(payload, 'warehouseId') ?? null,
    expectedDate: numField(payload, 'expectedDate') ?? null,
    sourceType: strField(payload, 'sourceType') ?? null,
    sourceRef: strField(payload, 'sourceRef') ?? null,
    contractId: strField(payload, 'contractId') ?? null,
    reason: strField(payload, 'reason') ?? null,
    counterpartyId: strField(payload, 'counterpartyId') ?? null,
  };
}

function parseWarehouseLinePayload(raw: string | null | undefined) {
  const payload = parseJsonObject(raw);
  return {
    nomenclatureId: strField(payload, 'nomenclatureId') ?? null,
    unit: strField(payload, 'unit') ?? null,
    batch: strField(payload, 'batch') ?? null,
    note: strField(payload, 'note') ?? null,
    cost: numField(payload, 'cost') ?? null,
    warehouseId: strField(payload, 'warehouseId') ?? null,
    fromWarehouseId: strField(payload, 'fromWarehouseId') ?? null,
    toWarehouseId: strField(payload, 'toWarehouseId') ?? null,
    adjustmentQty: numField(payload, 'adjustmentQty') ?? null,
    bookQty: numField(payload, 'bookQty') ?? null,
    actualQty: numField(payload, 'actualQty') ?? null,
    reason: strField(payload, 'reason') ?? null,
  };
}

function mergeHeaderPayloadJson(raw: string | null | undefined, input?: HeaderPayloadInput | null) {
  const payload = parseJsonObject(raw);
  if (input?.warehouseId !== undefined) payload.warehouseId = input.warehouseId;
  if (input?.expectedDate !== undefined) payload.expectedDate = input.expectedDate;
  if (input?.sourceType !== undefined) payload.sourceType = input.sourceType;
  if (input?.sourceRef !== undefined) payload.sourceRef = input.sourceRef;
  if (input?.contractId !== undefined) payload.contractId = input.contractId;
  if (input?.reason !== undefined) payload.reason = input.reason;
  if (input?.counterpartyId !== undefined) payload.counterpartyId = input.counterpartyId;
  const compact = Object.fromEntries(Object.entries(payload).filter((entry) => entry[1] != null && entry[1] !== ''));
  return Object.keys(compact).length > 0 ? JSON.stringify(compact) : null;
}

function mergeLinePayloadJson(raw: string | null | undefined, input: DocLineInput) {
  const payload = parseJsonObject(raw);
  if (input.nomenclatureId !== undefined) payload.nomenclatureId = input.nomenclatureId;
  if (input.unit !== undefined) payload.unit = input.unit;
  if (input.batch !== undefined) payload.batch = input.batch;
  if (input.note !== undefined) payload.note = input.note;
  if (input.cost !== undefined) payload.cost = input.cost;
  if (input.warehouseId !== undefined) payload.warehouseId = input.warehouseId;
  if (input.fromWarehouseId !== undefined) payload.fromWarehouseId = input.fromWarehouseId;
  if (input.toWarehouseId !== undefined) payload.toWarehouseId = input.toWarehouseId;
  if (input.adjustmentQty !== undefined) payload.adjustmentQty = input.adjustmentQty;
  if (input.bookQty !== undefined) payload.bookQty = input.bookQty;
  if (input.actualQty !== undefined) payload.actualQty = input.actualQty;
  if (input.reason !== undefined) payload.reason = input.reason;
  const compact = Object.fromEntries(Object.entries(payload).filter((entry) => entry[1] != null && entry[1] !== ''));
  return Object.keys(compact).length > 0 ? JSON.stringify(compact) : null;
}

function documentLineSelectFields() {
  return {
    id: erpDocumentLines.id,
    headerId: erpDocumentLines.headerId,
    lineNo: erpDocumentLines.lineNo,
    partCardId: erpDocumentLines.partCardId,
    qty: erpDocumentLines.qty,
    price: erpDocumentLines.price,
    payloadJson: erpDocumentLines.payloadJson,
    createdAt: erpDocumentLines.createdAt,
    updatedAt: erpDocumentLines.updatedAt,
    deletedAt: erpDocumentLines.deletedAt,
  };
}

function buildPlannedIncomingRows(args: {
  documentId: string;
  docType: string;
  headerPayload: ReturnType<typeof parseWarehouseHeaderPayload>;
  lines: Array<{ qty: number; payloadJson: string | null }>;
}): PlannedIncomingRow[] {
  if (!isIncomingDocType(args.docType)) return [];
  const expectedDate = Math.trunc(
    Number(args.headerPayload.expectedDate ?? Date.now()),
  );
  const sourceType = args.headerPayload.sourceType ?? resolveIncomingSourceType(args.docType);
  const sourceRef = args.headerPayload.sourceRef ?? null;
  const rows: PlannedIncomingRow[] = [];
  for (const line of args.lines) {
    const qty = Math.max(0, Math.trunc(Number(line.qty ?? 0)));
    if (qty <= 0) continue;
    const payload = parseWarehouseLinePayload(line.payloadJson);
    if (!payload.nomenclatureId) continue;
    rows.push({
      documentHeaderId: args.documentId,
      expectedDate,
      warehouseId: payload.warehouseId ?? args.headerPayload.warehouseId ?? 'default',
      nomenclatureId: payload.nomenclatureId,
      qty,
      unit: payload.unit ?? null,
      sourceType,
      sourceRef,
      note: payload.note ?? null,
    });
  }
  return rows;
}

async function replacePlannedIncomingRows(documentId: string, rows: PlannedIncomingRow[], ts: number) {
  await db
    .update(erpPlannedIncoming)
    .set({ deletedAt: ts, updatedAt: ts })
    .where(and(eq(erpPlannedIncoming.documentHeaderId, documentId), isNull(erpPlannedIncoming.deletedAt)));
  if (rows.length === 0) return;
  await db.insert(erpPlannedIncoming).values(
    rows.map((row) => ({
      id: randomUUID(),
      documentHeaderId: row.documentHeaderId,
      expectedDate: row.expectedDate,
      warehouseId: row.warehouseId,
      nomenclatureId: row.nomenclatureId,
      qty: row.qty,
      unit: row.unit,
      sourceType: row.sourceType,
      sourceRef: row.sourceRef,
      note: row.note,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    })),
  );
}

async function clearPlannedIncomingRows(documentId: string, ts: number) {
  await db
    .update(erpPlannedIncoming)
    .set({ deletedAt: ts, updatedAt: ts })
    .where(and(eq(erpPlannedIncoming.documentHeaderId, documentId), isNull(erpPlannedIncoming.deletedAt)));
}

export async function listWarehouseLookups(): Promise<
  Result<{
    lookups: {
      warehouses: LookupOption[];
      nomenclatureGroups: LookupOption[];
      units: LookupOption[];
      writeoffReasons: LookupOption[];
      counterparties: LookupOption[];
      employees: LookupOption[];
      engineBrands: LookupOption[];
      nomenclatureItemTypes: LookupOption[];
      nomenclatureProperties: LookupOption[];
      nomenclatureTemplates: LookupOption[];
    };
  }>
> {
  try {
    await ensureNomenclatureGovernanceMeta();
    await ensureDefaultNomenclatureGovernanceSeeded();
    const refs = await listWarehouseReferenceData();
    const [nomenclatureItemTypes, nomenclatureProperties, nomenclatureTemplates] = await Promise.all([
      listMasterdataLookup(NOMENCLATURE_ITEM_TYPE_CODE),
      listMasterdataLookup(NOMENCLATURE_PROPERTY_CODE),
      listMasterdataLookup(NOMENCLATURE_TEMPLATE_CODE),
    ]);
    return {
      ok: true,
      lookups: {
        warehouses: refs.warehouses,
        nomenclatureGroups: refs.nomenclatureGroups,
        units: refs.units,
        writeoffReasons: refs.writeoffReasons,
        counterparties: refs.counterparties,
        employees: refs.employees,
        engineBrands: refs.engineBrands,
        nomenclatureItemTypes,
        nomenclatureProperties,
        nomenclatureTemplates,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseNomenclatureItemTypes(): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    await ensureNomenclatureGovernanceMeta();
    const rows = await listMasterdataEntitiesWithAttrs(NOMENCLATURE_ITEM_TYPE_CODE);
    return {
      ok: true,
      rows: rows.map((row) => ({
        id: row.id,
        code: String(row.attrs.code ?? '').trim(),
        name: String(row.attrs.name ?? '').trim(),
        description: row.attrs.description ?? null,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseNomenclatureItemType(args: {
  id?: string;
  code: string;
  name: string;
  description?: string | null;
}): Promise<Result<{ id: string }>> {
  return upsertMasterdataEntityByTypeCode({
    typeCode: NOMENCLATURE_ITEM_TYPE_CODE,
    typeName: 'Типы номенклатуры',
    defs: [
      { code: 'code', name: 'Код', dataType: 'text', sortOrder: 10, isRequired: true },
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 20, isRequired: true },
      { code: 'description', name: 'Описание', dataType: 'text', sortOrder: 30 },
    ],
    ...(args.id !== undefined ? { id: args.id } : {}),
    attrs: {
      code: String(args.code ?? '').trim() || null,
      name: String(args.name ?? '').trim() || null,
      description: args.description == null ? null : String(args.description).trim() || null,
    },
  });
}

export async function deleteWarehouseNomenclatureItemType(args: { id: string }): Promise<Result<{ id: string }>> {
  return deleteMasterdataEntityByTypeCode({ typeCode: NOMENCLATURE_ITEM_TYPE_CODE, id: String(args.id) });
}

export async function listWarehouseNomenclatureProperties(): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    await ensureNomenclatureGovernanceMeta();
    await ensureDefaultNomenclatureGovernanceSeeded();
    const rows = await listMasterdataEntitiesWithAttrs(NOMENCLATURE_PROPERTY_CODE);
    return {
      ok: true,
      rows: rows.map((row) => ({
        id: row.id,
        code: String(row.attrs.code ?? '').trim(),
        name: String(row.attrs.name ?? '').trim(),
        dataType: String(row.attrs.data_type ?? 'text').trim().toLowerCase() || 'text',
        isRequired: String(row.attrs.is_required ?? '').trim().toLowerCase() === 'true',
        optionsJson: row.attrs.options_json ?? null,
        description: row.attrs.description ?? null,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseNomenclatureProperty(args: {
  id?: string;
  code: string;
  name: string;
  dataType: string;
  isRequired?: boolean;
  optionsJson?: string | null;
  description?: string | null;
}): Promise<Result<{ id: string }>> {
  return upsertMasterdataEntityByTypeCode({
    typeCode: NOMENCLATURE_PROPERTY_CODE,
    typeName: 'Свойства номенклатуры',
    defs: [
      { code: 'code', name: 'Код', dataType: 'text', sortOrder: 10, isRequired: true },
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 20, isRequired: true },
      { code: 'data_type', name: 'Тип значения', dataType: 'text', sortOrder: 30, isRequired: true },
      { code: 'is_required', name: 'Обязательное', dataType: 'boolean', sortOrder: 40 },
      { code: 'options_json', name: 'Опции', dataType: 'json', sortOrder: 50 },
      { code: 'description', name: 'Описание', dataType: 'text', sortOrder: 60 },
    ],
    ...(args.id !== undefined ? { id: args.id } : {}),
    attrs: {
      code: String(args.code ?? '').trim() || null,
      name: String(args.name ?? '').trim() || null,
      data_type: String(args.dataType ?? 'text').trim().toLowerCase() || 'text',
      is_required: args.isRequired ? 'true' : 'false',
      options_json: args.optionsJson == null ? null : String(args.optionsJson).trim() || null,
      description: args.description == null ? null : String(args.description).trim() || null,
    },
  });
}

export async function deleteWarehouseNomenclatureProperty(args: { id: string }): Promise<Result<{ id: string }>> {
  return deleteMasterdataEntityByTypeCode({ typeCode: NOMENCLATURE_PROPERTY_CODE, id: String(args.id) });
}

export async function listWarehouseNomenclatureTemplates(): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    await ensureNomenclatureGovernanceMeta();
    await ensureDefaultNomenclatureGovernanceSeeded();
    const rows = await listMasterdataEntitiesWithAttrs(NOMENCLATURE_TEMPLATE_CODE);
    return {
      ok: true,
      rows: rows.map((row) => ({
        id: row.id,
        code: String(row.attrs.code ?? '').trim(),
        name: String(row.attrs.name ?? '').trim(),
        itemTypeCode: row.attrs.item_type_code ?? null,
        directoryKind: row.attrs.directory_kind ?? null,
        propertiesJson: row.attrs.properties_json ?? null,
        description: row.attrs.description ?? null,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseNomenclatureTemplate(args: {
  id?: string;
  code: string;
  name: string;
  itemTypeCode?: string | null;
  directoryKind?: string | null;
  propertiesJson?: string | null;
  description?: string | null;
}): Promise<Result<{ id: string }>> {
  return upsertMasterdataEntityByTypeCode({
    typeCode: NOMENCLATURE_TEMPLATE_CODE,
    typeName: 'Шаблоны номенклатуры',
    defs: [
      { code: 'code', name: 'Код', dataType: 'text', sortOrder: 10, isRequired: true },
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 20, isRequired: true },
      { code: 'item_type_code', name: 'Код типа', dataType: 'text', sortOrder: 30 },
      { code: 'directory_kind', name: 'Источник', dataType: 'text', sortOrder: 40 },
      { code: 'properties_json', name: 'Состав свойств', dataType: 'json', sortOrder: 50 },
      { code: 'description', name: 'Описание', dataType: 'text', sortOrder: 60 },
    ],
    ...(args.id !== undefined ? { id: args.id } : {}),
    attrs: {
      code: String(args.code ?? '').trim() || null,
      name: String(args.name ?? '').trim() || null,
      item_type_code: args.itemTypeCode == null ? null : String(args.itemTypeCode).trim() || null,
      directory_kind: args.directoryKind == null ? null : String(args.directoryKind).trim() || null,
      properties_json: args.propertiesJson == null ? null : String(args.propertiesJson).trim() || null,
      description: args.description == null ? null : String(args.description).trim() || null,
    },
  });
}

export async function deleteWarehouseNomenclatureTemplate(args: { id: string }): Promise<Result<{ id: string }>> {
  return deleteMasterdataEntityByTypeCode({ typeCode: NOMENCLATURE_TEMPLATE_CODE, id: String(args.id) });
}

export async function listWarehouseNomenclature(args?: {
  id?: string;
  search?: string;
  itemType?: string;
  directoryKind?: string;
  groupId?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}): Promise<Result<{ rows: Array<Record<string, unknown>>; hasMore?: boolean }>> {
  try {
    /** Полная синхронизация деталей→номенклатура выполняется при изменении деталей (`refreshPartWarehouseNomenclatureLinks`), а не при каждом открытии списка — иначе N upsert-ов и ledger-транзакций на каждый GET и таймаут клиента. */
    const refs = await listWarehouseReferenceData();
    const idOne = String(args?.id ?? '').trim();
    if (idOne) {
      const one = await db
        .select()
        .from(erpNomenclature)
        .where(and(eq(erpNomenclature.id, idOne), isNull(erpNomenclature.deletedAt)))
        .limit(1);
      return {
        ok: true,
        hasMore: false,
        rows: one.map((row) => ({
          ...row,
          sku: row.sku ?? row.code ?? null,
          category: row.category ?? normalizeItemTypeToCategory(String(row.itemType ?? 'component')),
          defaultBrandId: row.defaultBrandId ?? null,
          isSerialTracked: Boolean(row.isSerialTracked ?? String(row.itemType ?? '').toLowerCase() === 'engine'),
          defaultBrandName: readLookupLabel(refs.engineBrandById, row.defaultBrandId == null ? null : String(row.defaultBrandId)),
          groupName: readLookupLabel(refs.groupById, row.groupId == null ? null : String(row.groupId)),
          unitName: readLookupLabel(refs.unitById, row.unitId == null ? null : String(row.unitId)),
          defaultWarehouseName: readLookupLabel(refs.warehouseById, row.defaultWarehouseId == null ? null : String(row.defaultWarehouseId)),
        })) as Array<Record<string, unknown>>,
      };
    }

    const searchRaw = String(args?.search ?? '').trim();
    const limit = Math.min(Math.max(Number(args?.limit ?? 3000), 1), 10_000);
    const offset = Math.max(Number(args?.offset ?? 0), 0);

    const parts = [isNull(erpNomenclature.deletedAt)];
    if (args?.itemType) parts.push(eq(erpNomenclature.itemType, String(args.itemType)));
    if (args?.groupId) parts.push(eq(erpNomenclature.groupId, String(args.groupId)));
    if (args?.directoryKind) parts.push(eq(erpNomenclature.directoryKind, String(args.directoryKind)));
    if (args?.isActive !== undefined) parts.push(eq(erpNomenclature.isActive, Boolean(args.isActive)));

    if (searchRaw) {
      const pat = `%${searchRaw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      parts.push(
        sql`(
          COALESCE(${erpNomenclature.code}, '') ILIKE ${pat} ESCAPE '\\'
          OR COALESCE(${erpNomenclature.sku}, '') ILIKE ${pat} ESCAPE '\\'
          OR COALESCE(${erpNomenclature.name}, '') ILIKE ${pat} ESCAPE '\\'
          OR COALESCE(${erpNomenclature.barcode}, '') ILIKE ${pat} ESCAPE '\\'
        )`,
      );
    }

    const whereExpr = and(...parts);
    const pageRows = await db
      .select()
      .from(erpNomenclature)
      .where(whereExpr)
      .orderBy(asc(erpNomenclature.name))
      .limit(limit + 1)
      .offset(offset);
    const hasMore = pageRows.length > limit;
    const rows = hasMore ? pageRows.slice(0, limit) : pageRows;

    return {
      ok: true,
      hasMore,
      rows: rows.map((row) => ({
        ...row,
        sku: row.sku ?? row.code ?? null,
        category: row.category ?? normalizeItemTypeToCategory(String(row.itemType ?? 'component')),
        defaultBrandId: row.defaultBrandId ?? null,
        isSerialTracked: Boolean(row.isSerialTracked ?? String(row.itemType ?? '').toLowerCase() === 'engine'),
        defaultBrandName: readLookupLabel(refs.engineBrandById, row.defaultBrandId == null ? null : String(row.defaultBrandId)),
        groupName: readLookupLabel(refs.groupById, row.groupId == null ? null : String(row.groupId)),
        unitName: readLookupLabel(refs.unitById, row.unitId == null ? null : String(row.unitId)),
        defaultWarehouseName: readLookupLabel(refs.warehouseById, row.defaultWarehouseId == null ? null : String(row.defaultWarehouseId)),
      })) as Array<Record<string, unknown>>,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseNomenclature(args: {
  id?: string;
  code: string;
  sku?: string | null;
  name: string;
  itemType?: string;
  category?: string | null;
  directoryKind?: string | null;
  directoryRefId?: string | null;
  groupId?: string | null;
  unitId?: string | null;
  barcode?: string | null;
  minStock?: number | null;
  maxStock?: number | null;
  defaultBrandId?: string | null;
  isSerialTracked?: boolean;
  defaultWarehouseId?: string | null;
  specJson?: string | null;
  isActive?: boolean;
  /** Внутренний вызов: зеркало карточки детали в номенклатуре склада */
  _syncFromPart?: boolean;
}): Promise<Result<{ id: string }>> {
  try {
    await ensureNomenclatureGovernanceMeta();
    const id = String(args.id || randomUUID());
    const isCreate = !args.id;
    if (!args._syncFromPart && isLegacyPartMirrorMode()) {
      const prevRows = await db
        .select({ specJson: erpNomenclature.specJson })
        .from(erpNomenclature)
        .where(and(eq(erpNomenclature.id, id), isNull(erpNomenclature.deletedAt)))
        .limit(1);
      if (prevRows[0] && nomenclatureRowIsLinkedPart(prevRows[0].specJson)) {
        return {
          ok: false,
          error:
            'Позиция привязана к детали (Производство). Редактируйте карточку детали — складская номенклатура обновится автоматически.',
        };
      }
    }
    const governanceSpec = parseGovernanceSpecPayload(args.specJson ?? null);
    if (isCreate) {
      if (!args.directoryKind || !String(args.directoryKind).trim()) return { ok: false, error: 'Для создания укажите источник (directoryKind).' };
      if (!args.directoryRefId || !String(args.directoryRefId).trim()) return { ok: false, error: 'Для создания укажите карточку источника (directoryRefId).' };
      if (!args.groupId || !String(args.groupId).trim()) return { ok: false, error: 'Для создания укажите группу номенклатуры.' };
      if (!args.unitId || !String(args.unitId).trim()) return { ok: false, error: 'Для создания укажите единицу измерения.' };
      if (!governanceSpec?.templateId) return { ok: false, error: 'Для создания укажите шаблон номенклатуры (templateId в specJson).' };
    }

    const itemTypeRows = await listMasterdataEntitiesWithAttrs(NOMENCLATURE_ITEM_TYPE_CODE);
    const allowedItemTypes = new Set(
      itemTypeRows.map((row) => String(row.attrs.code ?? '').trim().toLowerCase()).filter(Boolean),
    );
    const nextItemType = String(args.itemType || 'material').trim().toLowerCase();
    if (allowedItemTypes.size > 0 && !allowedItemTypes.has(nextItemType)) {
      return { ok: false, error: `Недопустимый тип номенклатуры: ${nextItemType}` };
    }

    let resolvedSourceName: string | null = null;
    const sourceKind = String(args.directoryKind ?? '').trim().toLowerCase();
    const sourceRefId = String(args.directoryRefId ?? '').trim();
    if (sourceKind && sourceRefId) {
      if (sourceKind === 'tool') {
        const rows = await db.select({ name: directoryTools.name }).from(directoryTools).where(and(eq(directoryTools.id, sourceRefId as any), isNull(directoryTools.deletedAt))).limit(1);
        resolvedSourceName = rows[0]?.name ? String(rows[0].name) : null;
      } else if (sourceKind === 'good') {
        const rows = await db.select({ name: directoryGoods.name }).from(directoryGoods).where(and(eq(directoryGoods.id, sourceRefId as any), isNull(directoryGoods.deletedAt))).limit(1);
        resolvedSourceName = rows[0]?.name ? String(rows[0].name) : null;
      } else if (sourceKind === 'service') {
        const rows = await db.select({ name: directoryServices.name }).from(directoryServices).where(and(eq(directoryServices.id, sourceRefId as any), isNull(directoryServices.deletedAt))).limit(1);
        resolvedSourceName = rows[0]?.name ? String(rows[0].name) : null;
      } else if (sourceKind === 'part') {
        const rows = await db.select({ name: directoryParts.name }).from(directoryParts).where(and(eq(directoryParts.id, sourceRefId as any), isNull(directoryParts.deletedAt))).limit(1);
        resolvedSourceName = rows[0]?.name ? String(rows[0].name) : null;
      } else if (sourceKind === 'engine_brand') {
        const rows = await db
          .select({ name: directoryEngineBrands.name })
          .from(directoryEngineBrands)
          .where(and(eq(directoryEngineBrands.id, sourceRefId as any), isNull(directoryEngineBrands.deletedAt)))
          .limit(1);
        resolvedSourceName = rows[0]?.name ? String(rows[0].name) : null;
      }
      if (!resolvedSourceName) {
        return { ok: false, error: `Источник ${sourceKind}:${sourceRefId} не найден или удален.` };
      }
    }

    if (governanceSpec?.templateId) {
      const templates = await listMasterdataEntitiesWithAttrs(NOMENCLATURE_TEMPLATE_CODE);
      const template = templates.find((row) => row.id === governanceSpec.templateId);
      if (!template) return { ok: false, error: 'Указанный шаблон номенклатуры не найден.' };
      const templateItemType = String(template.attrs.item_type_code ?? '').trim().toLowerCase();
      const templateDirectoryKind = String(template.attrs.directory_kind ?? '').trim().toLowerCase();
      if (templateItemType && templateItemType !== nextItemType) {
        return { ok: false, error: 'Шаблон не соответствует выбранному типу номенклатуры.' };
      }
      if (templateDirectoryKind && sourceKind && templateDirectoryKind !== sourceKind) {
        return { ok: false, error: 'Шаблон не соответствует выбранному источнику номенклатуры.' };
      }
      const propertiesJson = String(template.attrs.properties_json ?? '').trim();
      if (propertiesJson) {
        try {
          const propertyDefs = JSON.parse(propertiesJson) as Array<{ propertyId?: string; required?: boolean }>;
          for (const propDef of propertyDefs) {
            const propertyId = String(propDef?.propertyId ?? '').trim();
            if (!propertyId || propDef?.required !== true) continue;
            const value = governanceSpec.propertyValues[propertyId];
            const isEmpty =
              value == null || (typeof value === 'string' && value.trim().length === 0) || (Array.isArray(value) && value.length === 0);
            if (isEmpty) return { ok: false, error: `Не заполнено обязательное свойство шаблона: ${propertyId}` };
          }
        } catch {
          return { ok: false, error: 'Некорректный состав свойств в шаблоне.' };
        }
      }
    }

    const ts = nowMs();
    const normalized = {
      code: String(args.code).trim(),
      sku: args.sku == null ? null : String(args.sku).trim() || null,
      name: resolvedSourceName ?? String(args.name).trim(),
      itemType: nextItemType,
      category: args.category == null ? normalizeItemTypeToCategory(nextItemType) : String(args.category),
      directoryKind: args.directoryKind == null ? null : String(args.directoryKind).trim() || null,
      directoryRefId: args.directoryRefId == null ? null : String(args.directoryRefId).trim() || null,
      groupId: args.groupId ?? null,
      unitId: args.unitId ?? null,
      barcode: args.barcode ?? null,
      minStock: args.minStock == null ? null : Math.trunc(Number(args.minStock)),
      maxStock: args.maxStock == null ? null : Math.trunc(Number(args.maxStock)),
      defaultBrandId: args.defaultBrandId ?? null,
      isSerialTracked: args.isSerialTracked ?? nextItemType === 'engine',
      defaultWarehouseId: args.defaultWarehouseId ?? null,
      specJson: args.specJson ?? null,
      isActive: args.isActive ?? true,
    };
    await db
      .insert(erpNomenclature)
      .values({ id, ...normalized, createdAt: ts, updatedAt: ts, deletedAt: null })
      .onConflictDoUpdate({ target: erpNomenclature.id, set: { ...normalized, updatedAt: ts, deletedAt: null } });
    const saved = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, id)).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'upsert',
          table: LedgerTableName.ErpNomenclature,
          row_id: id,
          row: {
            id: String(row.id),
            code: String(row.code),
            sku: row.sku ?? null,
            name: String(row.name),
            item_type: String(row.itemType),
            category: row.category ?? null,
            directory_kind: row.directoryKind ?? null,
            directory_ref_id: row.directoryRefId ?? null,
            group_id: row.groupId,
            unit_id: row.unitId,
            barcode: row.barcode,
            min_stock: row.minStock,
            max_stock: row.maxStock,
            default_brand_id: row.defaultBrandId ?? null,
            is_serial_tracked: Boolean(row.isSerialTracked),
            default_warehouse_id: row.defaultWarehouseId,
            spec_json: row.specJson,
            is_active: Boolean(row.isActive),
            created_at: Number(row.createdAt),
            updated_at: Number(row.updatedAt),
            deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
          },
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts,
        },
      ]);
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteWarehouseNomenclature(args: {
  id: string;
  /** Внутренний вызов при удалении детали — снять только зеркало в erp_nomenclature */
  allowLinkedPartMirror?: boolean;
}): Promise<Result<{ id: string }>> {
  try {
    if (!args.allowLinkedPartMirror && isLegacyPartMirrorMode()) {
      const prevRows = await db.select({ specJson: erpNomenclature.specJson }).from(erpNomenclature).where(eq(erpNomenclature.id, args.id)).limit(1);
      if (prevRows[0] && nomenclatureRowIsLinkedPart(prevRows[0].specJson)) {
        return {
          ok: false,
          error: 'Нельзя удалить зеркальную позицию детали из склада. Удалите деталь в разделе Производство или скройте деталь там.',
        };
      }
    }
    const ts = nowMs();
    await db.update(erpNomenclature).set({ isActive: false, deletedAt: ts, updatedAt: ts }).where(eq(erpNomenclature.id, args.id));
    const saved = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, args.id)).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'delete',
          table: LedgerTableName.ErpNomenclature,
          row_id: String(row.id),
          row: {
            id: String(row.id),
            code: String(row.code),
            sku: row.sku ?? null,
            name: String(row.name),
            item_type: String(row.itemType),
            category: row.category ?? null,
            directory_kind: row.directoryKind ?? null,
            directory_ref_id: row.directoryRefId ?? null,
            group_id: row.groupId,
            unit_id: row.unitId,
            barcode: row.barcode,
            min_stock: row.minStock,
            max_stock: row.maxStock,
            default_brand_id: row.defaultBrandId ?? null,
            is_serial_tracked: Boolean(row.isSerialTracked),
            default_warehouse_id: row.defaultWarehouseId,
            spec_json: row.specJson,
            is_active: false,
            created_at: Number(row.createdAt),
            updated_at: ts,
            deleted_at: ts,
          },
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts,
        },
      ]);
    }
    return { ok: true, id: args.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseNomenclatureEngineBrands(args: {
  nomenclatureId: string;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const rows = await db
      .select()
      .from(erpNomenclatureEngineBrand)
      .where(and(eq(erpNomenclatureEngineBrand.nomenclatureId, String(args.nomenclatureId)), isNull(erpNomenclatureEngineBrand.deletedAt)))
      .orderBy(desc(erpNomenclatureEngineBrand.isDefault), asc(erpNomenclatureEngineBrand.createdAt));
    return {
      ok: true,
      rows: rows.map((row) => ({
        ...row,
        engineBrandName: readLookupLabel(refs.engineBrandById, String(row.engineBrandId)),
      })) as Array<Record<string, unknown>>,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseNomenclatureEngineBrand(args: {
  id?: string;
  nomenclatureId: string;
  engineBrandId: string;
  isDefault?: boolean;
}): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id || randomUUID());
    const ts = nowMs();
    await db
      .insert(erpNomenclatureEngineBrand)
      .values({
        id,
        nomenclatureId: String(args.nomenclatureId),
        engineBrandId: String(args.engineBrandId),
        isDefault: Boolean(args.isDefault),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
        lastServerSeq: null,
      })
      .onConflictDoUpdate({
        target: erpNomenclatureEngineBrand.id,
        set: {
          nomenclatureId: String(args.nomenclatureId),
          engineBrandId: String(args.engineBrandId),
          isDefault: Boolean(args.isDefault),
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'synced',
        },
      });
    const saved = await db.select().from(erpNomenclatureEngineBrand).where(eq(erpNomenclatureEngineBrand.id, id)).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'upsert',
          table: LedgerTableName.ErpNomenclatureEngineBrand,
          row_id: id,
          row: {
            id: String(row.id),
            nomenclature_id: String(row.nomenclatureId),
            engine_brand_id: String(row.engineBrandId),
            is_default: Boolean(row.isDefault),
            created_at: Number(row.createdAt),
            updated_at: Number(row.updatedAt),
            deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
            sync_status: String(row.syncStatus ?? 'synced'),
            last_server_seq: row.lastServerSeq == null ? null : Number(row.lastServerSeq),
          },
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts,
        },
      ]);
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteWarehouseNomenclatureEngineBrand(args: { id: string }): Promise<Result<{ id: string }>> {
  try {
    const ts = nowMs();
    await db
      .update(erpNomenclatureEngineBrand)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(erpNomenclatureEngineBrand.id, String(args.id)));
    const saved = await db.select().from(erpNomenclatureEngineBrand).where(eq(erpNomenclatureEngineBrand.id, String(args.id))).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'delete',
          table: LedgerTableName.ErpNomenclatureEngineBrand,
          row_id: String(row.id),
          row: {
            id: String(row.id),
            nomenclature_id: String(row.nomenclatureId),
            engine_brand_id: String(row.engineBrandId),
            is_default: Boolean(row.isDefault),
            created_at: Number(row.createdAt),
            updated_at: ts,
            deleted_at: ts,
            sync_status: String(row.syncStatus ?? 'synced'),
            last_server_seq: row.lastServerSeq == null ? null : Number(row.lastServerSeq),
          },
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts,
        },
      ]);
    }
    return { ok: true, id: String(args.id) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseEngineInstances(args?: {
  nomenclatureId?: string;
  contractId?: string;
  warehouseId?: string;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<Result<{ rows: Array<Record<string, unknown>>; hasMore?: boolean }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const rows = await db
      .select()
      .from(erpEngineInstances)
      .where(isNull(erpEngineInstances.deletedAt))
      .orderBy(desc(erpEngineInstances.createdAt));
    const filtered = rows.filter((row) => {
      if (args?.nomenclatureId && String(row.nomenclatureId) !== String(args.nomenclatureId)) return false;
      if (args?.contractId && String(row.contractId ?? '') !== String(args.contractId)) return false;
      if (args?.warehouseId && String(row.warehouseId) !== String(args.warehouseId)) return false;
      if (args?.status && String(row.currentStatus) !== String(args.status)) return false;
      if (args?.search) {
        const q = String(args.search).trim().toLowerCase();
        if (q) {
          const hay = `${String(row.serialNumber ?? '')} ${String(row.contractId ?? '')} ${String(row.warehouseId ?? '')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
      }
      return true;
    });
    const nomenclatureIds = Array.from(new Set(filtered.map((r) => String(r.nomenclatureId)).filter(Boolean)));
    const contractIds = Array.from(new Set(filtered.map((r) => String(r.contractId ?? '')).filter(Boolean)));
    const nomenclatureRows =
      nomenclatureIds.length > 0
        ? await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds as any), isNull(erpNomenclature.deletedAt)))
        : [];
    const contractRows =
      contractIds.length > 0
        ? await db.select().from(erpContracts).where(and(inArray(erpContracts.id, contractIds as any), isNull(erpContracts.deletedAt)))
        : [];
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    const contractsById = new Map(contractRows.map((row) => [String(row.id), row]));
    const mapped = filtered.map((row) => {
      const n = nomenclatureById.get(String(row.nomenclatureId));
      const c = row.contractId ? contractsById.get(String(row.contractId)) : null;
      return {
        ...row,
        nomenclatureCode: n?.code ?? null,
        nomenclatureName: n?.name ?? null,
        warehouseName: readLookupLabel(refs.warehouseById, String(row.warehouseId)),
        contractCode: c?.code ?? null,
        contractName: c?.name ?? null,
      };
    });
    if (args?.limit === undefined) return { ok: true, rows: mapped, hasMore: false };
    const limit = Math.min(Math.max(Math.trunc(Number(args.limit)), 1), 10_000);
    const offset = Math.max(Math.trunc(Number(args.offset ?? 0)), 0);
    const page = mapped.slice(offset, offset + limit + 1);
    const hasMore = page.length > limit;
    return { ok: true, rows: hasMore ? page.slice(0, limit) : page, hasMore };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseEngineInstance(args: {
  id?: string;
  nomenclatureId: string;
  serialNumber: string;
  contractId?: string | null;
  warehouseId?: string;
  currentStatus?: string;
}): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id || randomUUID());
    const ts = nowMs();
    await db
      .insert(erpEngineInstances)
      .values({
        id,
        nomenclatureId: String(args.nomenclatureId),
        serialNumber: String(args.serialNumber).trim(),
        contractId: args.contractId ?? null,
        warehouseId: String(args.warehouseId || 'default'),
        currentStatus: String(args.currentStatus || 'in_stock'),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
        lastServerSeq: null,
      })
      .onConflictDoUpdate({
        target: erpEngineInstances.id,
        set: {
          nomenclatureId: String(args.nomenclatureId),
          serialNumber: String(args.serialNumber).trim(),
          contractId: args.contractId ?? null,
          warehouseId: String(args.warehouseId || 'default'),
          currentStatus: String(args.currentStatus || 'in_stock'),
          updatedAt: ts,
          deletedAt: null,
          syncStatus: 'synced',
        },
      });
    const saved = await db.select().from(erpEngineInstances).where(eq(erpEngineInstances.id, id)).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'upsert',
          table: LedgerTableName.ErpEngineInstances,
          row_id: String(row.id),
          row: {
            id: String(row.id),
            nomenclature_id: String(row.nomenclatureId),
            serial_number: String(row.serialNumber),
            contract_id: row.contractId,
            current_status: String(row.currentStatus),
            warehouse_id: String(row.warehouseId),
            created_at: Number(row.createdAt),
            updated_at: Number(row.updatedAt),
            deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
            sync_status: String(row.syncStatus ?? 'synced'),
            last_server_seq: row.lastServerSeq == null ? null : Number(row.lastServerSeq),
          },
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts,
        },
      ]);
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteWarehouseEngineInstance(args: { id: string }): Promise<Result<{ id: string }>> {
  try {
    const ts = nowMs();
    await db
      .update(erpEngineInstances)
      .set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(erpEngineInstances.id, String(args.id)));
    const saved = await db.select().from(erpEngineInstances).where(eq(erpEngineInstances.id, String(args.id))).limit(1);
    const row = saved[0];
    if (row) {
      signAndAppendDetailed([
        {
          type: 'delete',
          table: LedgerTableName.ErpEngineInstances,
          row_id: String(row.id),
          row: {
            id: String(row.id),
            nomenclature_id: String(row.nomenclatureId),
            serial_number: String(row.serialNumber),
            contract_id: row.contractId,
            current_status: String(row.currentStatus),
            warehouse_id: String(row.warehouseId),
            created_at: Number(row.createdAt),
            updated_at: ts,
            deleted_at: ts,
            sync_status: String(row.syncStatus ?? 'synced'),
            last_server_seq: row.lastServerSeq == null ? null : Number(row.lastServerSeq),
          },
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts,
        },
      ]);
    }
    return { ok: true, id: String(args.id) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseStock(args?: {
  warehouseId?: string;
  nomenclatureId?: string;
  search?: string;
  lowStockOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<Result<{ rows: Array<Record<string, unknown>>; hasMore?: boolean }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const rows = await db.select().from(erpRegStockBalance).orderBy(asc(erpRegStockBalance.warehouseId));
    const nomenclatureIds = Array.from(new Set(rows.map((row) => row.nomenclatureId).filter((v): v is string => typeof v === 'string' && v.length > 0)));
    const nomenclatureRows =
      nomenclatureIds.length === 0
        ? []
        : await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds), isNull(erpNomenclature.deletedAt)));
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    const search = String(args?.search ?? '').trim().toLowerCase();
    const filtered = rows
      .filter((row) => {
        if (args?.warehouseId && String(row.warehouseId) !== String(args.warehouseId)) return false;
        if (args?.nomenclatureId && String(row.nomenclatureId ?? '') !== String(args.nomenclatureId)) return false;
        const n = row.nomenclatureId ? nomenclatureById.get(String(row.nomenclatureId)) : undefined;
        if (search) {
          const hay = `${String(n?.code ?? '')} ${String(n?.name ?? '')} ${String(row.warehouseId)}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        if (args?.lowStockOnly) {
          const min = Number(n?.minStock ?? NaN);
          if (!Number.isFinite(min)) return false;
          if (Number(row.qty) > min) return false;
        }
        return true;
      })
      .map((row) => {
        const n = row.nomenclatureId ? nomenclatureById.get(String(row.nomenclatureId)) : undefined;
        const reservedQty = Number(row.reservedQty ?? 0);
        const qty = Number(row.qty ?? 0);
        return {
          ...row,
          warehouseName: readLookupLabel(refs.warehouseById, String(row.warehouseId)),
          nomenclatureCode: n?.code ?? null,
          sku: n?.sku ?? null,
          nomenclatureName: n?.name ?? null,
          itemType: n?.itemType ?? null,
          category: n?.category ?? normalizeItemTypeToCategory(String(n?.itemType ?? 'component')),
          isSerialTracked: Boolean(n?.isSerialTracked ?? String(n?.itemType ?? '').toLowerCase() === 'engine'),
          minStock: n?.minStock ?? null,
          maxStock: n?.maxStock ?? null,
          groupId: n?.groupId ?? null,
          groupName: readLookupLabel(refs.groupById, n?.groupId == null ? null : String(n.groupId)),
          unitId: n?.unitId ?? null,
          unitName: readLookupLabel(refs.unitById, n?.unitId == null ? null : String(n.unitId)),
          defaultWarehouseId: n?.defaultWarehouseId ?? null,
          defaultWarehouseName: readLookupLabel(refs.warehouseById, n?.defaultWarehouseId == null ? null : String(n.defaultWarehouseId)),
          reservedQty,
          availableQty: qty - reservedQty,
        };
      });
    const sorted = [...filtered].sort((a, b) => {
      const wa = String((a as { warehouseId?: unknown }).warehouseId ?? '');
      const wb = String((b as { warehouseId?: unknown }).warehouseId ?? '');
      const wc = wa.localeCompare(wb, 'ru');
      if (wc !== 0) return wc;
      const na = String((a as { nomenclatureName?: unknown }).nomenclatureName ?? '');
      const nb = String((b as { nomenclatureName?: unknown }).nomenclatureName ?? '');
      const nc = na.localeCompare(nb, 'ru');
      if (nc !== 0) return nc;
      return String((a as { nomenclatureCode?: unknown }).nomenclatureCode ?? '').localeCompare(
        String((b as { nomenclatureCode?: unknown }).nomenclatureCode ?? ''),
        'ru',
      );
    });
    if (args?.limit === undefined) {
      return { ok: true, rows: sorted as Array<Record<string, unknown>>, hasMore: false };
    }
    const limit = Math.min(Math.max(Math.trunc(Number(args.limit)), 1), 10_000);
    const offset = Math.max(Math.trunc(Number(args.offset ?? 0)), 0);
    const pageSlice = sorted.slice(offset, offset + limit + 1);
    const hasMore = pageSlice.length > limit;
    const rowsOut = hasMore ? pageSlice.slice(0, limit) : pageSlice;
    return { ok: true, rows: rowsOut as Array<Record<string, unknown>>, hasMore };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

const WAREHOUSE_DOC_LIST_STATUSES = new Set(['draft', 'planned', 'posted', 'cancelled']);

export async function listWarehouseDocuments(args?: {
  docType?: string;
  status?: string;
  /** Исключить документы в статусе cancelled (для списка «без мусора»). */
  excludeCancelled?: boolean;
  /** Показывать только документы с этими статусами (если задано — имеет приоритет над status/excludeCancelled). */
  statusIn?: string[];
  fromDate?: number;
  toDate?: number;
  search?: string;
  warehouseId?: string;
  limit?: number;
  offset?: number;
}): Promise<Result<{ rows: Array<Record<string, unknown>>; hasMore?: boolean }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const rows = await db
      .select()
      .from(erpDocumentHeaders)
      .where(isNull(erpDocumentHeaders.deletedAt))
      .orderBy(desc(erpDocumentHeaders.docDate), desc(erpDocumentHeaders.createdAt));
    const headerIds = rows.filter((row) => isStockDocType(String(row.docType))).map((row) => String(row.id));
    const lineRows =
      headerIds.length > 0
        ? await db
            .select(documentLineSelectFields())
            .from(erpDocumentLines)
            .where(and(inArray(erpDocumentLines.headerId, headerIds as any), isNull(erpDocumentLines.deletedAt)))
            .orderBy(asc(erpDocumentLines.lineNo))
        : [];
    const linesByHeaderId = new Map<string, typeof lineRows>();
    for (const line of lineRows) {
      const key = String(line.headerId);
      const list = linesByHeaderId.get(key) ?? [];
      list.push(line);
      linesByHeaderId.set(key, list);
    }
    const search = String(args?.search ?? '').trim().toLowerCase();
    const statusInSanitized =
      args?.statusIn !== undefined
        ? [...new Set(args.statusIn.map(String).map((s) => s.trim()).filter((s) => WAREHOUSE_DOC_LIST_STATUSES.has(s)))]
        : null;
    const filtered = rows.filter((row) => {
      if (!isStockDocType(String(row.docType))) return false;
      if (args?.docType && String(row.docType) !== String(args.docType)) return false;
      if (statusInSanitized !== null) {
        if (statusInSanitized.length === 0) return false;
        if (!statusInSanitized.includes(String(row.status))) return false;
      } else {
        if (args?.excludeCancelled && String(row.status) === 'cancelled') return false;
        if (args?.status && String(row.status) !== String(args.status)) return false;
      }
      if (args?.fromDate !== undefined && Number(row.docDate) < Number(args.fromDate)) return false;
      if (args?.toDate !== undefined && Number(row.docDate) > Number(args.toDate)) return false;
      const headerPayload = parseWarehouseHeaderPayload(row.payloadJson);
      if (args?.warehouseId && String(headerPayload.warehouseId ?? '') !== String(args.warehouseId)) return false;
      if (search) {
        const hay = [
          String(row.docNo ?? ''),
          String(row.docType ?? ''),
          String(headerPayload.reason ?? ''),
          String(headerPayload.warehouseId ?? ''),
          String(readLookupLabel(refs.warehouseById, headerPayload.warehouseId) ?? ''),
          String(readLookupLabel(refs.counterpartyById, headerPayload.counterpartyId) ?? ''),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    const mapped = filtered.map((row) => {
      const headerPayload = parseWarehouseHeaderPayload(row.payloadJson);
      const docLines = linesByHeaderId.get(String(row.id)) ?? [];
      const reasonLabel = readLookupLabel(refs.writeoffReasonById, headerPayload.reason) ?? headerPayload.reason;
      return {
        ...row,
        warehouseId: headerPayload.warehouseId,
        expectedDate: headerPayload.expectedDate,
        sourceType: headerPayload.sourceType,
        sourceRef: headerPayload.sourceRef,
        contractId: headerPayload.contractId,
        warehouseName: readLookupLabel(refs.warehouseById, headerPayload.warehouseId),
        reason: headerPayload.reason,
        reasonLabel,
        counterpartyId: headerPayload.counterpartyId,
        counterpartyName: readLookupLabel(refs.counterpartyById, headerPayload.counterpartyId),
        authorName: readLookupLabel(refs.employeeById, row.authorId == null ? null : String(row.authorId)),
        linesCount: docLines.length,
        totalQty: docLines.reduce((sum, line) => sum + Number(line.qty ?? 0), 0),
      };
    }) as Array<Record<string, unknown>>;
    mapped.sort((a, b) => {
      const da = Number((a as { docDate?: unknown }).docDate ?? 0);
      const db = Number((b as { docDate?: unknown }).docDate ?? 0);
      if (db !== da) return db - da;
      const ca = Number((a as { createdAt?: unknown }).createdAt ?? 0);
      const cb = Number((b as { createdAt?: unknown }).createdAt ?? 0);
      return cb - ca;
    });
    if (args?.limit === undefined) {
      return { ok: true, rows: mapped, hasMore: false };
    }
    const limit = Math.min(Math.max(Math.trunc(Number(args.limit)), 1), 10_000);
    const offset = Math.max(Math.trunc(Number(args.offset ?? 0)), 0);
    const pageSlice = mapped.slice(offset, offset + limit + 1);
    const hasMore = pageSlice.length > limit;
    const rowsOut = hasMore ? pageSlice.slice(0, limit) : pageSlice;
    return { ok: true, rows: rowsOut, hasMore };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseForecastIncoming(args: {
  from: number;
  to: number;
  warehouseId?: string;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const from = Math.trunc(Number(args.from));
    const to = Math.trunc(Number(args.to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return { ok: false, error: 'Некорректный период from/to' };
    const rows = await db
      .select()
      .from(erpPlannedIncoming)
      .where(and(isNull(erpPlannedIncoming.deletedAt), sql`${erpPlannedIncoming.expectedDate} >= ${from}`, sql`${erpPlannedIncoming.expectedDate} <= ${to}`))
      .orderBy(asc(erpPlannedIncoming.expectedDate), asc(erpPlannedIncoming.warehouseId));
    const filtered = rows.filter((row) => (args.warehouseId ? String(row.warehouseId) === String(args.warehouseId) : true));
    const nomenclatureIds = Array.from(new Set(filtered.map((row) => String(row.nomenclatureId)).filter(Boolean)));
    const nomenclatureRows =
      nomenclatureIds.length > 0
        ? await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds as any), isNull(erpNomenclature.deletedAt)))
        : [];
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    const grouped = new Map<string, Record<string, unknown>>();
    for (const row of filtered) {
      const key = `${row.expectedDate}::${row.warehouseId}::${row.nomenclatureId}::${row.sourceType}::${row.unit ?? ''}`;
      const existing = grouped.get(key);
      const nomenclature = nomenclatureById.get(String(row.nomenclatureId));
      if (!existing) {
        grouped.set(key, {
          expectedDate: Number(row.expectedDate),
          warehouseId: String(row.warehouseId),
          nomenclatureId: String(row.nomenclatureId),
          nomenclatureCode: nomenclature?.code ?? null,
          nomenclatureName: nomenclature?.name ?? null,
          unit: row.unit ?? null,
          sourceType: String(row.sourceType),
          qty: Number(row.qty ?? 0),
        });
      } else {
        existing.qty = Number(existing.qty ?? 0) + Number(row.qty ?? 0);
      }
    }
    return {
      ok: true,
      rows: Array.from(grouped.values()).sort((a, b) => {
        const da = Number((a as { expectedDate?: unknown }).expectedDate ?? 0);
        const dbv = Number((b as { expectedDate?: unknown }).expectedDate ?? 0);
        if (da !== dbv) return da - dbv;
        const wa = String((a as { warehouseId?: unknown }).warehouseId ?? '');
        const wb = String((b as { warehouseId?: unknown }).warehouseId ?? '');
        return wa.localeCompare(wb, 'ru');
      }),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getWarehouseDocument(args: {
  id: string;
}): Promise<Result<{ document: { header: Record<string, unknown>; lines: Array<Record<string, unknown>> } }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const headerRows = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.id), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headerRows[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (!isStockDocType(String(header.docType))) return { ok: false, error: 'Документ не складского типа' };
    const lines = await db
      .select(documentLineSelectFields())
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.id), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));
    const headerPayload = parseWarehouseHeaderPayload(header.payloadJson);
    const nomenclatureIds = Array.from(
      new Set(
        lines
          .map((line) => parseWarehouseLinePayload(line.payloadJson).nomenclatureId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    );
    const nomenclatureRows =
      nomenclatureIds.length > 0
        ? await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds as any), isNull(erpNomenclature.deletedAt)))
        : [];
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    return {
      ok: true,
      document: {
        header: {
          ...header,
          warehouseId: headerPayload.warehouseId,
          expectedDate: headerPayload.expectedDate,
          sourceType: headerPayload.sourceType,
          sourceRef: headerPayload.sourceRef,
          contractId: headerPayload.contractId,
          warehouseName: readLookupLabel(refs.warehouseById, headerPayload.warehouseId),
          reason: headerPayload.reason,
          reasonLabel: readLookupLabel(refs.writeoffReasonById, headerPayload.reason) ?? headerPayload.reason,
          counterpartyId: headerPayload.counterpartyId,
          counterpartyName: readLookupLabel(refs.counterpartyById, headerPayload.counterpartyId),
          authorName: readLookupLabel(refs.employeeById, header.authorId == null ? null : String(header.authorId)),
          linesCount: lines.length,
          totalQty: lines.reduce((sum, line) => sum + Number(line.qty ?? 0), 0),
        },
        lines: lines.map((line) => {
          const payload = parseWarehouseLinePayload(line.payloadJson);
          const nomenclature = payload.nomenclatureId ? nomenclatureById.get(payload.nomenclatureId) : null;
          return {
            ...line,
            nomenclatureId: payload.nomenclatureId,
            nomenclatureCode: nomenclature?.code ?? null,
            nomenclatureName: nomenclature?.name ?? null,
            unit: payload.unit,
            batch: payload.batch,
            note: payload.note,
            cost: payload.cost,
            warehouseId: payload.warehouseId,
            warehouseName: readLookupLabel(refs.warehouseById, payload.warehouseId),
            fromWarehouseId: payload.fromWarehouseId,
            fromWarehouseName: readLookupLabel(refs.warehouseById, payload.fromWarehouseId),
            toWarehouseId: payload.toWarehouseId,
            toWarehouseName: readLookupLabel(refs.warehouseById, payload.toWarehouseId),
            adjustmentQty: payload.adjustmentQty,
            bookQty: payload.bookQty,
            actualQty: payload.actualQty,
            reason: payload.reason,
            reasonLabel: readLookupLabel(refs.writeoffReasonById, payload.reason) ?? payload.reason,
          };
        }),
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createWarehouseDocument(args: {
  id?: string;
  docType: string;
  status?: string;
  docNo: string;
  docDate?: number;
  departmentId?: string | null;
  authorId?: string | null;
  header?: HeaderPayloadInput | null;
  payloadJson?: string | null;
  lines: DocLineInput[];
  expectedUpdatedAt?: number;
  actor: Actor;
}): Promise<Result<{ id: string }>> {
  try {
    if (!isStockDocType(String(args.docType))) return { ok: false, error: 'Неподдерживаемый тип складского документа' };
    const requestedStatus = String(args.status ?? 'draft');
    if (requestedStatus !== 'draft' && requestedStatus !== 'planned') {
      return { ok: false, error: 'Разрешены только статусы draft/planned при сохранении документа' };
    }
    if (requestedStatus === 'planned' && !isIncomingDocType(String(args.docType))) {
      return { ok: false, error: 'Статус planned доступен только для документов прихода' };
    }
    const ts = nowMs();
    const id = String(args.id || randomUUID());
    const docDate = Math.trunc(Number(args.docDate ?? ts));
    const targetSourceType = isIncomingDocType(String(args.docType))
      ? args.header?.sourceType ?? resolveIncomingSourceType(String(args.docType))
      : undefined;
    if (String(args.docType) === 'inventory_opening') {
      const hasCounterparty = Boolean(String(args.header?.counterpartyId ?? '').trim());
      const hasContract = Boolean(String(args.header?.contractId ?? '').trim());
      if (hasCounterparty || hasContract) {
        return { ok: false, error: 'Для inventory_opening не требуется привязка к поставщику/контракту' };
      }
    }
    const mergedHeaderPayloadJson = mergeHeaderPayloadJson(args.payloadJson, {
      ...(args.header ?? {}),
      ...(targetSourceType ? { sourceType: targetSourceType } : {}),
    });
    if (args.id) {
      const existing = await db
        .select({ id: erpDocumentHeaders.id, status: erpDocumentHeaders.status, updatedAt: erpDocumentHeaders.updatedAt })
        .from(erpDocumentHeaders)
        .where(and(eq(erpDocumentHeaders.id, id), isNull(erpDocumentHeaders.deletedAt)))
        .limit(1);
      if (!existing[0]) return { ok: false, error: 'Документ для обновления не найден' };
      if (args.expectedUpdatedAt != null && Number(existing[0].updatedAt) !== Math.trunc(Number(args.expectedUpdatedAt))) {
        return { ok: false, error: 'Конфликт обновления: документ был изменен другим пользователем. Обновите карточку и повторите.' };
      }
      if (String(existing[0].status) !== 'draft') return { ok: false, error: 'Можно редактировать только документ в статусе черновика' };
      await db
        .update(erpDocumentHeaders)
        .set({
          docType: String(args.docType),
          docNo: String(args.docNo),
          docDate,
          status: requestedStatus,
          authorId: args.authorId ?? null,
          departmentId: args.departmentId ?? null,
          payloadJson: mergedHeaderPayloadJson,
          updatedAt: ts,
        })
        .where(eq(erpDocumentHeaders.id, id));
      // Полное удаление строк: уникальный индекс (header_id, line_no) не учитывает deleted_at,
      // поэтому «мягкое» удаление не позволяет вставить новые строки с теми же line_no.
      await db.delete(erpDocumentLines).where(eq(erpDocumentLines.headerId, id));
    } else {
      await db.insert(erpDocumentHeaders).values({
        id,
        docType: String(args.docType),
        docNo: String(args.docNo),
        docDate,
        status: requestedStatus,
        authorId: args.authorId ?? null,
        departmentId: args.departmentId ?? null,
        payloadJson: mergedHeaderPayloadJson,
        createdAt: ts,
        updatedAt: ts,
        postedAt: null,
        deletedAt: null,
      });
    }
    const lines = args.lines.map((line, idx) => {
      return {
        id: randomUUID(),
        headerId: id,
        lineNo: idx + 1,
        partCardId: line.partCardId ?? null,
        qty: Math.max(0, Math.trunc(Number(line.qty))),
        price: line.price == null && line.cost != null ? Math.trunc(Number(line.cost)) : line.price == null ? null : Math.trunc(Number(line.price)),
        payloadJson: mergeLinePayloadJson(line.payloadJson, line),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
      };
    });
    if (lines.length > 0) await db.insert(erpDocumentLines).values(lines);
    if (requestedStatus === 'planned' && isIncomingDocType(String(args.docType))) {
      const headerPayload = parseWarehouseHeaderPayload(mergedHeaderPayloadJson);
      const plannedRows = buildPlannedIncomingRows({ documentId: id, docType: String(args.docType), headerPayload, lines });
      if (plannedRows.length === 0) return { ok: false, error: 'Для planned-документа прихода нужны строки с количеством и номенклатурой' };
      await replacePlannedIncomingRows(id, plannedRows, ts);
    } else {
      await clearPlannedIncomingRows(id, ts);
    }
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: id,
      eventType: args.id ? 'updated' : 'created',
      eventPayloadJson: JSON.stringify({ docType: args.docType, by: args.actor.username, lines: lines.length }),
      eventAt: ts,
    });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function cancelWarehouseDocument(args: {
  documentId: string;
  actor: Actor;
  expectedUpdatedAt?: number;
}): Promise<Result<{ id: string; status: 'cancelled' }>> {
  try {
    const ts = nowMs();
    const headerRows = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headerRows[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (args.expectedUpdatedAt != null && Number(header.updatedAt) !== Math.trunc(Number(args.expectedUpdatedAt))) {
      return { ok: false, error: 'Конфликт обновления: документ был изменен другим пользователем. Обновите карточку и повторите.' };
    }
    if (!isStockDocType(String(header.docType))) return { ok: false, error: 'Документ не складского типа' };
    if (String(header.status) === 'posted') return { ok: false, error: 'Проведенный документ нельзя отменить без сторнирующей операции' };
    if (String(header.status) === 'cancelled') return { ok: true, id: args.documentId, status: 'cancelled' };

    await db.update(erpDocumentHeaders).set({ status: 'cancelled', updatedAt: ts }).where(eq(erpDocumentHeaders.id, args.documentId));
    await clearPlannedIncomingRows(args.documentId, ts);
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: args.documentId,
      eventType: 'cancelled',
      eventPayloadJson: JSON.stringify({ by: args.actor.username }),
      eventAt: ts,
    });

    return { ok: true, id: args.documentId, status: 'cancelled' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function planWarehouseDocument(args: {
  documentId: string;
  actor: Actor;
  expectedUpdatedAt?: number;
}): Promise<Result<{ id: string; planned: boolean }>> {
  try {
    const ts = nowMs();
    const headers = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headers[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (args.expectedUpdatedAt != null && Number(header.updatedAt) !== Math.trunc(Number(args.expectedUpdatedAt))) {
      return { ok: false, error: 'Конфликт обновления: документ был изменен другим пользователем. Обновите карточку и повторите.' };
    }
    if (!isStockDocType(String(header.docType))) return { ok: false, error: 'Документ не складского типа' };
    if (!isIncomingDocType(String(header.docType))) return { ok: false, error: 'Планирование доступно только для документов прихода' };
    if (String(header.status) === 'posted') return { ok: false, error: 'Проведенный документ нельзя перевести в planned' };
    if (String(header.status) === 'cancelled') return { ok: false, error: 'Отмененный документ нельзя запланировать' };
    if (String(header.status) !== 'draft' && String(header.status) !== 'planned') {
      return { ok: false, error: 'Документ должен быть в статусе draft или planned' };
    }

    const lines = await db
      .select(documentLineSelectFields())
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.documentId), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));
    const headerPayload = parseWarehouseHeaderPayload(header.payloadJson);
    const plannedRows = buildPlannedIncomingRows({
      documentId: args.documentId,
      docType: String(header.docType),
      headerPayload: {
        ...headerPayload,
        sourceType: headerPayload.sourceType ?? resolveIncomingSourceType(String(header.docType)),
      },
      lines,
    });
    if (plannedRows.length === 0) return { ok: false, error: 'Для planned-документа прихода нужны строки с количеством и номенклатурой' };
    await replacePlannedIncomingRows(args.documentId, plannedRows, ts);
    await db.update(erpDocumentHeaders).set({ status: 'planned', updatedAt: ts }).where(eq(erpDocumentHeaders.id, args.documentId));
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: args.documentId,
      eventType: 'planned',
      eventPayloadJson: JSON.stringify({ by: args.actor.username }),
      eventAt: ts,
    });
    return { ok: true, id: args.documentId, planned: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function postWarehouseDocument(args: {
  documentId: string;
  actor: Actor;
  expectedUpdatedAt?: number;
}): Promise<Result<{ id: string; posted: boolean }>> {
  try {
    const ts = nowMs();
    const headers = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headers[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (args.expectedUpdatedAt != null && Number(header.updatedAt) !== Math.trunc(Number(args.expectedUpdatedAt))) {
      return { ok: false, error: 'Конфликт обновления: документ был изменен другим пользователем. Обновите карточку и повторите.' };
    }
    if (!isStockDocType(String(header.docType))) return { ok: false, error: 'Документ не складского типа' };
    if (String(header.status) === 'posted') return { ok: true, id: args.documentId, posted: true };
    if (isIncomingDocType(String(header.docType)) && String(header.status) !== 'planned') {
      return { ok: false, error: 'Документ прихода можно провести только из статуса planned' };
    }

    const headerPayload = parseJsonObject(header.payloadJson ?? null);
    const lines = await db
      .select(documentLineSelectFields())
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.documentId), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));
    const planned: PlannedMovement[] = [];

    for (const line of lines) {
      const qty = Math.max(0, Math.trunc(Number(line.qty ?? 0)));
      const payload = parseJsonObject(line.payloadJson ?? null);
      const nomenclatureId = strField(payload, 'nomenclatureId');
      if (!nomenclatureId) return { ok: false, error: `В строке ${line.lineNo} не задана номенклатура` };
      const reason = strField(payload, 'reason') ?? strField(headerPayload, 'reason') ?? null;
      const counterpartyId = strField(headerPayload, 'counterpartyId') ?? null;

      if (String(header.docType) === 'stock_receipt' || isIncomingDocType(String(header.docType))) {
        if (qty <= 0) continue;
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'receipt', direction: 'in', qty, delta: qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_issue') {
        if (qty <= 0) continue;
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'issue', direction: 'out', qty, delta: -qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_writeoff') {
        if (qty <= 0) continue;
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'writeoff', direction: 'out', qty, delta: -qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_transfer') {
        if (qty <= 0) continue;
        const fromWarehouseId = strField(payload, 'fromWarehouseId') ?? strField(headerPayload, 'fromWarehouseId');
        const toWarehouseId = strField(payload, 'toWarehouseId') ?? strField(headerPayload, 'toWarehouseId');
        if (!fromWarehouseId || !toWarehouseId) return { ok: false, error: `В строке ${line.lineNo} не заполнены склады перемещения` };
        if (fromWarehouseId === toWarehouseId) return { ok: false, error: `В строке ${line.lineNo} склады перемещения совпадают` };
        planned.push({ nomenclatureId, warehouseId: fromWarehouseId, movementType: 'transfer_out', direction: 'out', qty, delta: -qty, reason, counterpartyId });
        planned.push({ nomenclatureId, warehouseId: toWarehouseId, movementType: 'transfer_in', direction: 'in', qty, delta: qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_inventory') {
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        const adjustment = numField(payload, 'adjustmentQty');
        const bookQty = numField(payload, 'bookQty');
        const actualQty = numField(payload, 'actualQty');
        const delta = adjustment !== undefined ? Math.trunc(adjustment) : bookQty !== undefined && actualQty !== undefined ? Math.trunc(actualQty - bookQty) : qty;
        if (delta === 0) continue;
        planned.push({
          nomenclatureId,
          warehouseId,
          movementType: delta > 0 ? 'inventory_surplus' : 'inventory_shortage',
          direction: delta > 0 ? 'in' : 'out',
          qty: Math.abs(delta),
          delta,
          reason,
          counterpartyId,
        });
      }
    }

    if (planned.length === 0) {
      return { ok: false, error: 'В документе нет строк с движением по складу' };
    }

    const nomenclatureIds = Array.from(new Set(planned.map((item) => item.nomenclatureId)));
    const existingNomenclature =
      nomenclatureIds.length === 0
        ? []
        : await db.select({ id: erpNomenclature.id }).from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds), isNull(erpNomenclature.deletedAt)));
    if (existingNomenclature.length !== nomenclatureIds.length) return { ok: false, error: 'Не найдена часть номенклатуры документа' };

    const balanceByKey = new Map<string, { id: string; qty: number; reservedQty: number }>();
    for (const movement of planned) {
      const key = `${movement.nomenclatureId}::${movement.warehouseId}`;
      if (balanceByKey.has(key)) continue;
      const balanceRows = await db
        .select()
        .from(erpRegStockBalance)
        .where(and(eq(erpRegStockBalance.nomenclatureId, movement.nomenclatureId), eq(erpRegStockBalance.warehouseId, movement.warehouseId)))
        .limit(1);
      const balance = balanceRows[0];
      balanceByKey.set(key, {
        id: balance?.id ? String(balance.id) : randomUUID(),
        qty: Number(balance?.qty ?? 0),
        reservedQty: Number(balance?.reservedQty ?? 0),
      });
    }

    for (const movement of planned) {
      const key = `${movement.nomenclatureId}::${movement.warehouseId}`;
      const current = balanceByKey.get(key);
      if (!current) return { ok: false, error: 'Ошибка подготовки баланса' };
      const nextQty = current.qty + movement.delta;
      if (nextQty < 0) return { ok: false, error: `Недостаточно остатка для ${movement.nomenclatureId} на складе ${movement.warehouseId}` };
      current.qty = nextQty;
    }

    for (const movement of planned) {
      const key = `${movement.nomenclatureId}::${movement.warehouseId}`;
      const current = balanceByKey.get(key);
      if (!current) continue;
      const existing = await db.select({ id: erpRegStockBalance.id }).from(erpRegStockBalance).where(eq(erpRegStockBalance.id, current.id)).limit(1);
      if (existing[0]) {
        await db.update(erpRegStockBalance).set({ qty: current.qty, reservedQty: current.reservedQty, updatedAt: ts }).where(eq(erpRegStockBalance.id, current.id));
      } else {
        await db.insert(erpRegStockBalance).values({
          id: current.id,
          nomenclatureId: movement.nomenclatureId,
          partCardId: null,
          warehouseId: movement.warehouseId,
          qty: current.qty,
          reservedQty: current.reservedQty,
          updatedAt: ts,
        });
      }
      await db.insert(erpRegStockMovements).values({
        id: randomUUID(),
        nomenclatureId: movement.nomenclatureId,
        warehouseId: movement.warehouseId,
        documentHeaderId: args.documentId,
        movementType: movement.movementType,
        qty: movement.qty,
        direction: movement.direction,
        counterpartyId: movement.counterpartyId,
        reason: movement.reason,
        performedAt: ts,
        performedBy: args.actor.username,
        createdAt: ts,
      });
    }

    await db.update(erpDocumentHeaders).set({ status: 'posted', postedAt: ts, updatedAt: ts }).where(eq(erpDocumentHeaders.id, args.documentId));
    await clearPlannedIncomingRows(args.documentId, ts);
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: args.documentId,
      eventType: 'posted',
      eventPayloadJson: JSON.stringify({ by: args.actor.username }),
      eventAt: ts,
    });
    const ledgerPayloads: Array<{
      type: 'upsert';
      table: LedgerTableName;
      row_id: string;
      row: Record<string, unknown>;
      actor: { userId: string; username: string; role: string };
      ts: number;
    }> = [];
    const balanceRows = await db
      .select()
      .from(erpRegStockBalance)
      .where(inArray(erpRegStockBalance.id, Array.from(new Set(Array.from(balanceByKey.values()).map((item) => item.id))) as any));
    for (const balance of balanceRows) {
      ledgerPayloads.push({
        type: 'upsert',
        table: LedgerTableName.ErpRegStockBalance,
        row_id: String(balance.id),
        row: {
          id: String(balance.id),
          nomenclature_id: balance.nomenclatureId,
          part_card_id: balance.partCardId,
          warehouse_id: String(balance.warehouseId),
          qty: Number(balance.qty),
          reserved_qty: Number(balance.reservedQty ?? 0),
          updated_at: Number(balance.updatedAt),
        },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      });
    }
    const movementRows = await db
      .select()
      .from(erpRegStockMovements)
      .where(eq(erpRegStockMovements.documentHeaderId, args.documentId));
    for (const movement of movementRows) {
      ledgerPayloads.push({
        type: 'upsert',
        table: LedgerTableName.ErpRegStockMovements,
        row_id: String(movement.id),
        row: {
          id: String(movement.id),
          nomenclature_id: String(movement.nomenclatureId),
          warehouse_id: String(movement.warehouseId),
          document_header_id: movement.documentHeaderId,
          movement_type: String(movement.movementType),
          qty: Number(movement.qty),
          direction: String(movement.direction),
          counterparty_id: movement.counterpartyId,
          reason: movement.reason,
          performed_at: Number(movement.performedAt),
          performed_by: movement.performedBy,
          created_at: Number(movement.createdAt),
        },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      });
    }
    if (ledgerPayloads.length > 0) signAndAppendDetailed(ledgerPayloads);
    return { ok: true, id: args.documentId, posted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseMovements(args?: {
  nomenclatureId?: string;
  warehouseId?: string;
  documentHeaderId?: string;
  fromDate?: number;
  toDate?: number;
  limit?: number;
}): Promise<Result<{ rows: Array<Record<string, unknown>> }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const rows = await db.select().from(erpRegStockMovements).orderBy(desc(erpRegStockMovements.performedAt));
    const filtered = rows.filter((row) => {
      if (args?.nomenclatureId && String(row.nomenclatureId) !== String(args.nomenclatureId)) return false;
      if (args?.warehouseId && String(row.warehouseId) !== String(args.warehouseId)) return false;
      if (args?.documentHeaderId && String(row.documentHeaderId ?? '') !== String(args.documentHeaderId)) return false;
      if (args?.fromDate !== undefined && Number(row.performedAt) < Number(args.fromDate)) return false;
      if (args?.toDate !== undefined && Number(row.performedAt) > Number(args.toDate)) return false;
      return true;
    });
    const limit = Math.max(1, Math.min(2000, Number(args?.limit ?? 500)));
    const limited = filtered.slice(0, limit);
    const nomenclatureIds = Array.from(new Set(limited.map((row) => String(row.nomenclatureId)).filter(Boolean)));
    const headerIds = Array.from(new Set(limited.map((row) => String(row.documentHeaderId ?? '')).filter(Boolean)));
    const nomenclatureRows =
      nomenclatureIds.length > 0
        ? await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds as any), isNull(erpNomenclature.deletedAt)))
        : [];
    const headerRows =
      headerIds.length > 0
        ? await db.select().from(erpDocumentHeaders).where(and(inArray(erpDocumentHeaders.id, headerIds as any), isNull(erpDocumentHeaders.deletedAt)))
        : [];
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    const headerById = new Map(headerRows.map((row) => [String(row.id), row]));
    return {
      ok: true,
      rows: limited.map((row) => {
        const nomenclature = nomenclatureById.get(String(row.nomenclatureId));
        const header = row.documentHeaderId ? headerById.get(String(row.documentHeaderId)) : null;
        return {
          ...row,
          warehouseName: readLookupLabel(refs.warehouseById, String(row.warehouseId)),
          nomenclatureCode: nomenclature?.code ?? null,
          nomenclatureName: nomenclature?.name ?? null,
          documentDocNo: header?.docNo ?? null,
          documentDocType: header?.docType ?? null,
          counterpartyName: readLookupLabel(refs.counterpartyById, row.counterpartyId == null ? null : String(row.counterpartyId)),
          reasonLabel: readLookupLabel(refs.writeoffReasonById, row.reason == null ? null : String(row.reason)) ?? row.reason ?? null,
        };
      }) as Array<Record<string, unknown>>,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Полная пересборка зеркал деталей в `erp_nomenclature` (группа «Детали», тип изделие). */
export async function refreshPartWarehouseNomenclatureLinks(): Promise<void> {
  if (!isLegacyPartMirrorMode()) return;
  const gid = await ensurePartNomenclatureGroup();
  await syncPartsToWarehouseNomenclature({ detailsGroupId: gid });
}
