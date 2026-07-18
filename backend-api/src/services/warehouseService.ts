import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { LedgerTableName } from '@matricarmz/ledger';
import {
  WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART,
  filterRowsTiered,
  keyboardLayoutVariants,
  normalizeLookupCompact,
  resolveNomenclatureComponentTypeId,
} from '@matricarmz/shared';
import type { PartDimension, PartMetadata, PartSpec, PartSpecBrandLink } from '@matricarmz/shared';

import {
  AssemblyReturnMode,
  StockMovementType,
  WAREHOUSE_LOCATION_REPAIR_FUND,
  WAREHOUSE_LOCATION_SCRAP,
  WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS,
  isWorkshopWarehouseId,
  reversalMovementType,
} from '@matricarmz/shared';
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
  erpPlannedIncoming,
  erpRegStockBalance,
  erpRegStockMovements,
} from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';
import { EnginePhase, setEnginePhase } from './enginePhaseService.js';
import {
  listWarehouseLocations,
  resolveWarehouseLocationIdByCode,
  WAREHOUSE_LOCATION_DEFAULT_UUID,
} from './warehouseLocationsService.js';

/**
 * Phase 2.4 helper — accept either a uuid (new format) or a legacy warehouse_id-code
 * ('default', 'workshop_3', 'repair_fund', ...) and return the warehouse_location_id uuid.
 * Used in reserve / release / post hot paths where document payloads may carry either form
 * during the migration window.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function resolveLocationIdFromPayloadValue(value: string | null | undefined): Promise<string | null> {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (UUID_RE.test(trimmed)) return trimmed;
  return resolveWarehouseLocationIdByCode(trimmed);
}

const INCOMING_DOC_TYPES = ['inventory_opening', 'purchase_receipt', 'production_release', 'repair_recovery', 'engine_dismantling'] as const;
const STOCK_DOC_TYPES = [
  ...INCOMING_DOC_TYPES,
  'stock_receipt',
  'stock_issue',
  'stock_transfer',
  'stock_writeoff',
  'stock_inventory',
  'assembly_consumption',
  'assembly_return',
] as const;
type StockDocType = (typeof STOCK_DOC_TYPES)[number];
type IncomingDocType = (typeof INCOMING_DOC_TYPES)[number];

/**
 * Header.payload_json флаг, переключающий ветку проводки для уже существующих docType
 * (`engine_dismantling`, `repair_recovery`) на новую семантику модуля движения деталей.
 * Документы без этого флага идут через generic-incoming-ветку (как раньше).
 */
const PARTS_MOVEMENT_MODULE_MARKER = 'parts_movement_v1' as const;

/** Включает ленивый расчёт hash-chain поверх erp_reg_stock_movements (Этап 3). */
const HASHCHAIN_ENABLED = String(process.env.MATRICA_STOCK_MOVEMENT_HASHCHAIN_ENABLED ?? '').trim().toLowerCase() === 'true';

type ResultOk<T> = { ok: true } & T;
type ResultErr = { ok: false; error: string };
type Result<T> = ResultOk<T> | ResultErr;

/** Either the root `db` connection or a transaction handle — lets write helpers run inside a tx. */
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  engineId?: string | null;
  workOrderId?: string | null;
  workOrderNo?: string | null;
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
  engineId?: string | null;
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
  { code: 'drawing_no', name: 'Чертёж / № документации', dataType: 'text', description: 'Номер чертежа или техпаспорта' },
  { code: 'gost_tu', name: 'ГОСТ / ТУ', dataType: 'text', description: 'Стандарт, по которому изготовлена позиция' },
  { code: 'inventory_no', name: 'Инвентарный номер', dataType: 'text', description: 'Для инструмента и оснастки' },
  { code: 'service_life_h', name: 'Ресурс, ч', dataType: 'number', description: 'Наработка до списания/проверки' },
  { code: 'calibration_period_m', name: 'Период поверки, мес', dataType: 'number' },
  { code: 'last_calibration_at', name: 'Последняя поверка', dataType: 'date' },
  { code: 'shelf_life_m', name: 'Срок хранения, мес', dataType: 'number' },
  { code: 'analogues', name: 'Аналоги', dataType: 'text', description: 'Артикулы взаимозаменяемых позиций' },
  { code: 'tolerance_class', name: 'Класс точности', dataType: 'text' },
  { code: 'engine_power_kw', name: 'Мощность, кВт', dataType: 'number' },
  { code: 'engine_displacement_l', name: 'Рабочий объём, л', dataType: 'number' },
  { code: 'service_time_norm_min', name: 'Норма времени, мин', dataType: 'number', description: 'Базовая трудоёмкость услуги' },
  { code: 'service_grade', name: 'Разряд работ', dataType: 'text', description: 'Квалификационный разряд исполнителя' },
];

const DEFAULT_NOMENCLATURE_KIND_TO_PROPERTY_CODES: Record<string, string[]> = {
  part: ['drawing_no', 'gost_tu', 'manufacturer', 'material', 'partner_sku', 'weight_net_kg', 'dimensions_mm', 'tolerance_class', 'analogues', 'quality_grade'],
  assembly: ['drawing_no', 'gost_tu', 'manufacturer', 'weight_net_kg', 'dimensions_mm', 'analogues', 'purchase_note'],
  engine: ['manufacturer', 'engine_power_kw', 'engine_displacement_l', 'weight_net_kg', 'drawing_no', 'partner_sku', 'country_origin'],
  component: ['manufacturer', 'partner_sku', 'analogues', 'weight_net_kg', 'dimensions_mm', 'country_origin', 'tnved'],
  material: ['gost_tu', 'manufacturer', 'partner_sku', 'storage_conditions', 'shelf_life_m', 'weight_net_kg', 'tnved'],
  consumable: ['manufacturer', 'partner_sku', 'analogues', 'shelf_life_m', 'storage_conditions', 'min_ship_qty'],
  tool: ['inventory_no', 'manufacturer', 'partner_sku', 'service_life_h', 'calibration_period_m', 'last_calibration_at', 'warranty_months', 'storage_conditions'],
  good: ['manufacturer', 'partner_sku', 'tnved', 'vat_rate', 'min_ship_qty', 'weight_net_kg', 'purchase_note'],
  service: ['service_time_norm_min', 'service_grade', 'accounting_group', 'vat_rate', 'purchase_note'],
  engine_brand: ['manufacturer', 'country_origin', 'purchase_note'],
};

const DEFAULT_NOMENCLATURE_TEMPLATE_LABELS: Record<string, string> = {
  part: 'Стандарт: деталь',
  assembly: 'Стандарт: сборочная единица',
  engine: 'Стандарт: двигатель',
  component: 'Стандарт: комплектующее',
  material: 'Стандарт: материал',
  consumable: 'Стандарт: расходник',
  tool: 'Стандарт: инструмент',
  good: 'Стандарт: товар',
  service: 'Стандарт: услуга',
  engine_brand: 'Стандарт: марка двигателя',
};

const DEFAULT_NOMENCLATURE_TEMPLATE_ITEM_TYPE: Record<string, string> = {
  part: 'part',
  assembly: 'assembly',
  engine: 'engine',
  component: 'component',
  material: 'material',
  consumable: 'consumable',
  tool: 'tool',
  good: 'good',
  service: 'service',
  engine_brand: 'engine_brand',
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
  return DEFAULT_NOMENCLATURE_TEMPLATE_LABELS[kind] ?? `Стандарт: ${kind}`;
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
    const itemTypeCode = DEFAULT_NOMENCLATURE_TEMPLATE_ITEM_TYPE[kind] ?? kind;
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

// Phase 2 (parts→nomenclature) one-off backfill: create an erp_nomenclature row for any
// directory_parts that lacks one ("orphans"). The parts→nomenclature mirror is off in
// `directory` mode, so parts created/edited after the switch never got a nomenclature row;
// after Stage E.2 the openPart→openNomenclature redirect would show «Позиция не найдена»
// for them. Uses the same signed upsert path as the legacy mirror
// (upsertWarehouseNomenclature with an explicit id → upsert branch, change-log/ledger
// consistent with the existing linked-part rows). CREATE-only — never retires. Idempotent.
// Creates the erp_nomenclature mirror row for one directory_parts row (the "складская
// карточка"). The client syncs erp_nomenclature, not directory_parts, so without this row
// a part is invisible in the warehouse nomenclature list ("без складской карточки" в модуле
// дублей). Used both by createDirectoryPart (so new parts get a card immediately) and by the
// backfill below (for legacy orphans). CREATE/upsert via the signed path. Pass groupId to
// avoid re-resolving the details group per row in a loop.
async function ensurePartNomenclatureMirror(
  part: { id: string; name: string; code: string | null },
  groupId?: string | null,
): Promise<Result<{ id: string }>> {
  const detailsGroupId = groupId !== undefined ? groupId : await ensurePartNomenclatureGroup();
  const id = part.id;
  const name = String(part.name ?? '').trim() || `Деталь ${id.slice(0, 8)}`;
  // Deep-dedup Ф1 (owner decision 2026-07-12): no synthetic DET- fallback — a part
  // without a real article gets an EMPTY code (honest «артикула нет», operator can
  // fill it in later). The code uniques on both stores are partial (exclude '').
  const article = part.code ? String(part.code).trim() : '';
  const code = article;
  const specJson = JSON.stringify({
    source: WAREHOUSE_NOMENCLATURE_SPEC_SOURCE_PART,
    partId: id,
    ...(article ? { article } : {}),
  });
  return upsertWarehouseNomenclature({
    id,
    code,
    name,
    itemType: 'product',
    directoryKind: 'part',
    directoryRefId: id,
    groupId: detailsGroupId ?? null,
    specJson,
    isActive: true,
  });
}

export async function backfillMissingPartNomenclature(
  opts: { apply?: boolean } = {},
): Promise<{ orphans: Array<{ id: string; name: string; code: string | null }>; created: string[]; failed: Array<{ id: string; error: string }> }> {
  // A part counts as mirrored via EITHER convention: id-identity (the default
  // ensurePartNomenclatureMirror shape) OR the directory_ref bridge (G1 — e.g. an
  // adopted legacy nomenclature row linked by warehouse:link-nomenclature-to-part).
  const orphanRows = await db
    .select({
      id: directoryParts.id,
      name: directoryParts.name,
      code: directoryParts.code,
    })
    .from(directoryParts)
    .leftJoin(
      erpNomenclature,
      and(
        or(eq(erpNomenclature.id, directoryParts.id), eq(erpNomenclature.directoryRefId, directoryParts.id)),
        isNull(erpNomenclature.deletedAt),
      ),
    )
    .where(and(isNull(directoryParts.deletedAt), isNull(erpNomenclature.id)));

  const orphans = orphanRows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    code: row.code ? String(row.code) : null,
  }));
  const created: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  if (!opts.apply || orphanRows.length === 0) return { orphans, created, failed };

  const detailsGroupId = await ensurePartNomenclatureGroup();
  for (const row of orphanRows) {
    const id = String(row.id);
    const res = await ensurePartNomenclatureMirror(
      { id, name: String(row.name ?? ''), code: row.code ? String(row.code) : null },
      detailsGroupId,
    );
    if (res.ok) created.push(id);
    else failed.push({ id, error: res.error ?? 'unknown' });
  }
  return { orphans, created, failed };
}

async function listWarehouseReferenceData() {
  // Phase 2.3: warehouses теперь читаются из централизованного warehouse_locations,
  // а не из устаревшего EAV `warehouse_ref` + ensureDefaultWarehouse(). Старый источник
  // оставляли долго совместимости, но он показывал «призраки» (например, в фильтре
  // «Прогноз сборки → Склады» — пользователь жаловался). id = code (warehouseId-string),
  // что сохраняет совместимость со всеми downstream-местами, делающими WHERE warehouse_id = id.
  const [wlListResult, nomenclatureGroups, units, writeoffReasons, counterpartiesRows, employeesRows, engineBrands, contractsRows] = await Promise.all([
    listWarehouseLocations({ activeOnly: true }),
    listMasterdataLookup('nomenclature_group'),
    listMasterdataLookup('unit'),
    listMasterdataLookup('stock_write_off_reason'),
    db.select().from(erpCounterparties).where(isNull(erpCounterparties.deletedAt)).orderBy(asc(erpCounterparties.name)),
    db.select().from(erpEmployeeCards).where(isNull(erpEmployeeCards.deletedAt)).orderBy(asc(erpEmployeeCards.fullName)),
    listMasterdataLookup('engine_brand'),
    db.select().from(erpContracts).where(isNull(erpContracts.deletedAt)).orderBy(asc(erpContracts.name)),
  ]);

  const warehouses: LookupOption[] = wlListResult.ok
    ? wlListResult.rows.map((row) => ({ id: row.code, label: row.name, code: row.code }))
    : ensureDefaultWarehouse([]);
  // Phase 2.x: registers store warehouse_location_id (uuid); the API surface speaks code.
  // These two maps bridge the uuid stored in rows back to the code-based LookupOption.
  const warehouseCodeToLocationId = new Map<string, string>();
  const warehouseByLocationId = new Map<string, LookupOption>();
  if (wlListResult.ok) {
    for (const row of wlListResult.rows) {
      warehouseCodeToLocationId.set(row.code, row.id);
      warehouseByLocationId.set(row.id, { id: row.code, label: row.name, code: row.code });
    }
  }
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
  const contracts: LookupOption[] = contractsRows.map((row) => ({
    id: String(row.id),
    label: String(row.name),
    code: row.code == null ? null : String(row.code),
  }));

  return {
    warehouses,
    nomenclatureGroups,
    units,
    writeoffReasons,
    counterparties,
    employees,
    engineBrands,
    contracts,
    warehouseById: buildLookupMap(warehouses),
    warehouseCodeToLocationId,
    warehouseByLocationId,
    groupById: buildLookupMap(nomenclatureGroups),
    unitById: buildLookupMap(units),
    writeoffReasonById: buildLookupMap(writeoffReasons),
    counterpartyById: buildLookupMap(counterparties),
    employeeById: buildLookupMap(employees),
    engineBrandById: buildLookupMap(engineBrands),
    contractById: buildLookupMap(contracts),
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
    engineId: strField(payload, 'engineId') ?? null,
    workOrderId: strField(payload, 'workOrderId') ?? null,
    workOrderNo: strField(payload, 'workOrderNo') ?? null,
    reversalOfId: strField(payload, 'reversalOfId') ?? null,
    reversalOfDocNo: strField(payload, 'reversalOfDocNo') ?? null,
    reversedByDocumentId: strField(payload, 'reversedByDocumentId') ?? null,
    reversedByDocNo: strField(payload, 'reversedByDocNo') ?? null,
    reversedAt: numField(payload, 'reversedAt') ?? null,
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
  if (input?.engineId !== undefined) payload.engineId = input.engineId;
  if (input?.workOrderId !== undefined) payload.workOrderId = input.workOrderId;
  if (input?.workOrderNo !== undefined) payload.workOrderNo = input.workOrderNo;
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

async function replacePlannedIncomingRows(documentId: string, rows: PlannedIncomingRow[], ts: number, exec: DbExecutor = db) {
  await exec
    .update(erpPlannedIncoming)
    .set({ deletedAt: ts, updatedAt: ts })
    .where(and(eq(erpPlannedIncoming.documentHeaderId, documentId), isNull(erpPlannedIncoming.deletedAt)));
  if (rows.length === 0) return;
  // Phase 2.4 PR 2: явный warehouseLocationId через bulk-резолв (после DROP trigger удаляется).
  // Резолв читает warehouse_locations (отдельная таблица, кэш) — оставляем на root `db`,
  // не на `exec`: read-only lookup вне записей документа, в транзакцию его тянуть не нужно.
  const codes = Array.from(new Set(rows.map((r) => String(r.warehouseId ?? '').trim()).filter(Boolean)));
  const locationByCode = new Map<string, string>();
  for (const code of codes) {
    const locId = await resolveLocationIdFromPayloadValue(code);
    if (locId) locationByCode.set(code, locId);
  }
  await exec.insert(erpPlannedIncoming).values(
    rows.map((row) => ({
      id: randomUUID(),
      documentHeaderId: row.documentHeaderId,
      expectedDate: row.expectedDate,
      warehouseLocationId: locationByCode.get(String(row.warehouseId ?? '').trim()) ?? null,
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

async function clearPlannedIncomingRows(documentId: string, ts: number, exec: DbExecutor = db) {
  await exec
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
      contracts: LookupOption[];
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
        contracts: refs.contracts,
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

/**
 * SQL search condition for nomenclature lists (#035 Ф1 pilot 2): the original
 * ILIKE over code/sku/name/barcode, extended with RU<->EN keyboard layout
 * variants and a compact match (separators stripped on both sides, so
 * «2401» finds code «240-1»). Tier-3 fuzzy stays client/Ф3 (pg_trgm).
 */
function nomenclatureSearchCondition(searchRaw: string) {
  const escapeLike = (s: string) => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const conditions = [searchRaw, ...keyboardLayoutVariants(searchRaw)].map((variant) => {
    const pat = `%${escapeLike(variant)}%`;
    return sql`(
      COALESCE(${erpNomenclature.code}, '') ILIKE ${pat} ESCAPE '\\'
      OR COALESCE(${erpNomenclature.sku}, '') ILIKE ${pat} ESCAPE '\\'
      OR COALESCE(${erpNomenclature.name}, '') ILIKE ${pat} ESCAPE '\\'
      OR COALESCE(${erpNomenclature.barcode}, '') ILIKE ${pat} ESCAPE '\\'
    )`;
  });
  const compact = normalizeLookupCompact(searchRaw);
  if (compact && compact !== searchRaw.toLowerCase()) {
    const compactPat = `%${escapeLike(compact)}%`;
    // Same normalization as normalizeLookupCompact: lower, ё->е, drop non-alphanumerics.
    conditions.push(
      sql`regexp_replace(replace(lower(COALESCE(${erpNomenclature.code}, '') || ' ' || COALESCE(${erpNomenclature.sku}, '') || ' ' || COALESCE(${erpNomenclature.barcode}, '')), 'ё', 'е'), '[^a-z0-9а-я]+', '', 'g') LIKE ${compactPat} ESCAPE '\\'`,
    );
  }
  return sql`(${sql.join(conditions, sql` OR `)})`;
}

export async function listWarehouseNomenclature(args?: {
  id?: string;
  search?: string;
  itemType?: string;
  directoryKind?: string;
  directoryRefId?: string;
  groupId?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}): Promise<Result<{ rows: Array<Record<string, unknown>>; hasMore?: boolean }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const idOne = String(args?.id ?? '').trim();
    const resolveComponentTypeId = (row: typeof erpNomenclature.$inferSelect): string | null =>
      resolveNomenclatureComponentTypeId(row);
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
          componentTypeId: resolveComponentTypeId(row),
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
    if (args?.directoryRefId) parts.push(eq(erpNomenclature.directoryRefId, String(args.directoryRefId)));
    if (args?.isActive !== undefined) parts.push(eq(erpNomenclature.isActive, Boolean(args.isActive)));

    if (searchRaw) {
      parts.push(nomenclatureSearchCondition(searchRaw));
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
        componentTypeId: resolveComponentTypeId(row),
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

export async function listWarehouseNomenclatureGroupCounts(args?: {
  search?: string;
  itemType?: string;
  directoryKind?: string;
}): Promise<Result<{ rows: Array<{ groupId: string | null; groupName: string; count: number }> }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const parts = [isNull(erpNomenclature.deletedAt)];
    if (args?.itemType) parts.push(eq(erpNomenclature.itemType, String(args.itemType)));
    if (args?.directoryKind) parts.push(eq(erpNomenclature.directoryKind, String(args.directoryKind)));
    const searchRaw = String(args?.search ?? '').trim();
    if (searchRaw) {
      parts.push(nomenclatureSearchCondition(searchRaw));
    }
    const rows = await db
      .select({ groupId: erpNomenclature.groupId, cnt: count() })
      .from(erpNomenclature)
      .where(and(...parts))
      .groupBy(erpNomenclature.groupId)
      .orderBy(asc(erpNomenclature.groupId));
    return {
      ok: true,
      rows: rows.map((row) => ({
        groupId: row.groupId ?? null,
        groupName: readLookupLabel(refs.groupById, row.groupId == null ? null : String(row.groupId)) ?? 'Без группы',
        count: Number(row.cnt),
      })),
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
  /** Block D of v1.22.0: dedicated column write (migration 0053). UI now sends this
   * field explicitly so backend writes to erp_nomenclature.component_type_id directly,
   * instead of stuffing it into spec_json. Older legacy spec_json.componentTypeId still
   * read by resolveNomenclatureComponentTypeId as fallback during transitional period. */
  componentTypeId?: string | null;
  isActive?: boolean;
}): Promise<Result<{ id: string }>> {
  try {
    await ensureNomenclatureGovernanceMeta();
    const id = String(args.id || randomUUID());
    const isCreate = !args.id;
    const governanceSpec = parseGovernanceSpecPayload(args.specJson ?? null);
    // Типы номенклатуры, для которых есть отдельный справочник-карточка (directory_*):
    // part → directory_parts, tool → directory_tools, good → directory_goods,
    // service → directory_services, engine_brand → directory_engine_brands.
    // Остальные item_type'ы (assembly/engine/component/material/consumable) — это просто
    // категории номенклатуры без отдельной карточки-источника. Они создаются прямо в
    // erp_nomenclature без directoryRefId.
    const KINDS_REQUIRING_DIRECTORY_REF = new Set(['part', 'tool', 'good', 'product', 'service', 'engine_brand']);
    const sourceKindForCheck = String(args.directoryKind ?? '').trim().toLowerCase();
    const requiresDirectoryRef = !sourceKindForCheck || KINDS_REQUIRING_DIRECTORY_REF.has(sourceKindForCheck);
    if (isCreate) {
      if (requiresDirectoryRef) {
        if (!args.directoryKind || !String(args.directoryKind).trim()) return { ok: false, error: 'Для создания укажите источник (directoryKind).' };
        if (!args.directoryRefId || !String(args.directoryRefId).trim()) return { ok: false, error: 'Для создания укажите карточку источника (directoryRefId).' };
      }
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
      } else if (sourceKind === 'good' || sourceKind === 'product') {
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
      // Auto-backfill (Phase-1 Directories→Nomenclature):
      // Старые записи могли быть созданы через legacy /parts/ API или admin.entities.create
      // ДО v1.20.2, когда зеркало в directory_* появлялось только разовым backfill-скриптом.
      // Если source не нашёлся в directory_*, ищем его в общем EAV-хранилище (entities +
      // attribute_values) и зеркалим на лету. Это чинит «висячие» orphan-записи без падения.
      if (!resolvedSourceName) {
        const entityTypeCode =
          sourceKind === 'part' ? 'part'
          : sourceKind === 'tool' ? 'tool'
          : (sourceKind === 'good' || sourceKind === 'product') ? 'product'
          : sourceKind === 'service' ? 'service'
          : sourceKind === 'engine_brand' ? 'engine_brand'
          : null;
        if (entityTypeCode) {
          const ts = nowMs();
          const typeRows = await db
            .select({ id: entityTypes.id })
            .from(entityTypes)
            .where(eq(entityTypes.code, entityTypeCode))
            .limit(1);
          const typeId = typeRows[0]?.id ? String(typeRows[0].id) : null;
          if (typeId) {
            const entRows = await db
              .select({ id: entities.id })
              .from(entities)
              .where(and(eq(entities.id, sourceRefId as any), eq(entities.typeId, typeId as any), isNull(entities.deletedAt)))
              .limit(1);
            if (entRows[0]) {
              const nameAttrDef = await db
                .select({ id: attributeDefs.id })
                .from(attributeDefs)
                .where(and(eq(attributeDefs.entityTypeId, typeId as any), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
                .limit(1);
              let entityName = 'Без названия';
              if (nameAttrDef[0]?.id) {
                const valueRows = await db
                  .select({ valueJson: attributeValues.valueJson })
                  .from(attributeValues)
                  .where(and(eq(attributeValues.entityId, sourceRefId as any), eq(attributeValues.attributeDefId, nameAttrDef[0].id as any), isNull(attributeValues.deletedAt)))
                  .limit(1);
                if (valueRows[0]?.valueJson) {
                  try {
                    const parsed = JSON.parse(String(valueRows[0].valueJson));
                    if (typeof parsed === 'string' && parsed.trim()) entityName = parsed.trim();
                    else if (parsed && typeof (parsed as { value?: unknown }).value === 'string' && String((parsed as { value: string }).value).trim()) {
                      entityName = String((parsed as { value: string }).value).trim();
                    }
                  } catch {
                    const raw = String(valueRows[0].valueJson).trim();
                    if (raw && !raw.startsWith('{') && !raw.startsWith('[')) entityName = raw;
                  }
                }
              }
              const dirTable =
                sourceKind === 'part' ? directoryParts
                : sourceKind === 'tool' ? directoryTools
                : (sourceKind === 'good' || sourceKind === 'product') ? directoryGoods
                : sourceKind === 'service' ? directoryServices
                : sourceKind === 'engine_brand' ? directoryEngineBrands
                : null;
              if (dirTable) {
                await db
                  .insert(dirTable as any)
                  .values({
                    id: sourceRefId,
                    name: entityName,
                    isActive: true,
                    metadataJson: null,
                    deprecatedAt: null,
                    createdAt: ts,
                    updatedAt: ts,
                    deletedAt: null,
                  })
                  .onConflictDoNothing({ target: (dirTable as any).id });
                resolvedSourceName = entityName;
              }
            }
          }
        }
      }
      // Жёсткая проверка только для kinds, у которых обязателен directory-источник.
      // Для assembly/engine/component/material/consumable resolvedSourceName остаётся null —
      // это нормально, у них нет отдельной карточки-источника, имя берётся из args.name.
      if (!resolvedSourceName && KINDS_REQUIRING_DIRECTORY_REF.has(sourceKind)) {
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
      if (templateDirectoryKind && sourceKind) {
        const kindsMatch =
          templateDirectoryKind === sourceKind ||
          (templateDirectoryKind === 'good' && sourceKind === 'product') ||
          (templateDirectoryKind === 'product' && sourceKind === 'good');
        if (!kindsMatch) {
          return { ok: false, error: 'Шаблон не соответствует выбранному источнику номенклатуры.' };
        }
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
      // componentTypeId: spread only when caller explicitly passed the field so we do not
      // overwrite an existing column value on partial updates.
      ...(args.componentTypeId !== undefined
        ? {
            componentTypeId:
              args.componentTypeId == null
                ? null
                : String(args.componentTypeId).trim() || null,
          }
        : {}),
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
}): Promise<Result<{ id: string }>> {
  try {
    const ts = nowMs();
    await db.update(erpNomenclature).set({ isActive: false, deletedAt: ts, updatedAt: ts }).where(eq(erpNomenclature.id, args.id));
    const saved = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, args.id)).limit(1);
    const row = saved[0];
    // Deep-dedup Ф1 (owner decision 2026-07-12): deleting the карточка retires the paired
    // деталь too (symmetric soft-delete). Before this, the directory_parts row kept living
    // invisibly — the nomenclature list/search no longer showed it, while re-creating a part
    // with the same name failed with «duplicate part exists» (ghost trap, reproduced live).
    // directory_parts is server-only (live-HTTP, not synced) → plain UPDATE, no ledger.
    if (row && String(row.directoryKind ?? '') === 'part') {
      await db
        .update(directoryParts)
        .set({ deletedAt: ts, updatedAt: ts })
        .where(and(eq(directoryParts.id, args.id), isNull(directoryParts.deletedAt)));
    }
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

function parsePartSpecArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function rowToPartSpec(row: {
  code: string | null;
  dimensionsJson: string | null;
  brandLinksJson: string | null;
}): PartSpec {
  return {
    code: row.code ?? null,
    dimensions: parsePartSpecArray<PartDimension>(row.dimensionsJson),
    brandLinks: parsePartSpecArray<PartSpecBrandLink>(row.brandLinksJson),
  };
}

// Phase 3: residual part EAV fields carried in directory_parts.metadata_json.
function rowToPartMetadata(row: { metadataJson: string | null }): PartMetadata {
  if (!row.metadataJson) return {};
  try {
    const parsed = JSON.parse(row.metadataJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PartMetadata) : {};
  } catch {
    return {};
  }
}

// Serialize metadata to a JSON column value, dropping undefined keys. Returns null
// for an empty/all-undefined blob so the column stays NULL rather than "{}".
function serializePartMetadata(metadata: PartMetadata): string | null {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) clean[key] = value;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

// Phase 2 (parts→nomenclature, Variant A), Stage C. Part-spec lives on the
// directory_parts row (id == nomenclature id). Server-only table — read live
// via this endpoint, not synced to the client SQLite, so no ledger signing.
export async function getWarehouseNomenclaturePartSpec(args: {
  nomenclatureId: string;
}): Promise<Result<{ spec: PartSpec | null; metadata: PartMetadata | null; name: string | null; isActive: boolean | null }>> {
  try {
    const id = String(args.nomenclatureId);
    const rows = await db
      .select()
      .from(directoryParts)
      .where(and(eq(directoryParts.id, id), isNull(directoryParts.deletedAt)))
      .limit(1);
    const row = rows[0];
    // Stage D: name/isActive let this endpoint cover legacy `parts.get` basics.
    return {
      ok: true,
      spec: row ? rowToPartSpec(row) : null,
      metadata: row ? rowToPartMetadata(row) : null,
      name: row ? String(row.name) : null,
      isActive: row ? Boolean(row.isActive) : null,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function upsertWarehouseNomenclaturePartSpec(args: {
  nomenclatureId: string;
  spec: PartSpec;
  metadata?: PartMetadata;
}): Promise<Result<{ spec: PartSpec; metadata: PartMetadata | null }>> {
  try {
    const id = String(args.nomenclatureId);
    if (!id) return { ok: false, error: 'nomenclatureId обязателен' };
    const code = args.spec.code ? String(args.spec.code).trim() || null : null;
    const dimensions = Array.isArray(args.spec.dimensions) ? args.spec.dimensions : [];
    const brandLinks = Array.isArray(args.spec.brandLinks) ? args.spec.brandLinks : [];
    const dimensionsJson = dimensions.length ? JSON.stringify(dimensions) : null;
    const brandLinksJson = brandLinks.length ? JSON.stringify(brandLinks) : null;
    // metadata is optional: when omitted (old clients) leave metadata_json untouched
    // (don't add it to the insert values or the conflict set). Only written when provided.
    const metadataProvided = args.metadata !== undefined;
    const metadataJson = metadataProvided ? serializePartMetadata(args.metadata as PartMetadata) : null;
    const ts = nowMs();

    // directory_parts.name is NOT NULL — resolve it (existing row wins, else the
    // nomenclature) so the insert branch of the upsert never violates the constraint.
    const existing = await db
      .select({ name: directoryParts.name })
      .from(directoryParts)
      .where(eq(directoryParts.id, id))
      .limit(1);
    let name = existing[0]?.name as string | undefined;
    if (!name) {
      const nom = await db
        .select({ name: erpNomenclature.name })
        .from(erpNomenclature)
        .where(and(eq(erpNomenclature.id, id), isNull(erpNomenclature.deletedAt)))
        .limit(1);
      name = nom[0]?.name as string | undefined;
    }
    if (!name) return { ok: false, error: 'номенклатура не найдена' };

    await db
      .insert(directoryParts)
      .values({
        id,
        name: String(name),
        isActive: true,
        code,
        dimensionsJson,
        brandLinksJson,
        ...(metadataProvided ? { metadataJson } : {}),
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: directoryParts.id,
        set: {
          code,
          dimensionsJson,
          brandLinksJson,
          ...(metadataProvided ? { metadataJson } : {}),
          updatedAt: ts,
          deletedAt: null,
        },
      });
    const saved = await db.select().from(directoryParts).where(eq(directoryParts.id, id)).limit(1);
    const row = saved[0];
    return {
      ok: true,
      spec: row ? rowToPartSpec(row) : rowToPartSpec({ code, dimensionsJson, brandLinksJson }),
      metadata: row ? rowToPartMetadata(row) : rowToPartMetadata({ metadataJson }),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Part identity = (name, артикул) pair — the owner's key (program Т1,
// docs/plans/parts-articul-acts-2026-06.md): two parts may share a name with
// different артикулы ("Вал коленчатый" 3305-01-18 vs 3305-01-17) AND share an
// артикул with different names ("Картер верхний"/"Картер нижний" 3301-15-30).
// Normalized with the same shared normalizer the search uses, so dup-detection
// and search never disagree on what "the same" means.
function directoryPartDedupKey(name: string, code: string | null | undefined): string {
  return `${normalizeLookupCompact(String(name ?? ''))}|${normalizeLookupCompact(String(code ?? ''))}`;
}

// Stage D source: list all part-class items with their hydrated spec. Sourced from
// directory_parts (not directory_kind='part' on erp_nomenclature — that identifier is
// empty on prod; the reliable link is directory_parts.id == nomenclature id). Small set
// (~160), returned in one shot — no pagination. Optional engineBrandId filter covers the
// remaining consumers (Admin, parts-by-brand). The part-template axis was removed in
// Phase 3.5 (plans/parts-templates-deprecation-2026-06.md) — no more templateName/templateId filter.
export async function listWarehouseNomenclaturePartSpecs(args?: {
  engineBrandId?: string;
}): Promise<
  Result<{
    rows: Array<{ id: string; name: string; isActive: boolean; metadata: PartMetadata } & PartSpec>;
  }>
> {
  try {
    // Имя/артикул детали оператор правит в карточке номенклатуры (erp_nomenclature),
    // а этот список читают карточка марки и карточка двигателя. Раньше брали name/code
    // из directory_parts → правка номенклатуры не доезжала (рассинхрон). Берём name/code
    // из парной складской карточки (erp_nomenclature, id == directory_parts.id),
    // fallback на directory_parts для деталей без карточки. Спека (размеры, brand-links,
    // metadata) остаётся на directory_parts.
    const rows = await db
      .select({ dp: directoryParts, nomName: erpNomenclature.name, nomCode: erpNomenclature.code })
      .from(directoryParts)
      .leftJoin(erpNomenclature, and(eq(erpNomenclature.id, directoryParts.id), isNull(erpNomenclature.deletedAt)))
      .where(isNull(directoryParts.deletedAt))
      .orderBy(asc(directoryParts.name));
    const engineBrandIdFilter = args?.engineBrandId ? String(args.engineBrandId).trim() : '';

    let hydrated = rows.map(({ dp, nomName, nomCode }) => {
      const spec = rowToPartSpec(dp);
      return {
        id: String(dp.id),
        name: String(nomName ?? dp.name),
        isActive: Boolean(dp.isActive),
        ...spec,
        code: nomCode ?? spec.code ?? null,
        metadata: rowToPartMetadata(dp),
      };
    });
    if (engineBrandIdFilter) hydrated = hydrated.filter((r) => r.brandLinks.some((l) => l.engineBrandId === engineBrandIdFilter));

    return { ok: true, rows: hydrated };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Stage D: directory-first part creation. Inserts a directory_parts row (the Phase 3
// source of truth), deduping by code (when given) else name. Emits the same
// `duplicate part exists: <uuid>` contract that createWarehouseNomenclatureFromDirectory.ts
// parses. Does NOT create the paired erp_nomenclature row — the caller pairs it via
// nomenclatureUpsert(directoryRefId), exactly as the legacy parts.create flow does.
export async function createDirectoryPart(args: {
  name: string;
  code?: string | null;
}): Promise<Result<{ part: { id: string } }>> {
  try {
    const name = String(args.name ?? '').trim();
    if (!name) return { ok: false, error: 'название обязательно' };
    const code = args.code ? String(args.code).trim() || null : null;

    const existing = await db
      .select({ id: directoryParts.id, name: directoryParts.name, code: directoryParts.code })
      .from(directoryParts)
      .where(isNull(directoryParts.deletedAt));
    const key = directoryPartDedupKey(name, code);
    const dup = existing.find((r) => directoryPartDedupKey(String(r.name ?? ''), r.code) === key);
    if (dup) return { ok: false, error: `duplicate part exists: ${String(dup.id)}` };

    const id = randomUUID();
    const ts = nowMs();
    await db.insert(directoryParts).values({
      id,
      name,
      isActive: true,
      code,
      dimensionsJson: null,
      brandLinksJson: null,
      metadataJson: null,
      deprecatedAt: null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    });
    // Складская карточка (зеркало erp_nomenclature) — сразу, иначе деталь не видна в списке
    // номенклатуры клиента (синкается erp_nomenclature, не directory_parts) — статус «без
    // складской карточки» в модуле дублей. Best-effort: если code занят другой номенклатурой
    // (unique erp_nomenclature_code_uq), деталь всё равно создана; карточку добьёт backfill.
    const mirror = await ensurePartNomenclatureMirror({ id, name, code });
    if (!mirror.ok) {
      console.warn(`[createDirectoryPart] складская карточка не создана для ${id} «${name}»: ${mirror.error ?? 'unknown'}`);
    }
    return { ok: true, part: { id } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listWarehouseEngineInstances(args?: {
  nomenclatureId?: string;
  contractId?: string;
  contractSectionNumber?: string;
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
    // Filter speaks code (picker option id); resolve to the uuid stored in the register.
    // Tolerate an already-resolved uuid by falling through to the raw value.
    const targetLocationId = args?.warehouseId
      ? (refs.warehouseCodeToLocationId.get(String(args.warehouseId)) ?? String(args.warehouseId))
      : undefined;
    const filtered = rows.filter((row) => {
      if (args?.nomenclatureId && String(row.nomenclatureId) !== String(args.nomenclatureId)) return false;
      if (args?.contractId && String(row.contractId ?? '') !== String(args.contractId)) return false;
      if (args?.contractSectionNumber && String(row.contractSectionNumber ?? '') !== String(args.contractSectionNumber)) return false;
      if (targetLocationId && String(row.warehouseLocationId ?? '') !== targetLocationId) return false;
      if (args?.status && String(row.currentStatus) !== String(args.status)) return false;
      if (args?.search) {
        const q = String(args.search).trim().toLowerCase();
        if (q) {
          const hay = `${String(row.serialNumber ?? '')} ${String(row.contractId ?? '')} ${String(row.warehouseLocationId ?? '')}`.toLowerCase();
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
      const locId = String(row.warehouseLocationId ?? '');
      const whOpt = refs.warehouseByLocationId.get(locId);
      return {
        ...row,
        nomenclatureCode: n?.code ?? null,
        nomenclatureName: n?.name ?? null,
        // Expose CODE (not the uuid) to match the picker / stock list surface.
        warehouseId: whOpt?.code ?? locId,
        warehouseName: whOpt?.label ?? null,
        contractCode: c?.code ?? null,
        contractName: c?.name ?? null,
        contractSectionNumber: row.contractSectionNumber ?? null,
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
  contractSectionNumber?: string | null;
  warehouseId?: string;
  currentStatus?: string;
}): Promise<Result<{ id: string }>> {
  try {
    const id = String(args.id || randomUUID());
    const ts = nowMs();
    // Phase 2.4 PR 3: warehouse_id column dropped — резолвим API-input (uuid либо legacy code)
    // в warehouse_location_id (uuid FK). Контракт API остался: args.warehouseId.
    const warehouseLocationId =
      (await resolveLocationIdFromPayloadValue(String(args.warehouseId ?? 'default'))) ??
      WAREHOUSE_LOCATION_DEFAULT_UUID;
    await db
      .insert(erpEngineInstances)
      .values({
        id,
        nomenclatureId: String(args.nomenclatureId),
        serialNumber: String(args.serialNumber).trim(),
        contractId: args.contractId ?? null,
        contractSectionNumber: args.contractSectionNumber ?? null,
        warehouseLocationId,
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
          contractSectionNumber: args.contractSectionNumber ?? null,
          warehouseLocationId,
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
            contract_section_number: row.contractSectionNumber,
            current_status: String(row.currentStatus),
            warehouse_location_id: row.warehouseLocationId ?? null,
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
            warehouse_location_id: row.warehouseLocationId ?? null,
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
}): Promise<Result<{ rows: Array<Record<string, unknown>>; hasMore?: boolean; searchSimilar?: boolean }>> {
  try {
    const refs = await listWarehouseReferenceData();
    const rows = await db.select().from(erpRegStockBalance).orderBy(asc(erpRegStockBalance.warehouseLocationId));
    const nomenclatureIds = Array.from(new Set(rows.map((row) => row.nomenclatureId).filter((v): v is string => typeof v === 'string' && v.length > 0)));
    const nomenclatureRows =
      nomenclatureIds.length === 0
        ? []
        : await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds), isNull(erpNomenclature.deletedAt)));
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    const search = String(args?.search ?? '').trim().toLowerCase();
    // Filter speaks code (picker option id); resolve to the uuid stored in the register.
    // Tolerate an already-resolved uuid by falling through to the raw value.
    const targetLocationId = args?.warehouseId
      ? (refs.warehouseCodeToLocationId.get(String(args.warehouseId)) ?? String(args.warehouseId))
      : undefined;
    const baseFiltered = rows.filter((row) => {
      if (targetLocationId && String(row.warehouseLocationId ?? '') !== targetLocationId) return false;
      if (args?.nomenclatureId && String(row.nomenclatureId ?? '') !== String(args.nomenclatureId)) return false;
      const n = row.nomenclatureId ? nomenclatureById.get(String(row.nomenclatureId)) : undefined;
      if (args?.lowStockOnly) {
        const min = Number(n?.minStock ?? NaN);
        if (!Number.isFinite(min)) return false;
        if (Number(row.qty) > min) return false;
      }
      return true;
    });
    const searched = filterRowsTiered(baseFiltered, search, (row) => {
      const n = row.nomenclatureId ? nomenclatureById.get(String(row.nomenclatureId)) : undefined;
      return {
        label: String(n?.name ?? ''),
        searchText: `${String(n?.code ?? '')} ${String(n?.sku ?? '')} ${String(row.warehouseLocationId ?? '')}`,
      };
    });
    const filtered = searched.rows
      .map((row) => {
        const n = row.nomenclatureId ? nomenclatureById.get(String(row.nomenclatureId)) : undefined;
        const reservedQty = Number(row.reservedQty ?? 0);
        const qty = Number(row.qty ?? 0);
        const locId = String(row.warehouseLocationId ?? '');
        const whOpt = refs.warehouseByLocationId.get(locId);
        return {
          ...row,
          // Expose CODE (not the uuid) so the frontend stays consistent with the picker.
          warehouseId: whOpt?.code ?? locId,
          warehouseName: whOpt?.label ?? null,
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
      const wa = String((a as { warehouseLocationId?: unknown }).warehouseLocationId ?? '');
      const wb = String((b as { warehouseLocationId?: unknown }).warehouseLocationId ?? '');
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
      return { ok: true, rows: sorted as Array<Record<string, unknown>>, hasMore: false, searchSimilar: searched.similarMode };
    }
    const limit = Math.min(Math.max(Math.trunc(Number(args.limit)), 1), 10_000);
    const offset = Math.max(Math.trunc(Number(args.offset ?? 0)), 0);
    const pageSlice = sorted.slice(offset, offset + limit + 1);
    const hasMore = pageSlice.length > limit;
    const rowsOut = hasMore ? pageSlice.slice(0, limit) : pageSlice;
    return { ok: true, rows: rowsOut as Array<Record<string, unknown>>, hasMore, searchSimilar: searched.similarMode };
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
        engineId: headerPayload.engineId,
        workOrderId: headerPayload.workOrderId,
        workOrderNo: headerPayload.workOrderNo,
        reversalOfId: headerPayload.reversalOfId,
        reversalOfDocNo: headerPayload.reversalOfDocNo,
        reversedByDocumentId: headerPayload.reversedByDocumentId,
        reversedByDocNo: headerPayload.reversedByDocNo,
        reversedAt: headerPayload.reversedAt,
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
      .orderBy(asc(erpPlannedIncoming.expectedDate), asc(erpPlannedIncoming.warehouseLocationId));
    const filtered = rows.filter((row) => (args.warehouseId ? String(row.warehouseLocationId ?? '') === String(args.warehouseId) : true));
    const nomenclatureIds = Array.from(new Set(filtered.map((row) => String(row.nomenclatureId)).filter(Boolean)));
    const nomenclatureRows =
      nomenclatureIds.length > 0
        ? await db.select().from(erpNomenclature).where(and(inArray(erpNomenclature.id, nomenclatureIds as any), isNull(erpNomenclature.deletedAt)))
        : [];
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    const grouped = new Map<string, Record<string, unknown>>();
    for (const row of filtered) {
      const key = `${row.expectedDate}::${row.warehouseLocationId ?? ''}::${row.nomenclatureId}::${row.sourceType}::${row.unit ?? ''}`;
      const existing = grouped.get(key);
      const nomenclature = nomenclatureById.get(String(row.nomenclatureId));
      if (!existing) {
        grouped.set(key, {
          expectedDate: Number(row.expectedDate),
          warehouseId: String(row.warehouseLocationId ?? ''),
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
        // warehouseId field здесь — это resolved warehouse_location_id uuid (см. grouped.set выше).
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
          engineId: headerPayload.engineId,
          workOrderId: headerPayload.workOrderId,
          workOrderNo: headerPayload.workOrderNo,
          reversalOfId: headerPayload.reversalOfId,
          reversalOfDocNo: headerPayload.reversalOfDocNo,
          reversedByDocumentId: headerPayload.reversedByDocumentId,
          reversedByDocNo: headerPayload.reversedByDocNo,
          reversedAt: headerPayload.reversedAt,
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
    const isUpdate = Boolean(args.id);
    if (isUpdate) {
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
    const isPlannedIncoming = requestedStatus === 'planned' && isIncomingDocType(String(args.docType));
    let plannedRows: PlannedIncomingRow[] = [];
    if (isPlannedIncoming) {
      const headerPayload = parseWarehouseHeaderPayload(mergedHeaderPayloadJson);
      plannedRows = buildPlannedIncomingRows({ documentId: id, docType: String(args.docType), headerPayload, lines });
      if (plannedRows.length === 0) return { ok: false, error: 'Для planned-документа прихода нужны строки с количеством и номенклатурой' };
    }
    // Атомарность: header + lines + planned_incoming + journal — одна транзакция. Иначе сбой
    // planned_incoming (например, FK nomenclature_id на orphan-id) откатывал бы только себя,
    // оставляя «висячий» документ с шапкой и строками, но без planned_incoming.
    await db.transaction(async (tx) => {
      if (isUpdate) {
        await tx
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
        await tx.delete(erpDocumentLines).where(eq(erpDocumentLines.headerId, id));
      } else {
        await tx.insert(erpDocumentHeaders).values({
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
      if (lines.length > 0) await tx.insert(erpDocumentLines).values(lines);
      if (isPlannedIncoming) {
        await replacePlannedIncomingRows(id, plannedRows, ts, tx);
      } else {
        await clearPlannedIncomingRows(id, ts, tx);
      }
      await tx.insert(erpJournalDocuments).values({
        id: randomUUID(),
        documentHeaderId: id,
        eventType: isUpdate ? 'updated' : 'created',
        eventPayloadJson: JSON.stringify({ docType: args.docType, by: args.actor.username, lines: lines.length }),
        eventAt: ts,
      });
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
    if (String(header.status) === 'posted') return { ok: false, error: 'Проведенный документ нельзя отменить — используйте «Сторнировать» на карточке документа' };
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

/**
 * Ф4 (G5): сторно проведённого складского документа. Создаёт авто-документ того же типа
 * с docNo «СТОРНО-<номер>» и зеркальными движениями (`reversal_<type>`, direction наоборот)
 * по фактическим строкам РЕГИСТРА исходного документа — не по строкам документа, чтобы
 * сторнировалось ровно то, что реально легло в регистр при проведении. Балансы двигаются
 * обратно с запретом ухода в минус (сторно прихода, который уже израсходован, блокируется).
 * Исходный документ остаётся posted (история регистра неизменна) и помечается reversedBy*
 * в payload; повторное сторно и сторно самого сторно запрещены.
 */
export async function reverseWarehouseDocument(args: {
  documentId: string;
  actor: Actor;
  expectedUpdatedAt?: number;
}): Promise<Result<{ id: string; docNo: string }>> {
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
    if (String(header.status) !== 'posted') return { ok: false, error: 'Сторнировать можно только проведенный документ' };
    const headerPayload = parseWarehouseHeaderPayload(header.payloadJson);
    if (headerPayload.reversedByDocumentId) {
      return { ok: false, error: `Документ уже сторнирован${headerPayload.reversedByDocNo ? ` (№ ${headerPayload.reversedByDocNo})` : ''}` };
    }
    if (headerPayload.reversalOfId) {
      return { ok: false, error: 'Сторно-документ нельзя сторнировать — при необходимости создайте исходный документ заново' };
    }

    const movements = await db.select().from(erpRegStockMovements).where(eq(erpRegStockMovements.documentHeaderId, args.documentId));
    if (movements.length === 0) return { ok: false, error: 'У документа нет движений по регистру — сторнировать нечего' };

    // Обратные дельты по балансам; уход в минус запрещён (классический учётный инвариант).
    const balanceByKey = new Map<string, { id: string; qty: number; reservedQty: number; locationId: string; nomenclatureId: string }>();
    for (const m of movements) {
      const locationId = m.warehouseLocationId ? String(m.warehouseLocationId) : '';
      if (!locationId) return { ok: false, error: 'У движения исходного документа не указан склад — сторно невозможно' };
      const nomenclatureId = String(m.nomenclatureId);
      const key = `${nomenclatureId}::${locationId}`;
      if (balanceByKey.has(key)) continue;
      const balanceRows = await db
        .select()
        .from(erpRegStockBalance)
        .where(and(eq(erpRegStockBalance.nomenclatureId, nomenclatureId as any), eq(erpRegStockBalance.warehouseLocationId, locationId as any)))
        .limit(1);
      const balance = balanceRows[0];
      balanceByKey.set(key, {
        id: balance?.id ? String(balance.id) : randomUUID(),
        qty: Number(balance?.qty ?? 0),
        reservedQty: Number(balance?.reservedQty ?? 0),
        locationId,
        nomenclatureId,
      });
    }
    for (const m of movements) {
      const key = `${String(m.nomenclatureId)}::${String(m.warehouseLocationId)}`;
      const current = balanceByKey.get(key)!;
      const inverseDelta = String(m.direction) === 'in' ? -Number(m.qty) : Number(m.qty);
      const nextQty = current.qty + inverseDelta;
      if (nextQty < 0) {
        return {
          ok: false,
          error: `Недостаточно остатка для сторно (номенклатура ${String(m.nomenclatureId)}): приход уже израсходован. Оформите корректирующий документ.`,
        };
      }
      current.qty = nextQty;
    }

    // Номер сторно-документа: «СТОРНО-<номер>»; doc_no уникален — при коллизии добавляем суффикс.
    let reversalDocNo = `СТОРНО-${String(header.docNo)}`;
    const docNoTaken = async (docNo: string) =>
      (await db.select({ id: erpDocumentHeaders.id }).from(erpDocumentHeaders).where(eq(erpDocumentHeaders.docNo, docNo)).limit(1)).length > 0;
    if (await docNoTaken(reversalDocNo)) reversalDocNo = `СТОРНО-${String(header.docNo)}-${String(ts).slice(-5)}`;

    const reversalId = randomUUID();
    const originalLines = await db
      .select()
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.documentId), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));
    const reversalPayloadObj = parseJsonObject(header.payloadJson ?? null);
    delete reversalPayloadObj.reversedByDocumentId;
    delete reversalPayloadObj.reversedByDocNo;
    delete reversalPayloadObj.reversedAt;
    reversalPayloadObj.reason = `Сторно документа ${String(header.docNo)}`;
    reversalPayloadObj.reversalOfId = args.documentId;
    reversalPayloadObj.reversalOfDocNo = String(header.docNo);

    await db.transaction(async (tx) => {
      await tx.insert(erpDocumentHeaders).values({
        id: reversalId,
        docType: String(header.docType),
        docNo: reversalDocNo,
        docDate: ts,
        status: 'posted',
        authorId: null,
        departmentId: header.departmentId ?? null,
        payloadJson: JSON.stringify(reversalPayloadObj),
        createdAt: ts,
        updatedAt: ts,
        postedAt: ts,
        deletedAt: null,
      });
      if (originalLines.length > 0) {
        await tx.insert(erpDocumentLines).values(
          originalLines.map((line) => ({
            id: randomUUID(),
            headerId: reversalId,
            lineNo: Number(line.lineNo),
            partCardId: line.partCardId ?? null,
            nomenclatureId: line.nomenclatureId ?? null,
            qty: Number(line.qty ?? 0),
            price: line.price ?? null,
            payloadJson: line.payloadJson ?? null,
            createdAt: ts,
            updatedAt: ts,
            deletedAt: null,
          })),
        );
      }

      for (const [, current] of balanceByKey) {
        const existing = await tx.select({ id: erpRegStockBalance.id }).from(erpRegStockBalance).where(eq(erpRegStockBalance.id, current.id as any)).limit(1);
        if (existing[0]) {
          await tx.update(erpRegStockBalance).set({ qty: current.qty, reservedQty: current.reservedQty, updatedAt: ts }).where(eq(erpRegStockBalance.id, current.id as any));
        } else {
          await tx.insert(erpRegStockBalance).values({
            id: current.id,
            nomenclatureId: current.nomenclatureId,
            partCardId: null,
            warehouseLocationId: current.locationId,
            qty: current.qty,
            reservedQty: current.reservedQty,
            updatedAt: ts,
          });
        }
      }

      for (const m of movements) {
        const movementId = randomUUID();
        const inverseDirection = String(m.direction) === 'in' ? 'out' : 'in';
        const movementType = reversalMovementType(String(m.movementType));
        let prevHash: string | null = null;
        let selfHash: string | null = null;
        if (HASHCHAIN_ENABLED) {
          const lastChainRow = await tx
            .select({ selfHash: erpRegStockMovements.selfHash })
            .from(erpRegStockMovements)
            .where(isNotNull(erpRegStockMovements.selfHash))
            .orderBy(desc(erpRegStockMovements.performedAt), desc(erpRegStockMovements.createdAt), desc(erpRegStockMovements.id))
            .limit(1);
          prevHash = lastChainRow[0]?.selfHash ?? null;
          const canonical = JSON.stringify({
            id: movementId,
            nomenclatureId: String(m.nomenclatureId),
            warehouseId: String(m.warehouseLocationId),
            documentHeaderId: reversalId,
            movementType,
            qty: Number(m.qty),
            direction: inverseDirection,
            engineId: m.engineId ?? null,
            counterpartyId: m.counterpartyId ?? null,
            reason: `Сторно ${String(header.docNo)}`,
            performedAt: ts,
            performedBy: args.actor.username,
            prevHash,
          });
          selfHash = createHash('sha256').update(canonical).digest('hex');
        }
        await tx.insert(erpRegStockMovements).values({
          id: movementId,
          nomenclatureId: String(m.nomenclatureId),
          warehouseLocationId: m.warehouseLocationId ?? null,
          documentHeaderId: reversalId,
          movementType,
          qty: Number(m.qty),
          direction: inverseDirection,
          engineId: m.engineId ?? null,
          counterpartyId: m.counterpartyId ?? null,
          reason: `Сторно ${String(header.docNo)}`,
          performedAt: ts,
          performedBy: args.actor.username,
          prevHash,
          selfHash,
          createdAt: ts,
        });
      }

      // Пометка исходного: остаётся posted, но получает reversedBy* и событие в журнале.
      const originalPayloadObj = parseJsonObject(header.payloadJson ?? null);
      originalPayloadObj.reversedByDocumentId = reversalId;
      originalPayloadObj.reversedByDocNo = reversalDocNo;
      originalPayloadObj.reversedAt = ts;
      await tx
        .update(erpDocumentHeaders)
        .set({ payloadJson: JSON.stringify(originalPayloadObj), updatedAt: ts })
        .where(eq(erpDocumentHeaders.id, args.documentId));

      await tx.insert(erpJournalDocuments).values([
        {
          id: randomUUID(),
          documentHeaderId: reversalId,
          eventType: 'posted',
          eventPayloadJson: JSON.stringify({ by: args.actor.username, reversalOf: String(header.docNo) }),
          eventAt: ts,
        },
        {
          id: randomUUID(),
          documentHeaderId: args.documentId,
          eventType: 'reversed',
          eventPayloadJson: JSON.stringify({ by: args.actor.username, reversalDocumentId: reversalId, reversalDocNo }),
          eventAt: ts,
        },
      ]);
    });

    // Ledger — после коммита, как при обычном проведении.
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
          warehouse_location_id: balance.warehouseLocationId ?? null,
          qty: Number(balance.qty),
          reserved_qty: Number(balance.reservedQty ?? 0),
          updated_at: Number(balance.updatedAt),
        },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      });
    }
    const reversalMovementRows = await db.select().from(erpRegStockMovements).where(eq(erpRegStockMovements.documentHeaderId, reversalId));
    for (const movement of reversalMovementRows) {
      ledgerPayloads.push({
        type: 'upsert',
        table: LedgerTableName.ErpRegStockMovements,
        row_id: String(movement.id),
        row: {
          id: String(movement.id),
          nomenclature_id: String(movement.nomenclatureId),
          warehouse_location_id: movement.warehouseLocationId ?? null,
          document_header_id: movement.documentHeaderId,
          movement_type: String(movement.movementType),
          qty: Number(movement.qty),
          direction: String(movement.direction),
          engine_id: movement.engineId,
          counterparty_id: movement.counterpartyId,
          reason: movement.reason,
          performed_at: Number(movement.performedAt),
          performed_by: movement.performedBy,
          prev_hash: movement.prevHash,
          self_hash: movement.selfHash,
          created_at: Number(movement.createdAt),
        },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      });
    }
    if (ledgerPayloads.length > 0) signAndAppendDetailed(ledgerPayloads);

    return { ok: true, id: reversalId, docNo: reversalDocNo };
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

/**
 * Зарезервировать детали черновика расхода `assembly_consumption`.
 *
 * Поведение: для каждой строки документа группируется (nomenclatureId, sourceWarehouseId)
 * и `reservedQty` соответствующей записи `erp_reg_stock_balance` инкрементируется на сумму
 * `qty` строк группы. Проверяется доступность `qty - reservedQty >= needed` — иначе error.
 *
 * Идемпотентность: флаг `reservedAt` в header.payloadJson. Повторный вызов на уже
 * зарезервированном документе → no-op с `alreadyReserved=true`.
 *
 * Используется в Stage 1 lifecycle: после `createWarehouseDocument` для assembly draft.
 */
export async function reserveAssemblyDraftReservation(args: {
  documentId: string;
  actor: Actor;
}): Promise<Result<{ id: string; reserved: boolean; alreadyReserved: boolean }>> {
  try {
    const ts = nowMs();
    const headerRows = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headerRows[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (String(header.docType) !== 'assembly_consumption') {
      return { ok: false, error: 'Резерв доступен только для документа assembly_consumption' };
    }
    if (String(header.status) !== 'draft') {
      return { ok: false, error: 'Резерв доступен только для черновика (status=draft)' };
    }
    const headerPayload = parseJsonObject(header.payloadJson ?? null);
    if (headerPayload['reservedAt'] != null) {
      return { ok: true, id: args.documentId, reserved: true, alreadyReserved: true };
    }

    const lines = await db
      .select(documentLineSelectFields())
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.documentId), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));

    const headerWorkshopWarehouseId = strField(headerPayload, 'workshopWarehouseId') ?? null;
    // Phase 2.4 PR 1: ключ резерва — warehouse_location_id (uuid). Payload может содержать
    // либо uuid (новый формат), либо legacy text-код ('default', 'workshop_3') — резолвим обе формы.
    type ReserveKey = { nomenclatureId: string; locationId: string };
    const grouped = new Map<string, ReserveKey & { qty: number; rawWarehouseId: string }>();
    for (const line of lines) {
      const qty = Math.max(0, Math.trunc(Number(line.qty ?? 0)));
      if (qty <= 0) continue;
      const linePayload = parseJsonObject(line.payloadJson ?? null);
      const nomenclatureId = strField(linePayload, 'nomenclatureId');
      if (!nomenclatureId) return { ok: false, error: `В строке ${line.lineNo} не задана номенклатура` };
      const sourceWarehouseId = strField(linePayload, 'sourceWarehouseId') ?? headerWorkshopWarehouseId;
      if (!sourceWarehouseId) return { ok: false, error: `В строке ${line.lineNo} не указан склад-источник` };
      const locationId = await resolveLocationIdFromPayloadValue(sourceWarehouseId);
      if (!locationId) {
        return { ok: false, error: `В строке ${line.lineNo} склад-источник не найден: ${sourceWarehouseId}` };
      }
      const key = `${nomenclatureId}::${locationId}`;
      const prev = grouped.get(key);
      if (prev) prev.qty += qty;
      else grouped.set(key, { nomenclatureId, locationId, qty, rawWarehouseId: sourceWarehouseId });
    }
    if (grouped.size === 0) {
      return { ok: false, error: 'В документе нет строк для резервирования' };
    }

    const balanceByKey = new Map<string, { id: string; qty: number; reservedQty: number; isNew: boolean }>();
    for (const group of grouped.values()) {
      const key = `${group.nomenclatureId}::${group.locationId}`;
      const rows = await db
        .select()
        .from(erpRegStockBalance)
        .where(and(eq(erpRegStockBalance.nomenclatureId, group.nomenclatureId), eq(erpRegStockBalance.warehouseLocationId, group.locationId)))
        .limit(1);
      const balance = rows[0];
      balanceByKey.set(key, {
        id: balance?.id ? String(balance.id) : randomUUID(),
        qty: Number(balance?.qty ?? 0),
        reservedQty: Number(balance?.reservedQty ?? 0),
        isNew: !balance,
      });
    }

    for (const group of grouped.values()) {
      const key = `${group.nomenclatureId}::${group.locationId}`;
      const current = balanceByKey.get(key);
      if (!current) return { ok: false, error: 'Ошибка подготовки баланса' };
      const available = current.qty - current.reservedQty;
      if (available < group.qty) {
        // Lazy lookup имени локации для UX-friendly error (только при ошибке).
        let locName: string = group.rawWarehouseId;
        const locRes = await listWarehouseLocations({ activeOnly: false });
        if (locRes.ok) {
          const found = locRes.rows.find((loc) => loc.id === group.locationId);
          if (found) locName = found.name;
        }
        return {
          ok: false,
          error: `Недостаточно деталей для резерва: ${group.nomenclatureId} на складе «${locName}» (нужно ${group.qty}, доступно ${available})`,
        };
      }
      current.reservedQty += group.qty;
    }

    for (const [, current] of balanceByKey) {
      if (current.isNew) {
        // Резерв на пустом балансе невозможен (available=0), но на всякий случай — пропускаем.
        continue;
      }
      await db
        .update(erpRegStockBalance)
        .set({ qty: current.qty, reservedQty: current.reservedQty, updatedAt: ts })
        .where(eq(erpRegStockBalance.id, current.id));
    }

    const nextPayload = { ...headerPayload, reservedAt: ts };
    await db
      .update(erpDocumentHeaders)
      .set({ payloadJson: JSON.stringify(nextPayload), updatedAt: ts })
      .where(eq(erpDocumentHeaders.id, args.documentId));
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: args.documentId,
      eventType: 'reserved',
      eventPayloadJson: JSON.stringify({ by: args.actor.username, groups: grouped.size }),
      eventAt: ts,
    });

    return { ok: true, id: args.documentId, reserved: true, alreadyReserved: false };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Снять резерв с черновика `assembly_consumption`. Декрементирует `reservedQty`
 * по тем же строкам и группам, что и `reserveAssemblyDraftReservation`.
 *
 * Идемпотентность: если флаг `reservedAt` отсутствует — no-op, `released=false`.
 */
export async function releaseAssemblyDraftReservation(args: {
  documentId: string;
  actor: Actor;
}): Promise<Result<{ id: string; released: boolean }>> {
  try {
    const ts = nowMs();
    const headerRows = await db
      .select()
      .from(erpDocumentHeaders)
      .where(and(eq(erpDocumentHeaders.id, args.documentId), isNull(erpDocumentHeaders.deletedAt)))
      .limit(1);
    const header = headerRows[0];
    if (!header) return { ok: false, error: 'Документ не найден' };
    if (String(header.docType) !== 'assembly_consumption') {
      return { ok: false, error: 'Снятие резерва доступно только для assembly_consumption' };
    }
    const headerPayload = parseJsonObject(header.payloadJson ?? null);
    if (headerPayload['reservedAt'] == null) {
      return { ok: true, id: args.documentId, released: false };
    }

    const lines = await db
      .select(documentLineSelectFields())
      .from(erpDocumentLines)
      .where(and(eq(erpDocumentLines.headerId, args.documentId), isNull(erpDocumentLines.deletedAt)))
      .orderBy(asc(erpDocumentLines.lineNo));

    const headerWorkshopWarehouseId = strField(headerPayload, 'workshopWarehouseId') ?? null;
    // Phase 2.4 PR 1: симметрично reserve — резолвим payload-значение в warehouse_location_id (uuid).
    const grouped = new Map<string, { nomenclatureId: string; locationId: string; qty: number }>();
    for (const line of lines) {
      const qty = Math.max(0, Math.trunc(Number(line.qty ?? 0)));
      if (qty <= 0) continue;
      const linePayload = parseJsonObject(line.payloadJson ?? null);
      const nomenclatureId = strField(linePayload, 'nomenclatureId');
      if (!nomenclatureId) continue;
      const sourceWarehouseId = strField(linePayload, 'sourceWarehouseId') ?? headerWorkshopWarehouseId;
      if (!sourceWarehouseId) continue;
      const locationId = await resolveLocationIdFromPayloadValue(sourceWarehouseId);
      if (!locationId) continue;
      const key = `${nomenclatureId}::${locationId}`;
      const prev = grouped.get(key);
      if (prev) prev.qty += qty;
      else grouped.set(key, { nomenclatureId, locationId, qty });
    }

    for (const group of grouped.values()) {
      const rows = await db
        .select()
        .from(erpRegStockBalance)
        .where(and(eq(erpRegStockBalance.nomenclatureId, group.nomenclatureId), eq(erpRegStockBalance.warehouseLocationId, group.locationId)))
        .limit(1);
      const balance = rows[0];
      if (!balance) continue;
      const currentReserved = Number(balance.reservedQty ?? 0);
      const nextReserved = Math.max(0, currentReserved - group.qty);
      await db
        .update(erpRegStockBalance)
        .set({ reservedQty: nextReserved, updatedAt: ts })
        .where(eq(erpRegStockBalance.id, balance.id));
    }

    const nextPayload = { ...headerPayload };
    delete nextPayload['reservedAt'];
    await db
      .update(erpDocumentHeaders)
      .set({ payloadJson: JSON.stringify(nextPayload), updatedAt: ts })
      .where(eq(erpDocumentHeaders.id, args.documentId));
    await db.insert(erpJournalDocuments).values({
      id: randomUUID(),
      documentHeaderId: args.documentId,
      eventType: 'released',
      eventPayloadJson: JSON.stringify({ by: args.actor.username, groups: grouped.size }),
      eventAt: ts,
    });

    return { ok: true, id: args.documentId, released: true };
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
    const headerDocType = String(header.docType);
    const headerModule = strField(headerPayload, 'module');
    const usePartsMovement = headerModule === PARTS_MOVEMENT_MODULE_MARKER;
    const headerEngineId = strField(headerPayload, 'engineId') ?? null;
    const headerWorkshopWarehouseId = strField(headerPayload, 'workshopWarehouseId') ?? null;
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
      const lineEngineId = strField(payload, 'engineId') ?? headerEngineId;

      // ─── Parts-movement module branches (new docType semantics) ───
      if (usePartsMovement && headerDocType === 'engine_dismantling') {
        if (qty <= 0) continue;
        const targetLocation = strField(payload, 'targetLocation') ?? WAREHOUSE_LOCATION_REPAIR_FUND;
        if (targetLocation !== WAREHOUSE_LOCATION_REPAIR_FUND && targetLocation !== WAREHOUSE_LOCATION_SCRAP) {
          return { ok: false, error: `В строке ${line.lineNo} некорректное назначение разборки: ${targetLocation}` };
        }
        const movementType =
          targetLocation === WAREHOUSE_LOCATION_SCRAP ? StockMovementType.DismantleScrapIn : StockMovementType.DismantleIn;
        planned.push({
          nomenclatureId,
          warehouseId: targetLocation,
          movementType,
          direction: 'in',
          qty,
          delta: qty,
          reason,
          counterpartyId,
          engineId: lineEngineId,
        });
      } else if (usePartsMovement && headerDocType === 'repair_recovery') {
        if (qty <= 0) continue;
        const targetWarehouseId =
          strField(payload, 'targetWarehouseId') ?? headerWorkshopWarehouseId ?? null;
        if (!targetWarehouseId || !isWorkshopWarehouseId(targetWarehouseId)) {
          return {
            ok: false,
            error: `В строке ${line.lineNo} склад цеха (target) не указан или не соответствует формату workshop_*`,
          };
        }
        planned.push({
          nomenclatureId,
          warehouseId: WAREHOUSE_LOCATION_REPAIR_FUND,
          movementType: StockMovementType.RepairOut,
          direction: 'out',
          qty,
          delta: -qty,
          reason,
          counterpartyId,
          engineId: lineEngineId,
        });
        planned.push({
          nomenclatureId,
          warehouseId: targetWarehouseId,
          movementType: StockMovementType.RepairIn,
          direction: 'in',
          qty,
          delta: qty,
          reason,
          counterpartyId,
          engineId: lineEngineId,
        });
      } else if (headerDocType === 'assembly_consumption') {
        if (qty <= 0) continue;
        const sourceWarehouseId =
          strField(payload, 'sourceWarehouseId') ?? headerWorkshopWarehouseId ?? null;
        if (!sourceWarehouseId) {
          return { ok: false, error: `В строке ${line.lineNo} не указан склад-источник списания в сборку` };
        }
        if (!lineEngineId) {
          return { ok: false, error: `Для списания в сборку обязательна привязка к двигателю (engineId в header или строке)` };
        }
        planned.push({
          nomenclatureId,
          warehouseId: sourceWarehouseId,
          movementType: StockMovementType.AssemblyConsumptionOut,
          direction: 'out',
          qty,
          delta: -qty,
          reason,
          counterpartyId,
          engineId: lineEngineId,
        });
        planned.push({
          nomenclatureId,
          warehouseId: WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS,
          movementType: StockMovementType.AssemblyConsumptionIn,
          direction: 'in',
          qty,
          delta: qty,
          reason,
          counterpartyId,
          engineId: lineEngineId,
        });
      } else if (headerDocType === 'assembly_return') {
        if (qty <= 0) continue;
        const mode = strField(payload, 'returnMode') ?? strField(headerPayload, 'returnMode');
        if (mode !== AssemblyReturnMode.Rework && mode !== AssemblyReturnMode.Scrap) {
          return {
            ok: false,
            error: `В строке ${line.lineNo} некорректный режим возврата: '${mode ?? ''}' (ожидается 'rework' или 'scrap')`,
          };
        }
        if (!lineEngineId) {
          return { ok: false, error: `Для возврата из сборки обязательна привязка к двигателю` };
        }
        const targetWarehouseId =
          mode === AssemblyReturnMode.Rework ? WAREHOUSE_LOCATION_REPAIR_FUND : WAREHOUSE_LOCATION_SCRAP;
        const inMovementType =
          mode === AssemblyReturnMode.Rework
            ? StockMovementType.AssemblyReturnInRework
            : StockMovementType.AssemblyReturnInScrap;
        planned.push({
          nomenclatureId,
          warehouseId: WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS,
          movementType: StockMovementType.AssemblyReturnOut,
          direction: 'out',
          qty,
          delta: -qty,
          reason,
          counterpartyId,
          engineId: lineEngineId,
        });
        planned.push({
          nomenclatureId,
          warehouseId: targetWarehouseId,
          movementType: inMovementType,
          direction: 'in',
          qty,
          delta: qty,
          reason,
          counterpartyId,
          engineId: lineEngineId,
        });
      } else if (headerDocType === 'stock_receipt' || isIncomingDocType(headerDocType)) {
        if (qty <= 0) continue;
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'receipt', direction: 'in', qty, delta: qty, reason, counterpartyId });
      } else if (String(header.docType) === 'stock_issue') {
        if (qty <= 0) continue;
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'issue', direction: 'out', qty, delta: -qty, reason, counterpartyId, engineId: lineEngineId });
      } else if (String(header.docType) === 'stock_writeoff') {
        if (qty <= 0) continue;
        const warehouseId = strField(payload, 'warehouseId') ?? strField(headerPayload, 'warehouseId') ?? 'default';
        planned.push({ nomenclatureId, warehouseId, movementType: 'writeoff', direction: 'out', qty, delta: -qty, reason, counterpartyId, engineId: lineEngineId });
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

    // Phase 2.4 PR 1: при проводке резолвим каждый warehouseId-string из planned в warehouse_location_id (uuid).
    // Lookup и balance WHERE eq дальше идут по uuid. Legacy warehouseId-code пока остаётся в movement.warehouseId
    // (нужно для INSERT в NOT NULL колонку и backward-compat ledger payload — будет дропнуто в PR 3).
    const locationIdByWarehouseId = new Map<string, string>();
    for (const movement of planned) {
      if (locationIdByWarehouseId.has(movement.warehouseId)) continue;
      const locationId = await resolveLocationIdFromPayloadValue(movement.warehouseId);
      if (!locationId) {
        return { ok: false, error: `Склад не найден: ${movement.warehouseId}` };
      }
      locationIdByWarehouseId.set(movement.warehouseId, locationId);
    }

    const balanceByKey = new Map<string, { id: string; qty: number; reservedQty: number; locationId: string }>();
    for (const movement of planned) {
      const locationId = locationIdByWarehouseId.get(movement.warehouseId)!;
      const key = `${movement.nomenclatureId}::${locationId}`;
      if (balanceByKey.has(key)) continue;
      const balanceRows = await db
        .select()
        .from(erpRegStockBalance)
        .where(and(eq(erpRegStockBalance.nomenclatureId, movement.nomenclatureId), eq(erpRegStockBalance.warehouseLocationId, locationId)))
        .limit(1);
      const balance = balanceRows[0];
      balanceByKey.set(key, {
        id: balance?.id ? String(balance.id) : randomUUID(),
        qty: Number(balance?.qty ?? 0),
        reservedQty: Number(balance?.reservedQty ?? 0),
        locationId,
      });
    }

    for (const movement of planned) {
      const locationId = locationIdByWarehouseId.get(movement.warehouseId)!;
      const key = `${movement.nomenclatureId}::${locationId}`;
      const current = balanceByKey.get(key);
      if (!current) return { ok: false, error: 'Ошибка подготовки баланса' };
      const nextQty = current.qty + movement.delta;
      if (nextQty < 0) return { ok: false, error: `Недостаточно остатка для ${movement.nomenclatureId} на складе ${movement.warehouseId}` };
      current.qty = nextQty;
    }

    for (const movement of planned) {
      const locationId = locationIdByWarehouseId.get(movement.warehouseId)!;
      const key = `${movement.nomenclatureId}::${locationId}`;
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
          warehouseLocationId: locationId,
          qty: current.qty,
          reservedQty: current.reservedQty,
          updatedAt: ts,
        });
      }
      const movementId = randomUUID();
      let prevHash: string | null = null;
      let selfHash: string | null = null;
      if (HASHCHAIN_ENABLED) {
        const lastChainRow = await db
          .select({ selfHash: erpRegStockMovements.selfHash })
          .from(erpRegStockMovements)
          .where(isNotNull(erpRegStockMovements.selfHash))
          .orderBy(desc(erpRegStockMovements.performedAt), desc(erpRegStockMovements.createdAt), desc(erpRegStockMovements.id))
          .limit(1);
        prevHash = lastChainRow[0]?.selfHash ?? null;
        const canonical = JSON.stringify({
          id: movementId,
          nomenclatureId: movement.nomenclatureId,
          warehouseId: movement.warehouseId,
          documentHeaderId: args.documentId,
          movementType: movement.movementType,
          qty: movement.qty,
          direction: movement.direction,
          engineId: movement.engineId ?? null,
          counterpartyId: movement.counterpartyId ?? null,
          reason: movement.reason ?? null,
          performedAt: ts,
          performedBy: args.actor.username,
          prevHash,
        });
        selfHash = createHash('sha256').update(canonical).digest('hex');
      }
      const movementLocationId = locationIdByWarehouseId.get(movement.warehouseId)!;
      await db.insert(erpRegStockMovements).values({
        id: movementId,
        nomenclatureId: movement.nomenclatureId,
        warehouseLocationId: movementLocationId,
        documentHeaderId: args.documentId,
        movementType: movement.movementType,
        qty: movement.qty,
        direction: movement.direction,
        engineId: movement.engineId ?? null,
        counterpartyId: movement.counterpartyId,
        reason: movement.reason,
        performedAt: ts,
        performedBy: args.actor.username,
        prevHash,
        selfHash,
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
          warehouse_location_id: balance.warehouseLocationId ?? null,
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
          warehouse_location_id: movement.warehouseLocationId ?? null,
          document_header_id: movement.documentHeaderId,
          movement_type: String(movement.movementType),
          qty: Number(movement.qty),
          direction: String(movement.direction),
          engine_id: movement.engineId,
          counterparty_id: movement.counterpartyId,
          reason: movement.reason,
          performed_at: Number(movement.performedAt),
          performed_by: movement.performedBy,
          prev_hash: movement.prevHash,
          self_hash: movement.selfHash,
          created_at: Number(movement.createdAt),
        },
        actor: { userId: args.actor.id, username: args.actor.username, role: args.actor.role ?? 'user' },
        ts,
      });
    }
    if (ledgerPayloads.length > 0) signAndAppendDetailed(ledgerPayloads);

    // Engine phase transitions (Stage 2): only when the document is a parts-movement v1 document
    // tied to a specific engine_id via header payload. Failures are logged but never block posting.
    if (usePartsMovement && headerEngineId) {
      let nextPhase: EnginePhase | null = null;
      if (headerDocType === 'engine_dismantling') nextPhase = EnginePhase.Disassembled;
      if (headerDocType === 'assembly_consumption') nextPhase = EnginePhase.InAssembly;
      if (nextPhase) {
        const phaseResult = await setEnginePhase({
          engineId: headerEngineId,
          phase: nextPhase,
          actor: { id: args.actor.id, username: args.actor.username },
          reasonDocumentId: args.documentId,
        });
        if (!phaseResult.ok) {
          console.warn('[warehouseService] engine_phase transition skipped:', phaseResult.error);
        }
      }
    }
    return { ok: true, id: args.documentId, posted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Что сейчас числится «в сборке» по конкретному двигателю, по номенклатуре.
 * Нетто = Σ(assembly_consumption_in) − Σ(assembly_return_out) в локации assembly_in_progress
 * для этого engineId (считаем по знаку direction, не по типу — так устойчивее к новым типам).
 * Питает диалог «Возврат из сборки»: кнопку «Заполнить из сборки» и мягкую проверку «не вернуть
 * больше, чем списано». Возвращает только позиции с положительным остатком.
 */
export async function getEngineAssemblyInProgress(
  engineId: string,
): Promise<Result<{ rows: Array<{ nomenclatureId: string; name: string | null; code: string | null; qty: number }> }>> {
  try {
    if (!engineId) return { ok: false, error: 'engineId обязателен' };
    const refs = await listWarehouseReferenceData();
    const assemblyLocId = refs.warehouseCodeToLocationId.get(WAREHOUSE_LOCATION_ASSEMBLY_IN_PROGRESS);
    if (!assemblyLocId) return { ok: true, rows: [] };
    const rows = await db
      .select()
      .from(erpRegStockMovements)
      .where(
        and(
          eq(erpRegStockMovements.engineId, engineId),
          eq(erpRegStockMovements.warehouseLocationId, assemblyLocId),
        ),
      );
    const netByNomenclature = new Map<string, number>();
    for (const row of rows) {
      const nomenclatureId = String(row.nomenclatureId ?? '');
      if (!nomenclatureId) continue;
      const qty = Number(row.qty ?? 0) || 0;
      const signed = String(row.direction) === 'in' ? qty : -qty;
      netByNomenclature.set(nomenclatureId, (netByNomenclature.get(nomenclatureId) ?? 0) + signed);
    }
    const positiveIds = Array.from(netByNomenclature.entries())
      .filter(([, net]) => net > 0)
      .map(([id]) => id);
    if (positiveIds.length === 0) return { ok: true, rows: [] };
    const nomenclatureRows = await db
      .select()
      .from(erpNomenclature)
      .where(and(inArray(erpNomenclature.id, positiveIds as any), isNull(erpNomenclature.deletedAt)));
    const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
    const result = positiveIds
      .map((nomenclatureId) => {
        const nomenclature = nomenclatureById.get(nomenclatureId);
        return {
          nomenclatureId,
          name: (nomenclature?.name as string | null) ?? null,
          code: (nomenclature?.code as string | null) ?? null,
          qty: Math.trunc(netByNomenclature.get(nomenclatureId) ?? 0),
        };
      })
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'ru'));
    return { ok: true, rows: result };
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
    // Frontend passes the row's warehouseId (a code after listWarehouseStock); resolve to uuid.
    const targetLocationId = args?.warehouseId
      ? (refs.warehouseCodeToLocationId.get(String(args.warehouseId)) ?? String(args.warehouseId))
      : undefined;
    const filtered = rows.filter((row) => {
      if (args?.nomenclatureId && String(row.nomenclatureId) !== String(args.nomenclatureId)) return false;
      if (targetLocationId && String(row.warehouseLocationId ?? '') !== targetLocationId) return false;
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
        const locId = String(row.warehouseLocationId ?? '');
        const whOpt = refs.warehouseByLocationId.get(locId);
        return {
          ...row,
          // Expose CODE (not the uuid) to match the picker / stock list surface.
          warehouseId: whOpt?.code ?? locId,
          warehouseName: whOpt?.label ?? null,
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
