import { existsSync, readFileSync } from 'node:fs';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AttributeDataType, EntityTypeCode } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import type { AuthUser } from '../auth/jwt.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';
import { createEntity, setEntityAttribute, softDeleteEntity, upsertAttributeDef, upsertEntityType } from '../services/adminMasterdataService.js';
import { createPart, listParts, updatePartAttribute } from '../services/partsService.js';
import { getRepairChecklistForEngine, listRepairChecklistTemplates, saveRepairChecklistForEngine } from '../services/checklistService.js';

type DesiredBrand = { key: string; name: string };
type DesiredEngine = {
  engineNumber: string;
  brandKey: string;
  brandName: string;
  arrivalDate: number | null;
  shippingDate: number | null;
  supplierName?: string;
};
type DesiredPart = {
  key: string;
  name: string;
  assemblyUnitNumber: string | null;
  qtyByBrandKey: Map<string, number>;
};

type ParsedCsvData = {
  brands: Map<string, DesiredBrand>;
  parts: Map<string, DesiredPart>;
  engines: Map<string, DesiredEngine>;
  suppliersByNormalized: Map<string, string>;
  supplierConflictsByEngine: Map<string, string[]>;
};

const SOURCE_FILE = process.env.MATRICA_COMPLETENESS_CSV ?? '/home/valstan/Сводная ведомость актов комплектности2.csv';
const IMPORT_ALLOW_SYNC_CONFLICTS = (() => {
  const raw = process.env.MATRICA_IMPORT_ALLOW_SYNC_CONFLICTS?.toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'off'].includes(raw);
})();

function nowMs() {
  return Date.now();
}

function logStage(stage: string, payload?: Record<string, unknown>) {
  const row = payload ? { stage, ...payload } : { stage };
  console.log(`[csv-sync] ${JSON.stringify(row)}`);
}

function cleanCell(value: string): string {
  return String(value ?? '')
    .replaceAll('\ufeff', '')
    .replaceAll('\u00a0', ' ')
    .replaceAll('\r', '')
    .replaceAll('\n', ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function normalizeToken(value: string): string {
  return cleanCell(value)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/[^a-z0-9а-я]+/gi, '');
}

function normalizeHeaderToken(value: string): string {
  return cleanCell(value).toLowerCase().replaceAll('ё', 'е');
}

function normalizeCounterparty(value: string): string {
  return cleanCell(value)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function engineAttributeEquals(expected: unknown, actual: unknown): boolean {
  if (expected == null) return actual == null;
  if (actual == null) return false;
  if (typeof expected === 'number') return Number(actual) === expected;
  if (typeof expected === 'boolean') return actual === expected;
  return String(actual) === String(expected);
}

function areDefectRowsEqual(existingPayload: unknown, rows: Array<{ part_name: string; part_number: string; quantity: number; repairable_qty: number; scrap_qty: number }>): boolean {
  if (!existingPayload || typeof existingPayload !== 'object') return false;
  const payload = existingPayload as Record<string, unknown>;
  const answers = payload.answers;
  if (!answers || typeof answers !== 'object') return false;
  const nextRows = answers as Record<string, unknown>;
  return JSON.stringify(nextRows.defect_items ?? null) === JSON.stringify(rows);
}

function areCompletenessRowsEqual(
  existingPayload: unknown,
  rows: Array<{ part_name: string; assembly_unit_number: string; quantity: number; present: boolean; actual_qty: number }>,
): boolean {
  if (!existingPayload || typeof existingPayload !== 'object') return false;
  const payload = existingPayload as Record<string, unknown>;
  const answers = payload.answers;
  if (!answers || typeof answers !== 'object') return false;
  const nextRows = answers as Record<string, unknown>;
  return JSON.stringify(nextRows.completeness_items ?? null) === JSON.stringify(rows);
}

function areChecklistMetaEqual(existingPayload: unknown, engineBrand: string, engineNumber: string): boolean {
  if (!existingPayload || typeof existingPayload !== 'object') return false;
  const answers = (existingPayload as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object') return false;
  const mapped = answers as Record<string, unknown>;
  const brand = mapped.engine_brand;
  const number = mapped.engine_number;
  if (!brand || !number || typeof brand !== 'object' || typeof number !== 'object') return false;
  const brandValue = (brand as Record<string, unknown>).value;
  const numberValue = (number as Record<string, unknown>).value;
  return String(brandValue) === String(engineBrand) && String(numberValue) === String(engineNumber);
}

function parseDelimitedLine(line: string, delimiter: ';' | '\t'): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      out.push(cleanCell(cur));
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cleanCell(cur));
  return out;
}

function detectDelimiter(line: string): ';' | '\t' {
  const semicolonCount = (line.match(/;/g) ?? []).length;
  const tabCount = (line.match(/\t/g) ?? []).length;
  return semicolonCount >= tabCount ? ';' : '\t';
}

function normalizeBrandKey(value: string): string {
  const base = cleanCell(value)
    .toUpperCase()
    .replaceAll('Ё', 'Е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/[^0-9A-ZА-Я]+/g, '');
  if (base === 'В59У') return 'В59УМС';
  if (base === 'В462С1') return 'В462С1';
  return base;
}

function canonicalBrandName(raw: string, brandKey: string): string {
  const known: Record<string, string> = {
    В59УМС: 'В-59 УМС',
    В84: 'В-84',
    В84АМС: 'В-84 АМС',
    В84ДТ: 'В-84 ДТ',
    В84МБ1С: 'В-84 МБ-1С',
    В465С: 'В-46-5С',
    В462С1: 'В-46-2С1',
    В461: 'В-46-1',
    В46: 'В-46',
  };
  return known[brandKey] ?? cleanCell(raw).toUpperCase();
}

function normalizeEngineNumber(raw: string): string {
  return cleanCell(raw).replace(/\s*\(\d{4}\s*г\)\s*$/i, '').trim();
}

function parseDateMs(raw: string): number | null {
  const v = cleanCell(raw);
  if (!v) return null;
  const m = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (!dd || !mm || !yyyy) return null;
  const dt = new Date(yyyy, mm - 1, dd, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isServiceHeader(header: string): boolean {
  const h = normalizeHeaderToken(header);
  if (!h) return true;
  const ignored = ['дата прихода', 'дата отгрузки', 'поставщик', 'марка дв', 'договор', 'номер двигателя'];
  return ignored.some((x) => h.startsWith(x));
}

function parseNumericQty(value: string): number {
  const v = cleanCell(value);
  if (!v) return 0;
  if (!/^\d+(?:[.,]\d+)?$/.test(v)) return 0;
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function stripQtySuffix(name: string): string {
  return cleanCell(name).replace(/,\s*\d+\s*шт\.?\s*$/i, '').trim();
}

function parsePartDescriptor(rawHeader: string): { name: string; assemblyUnitNumber: string | null } | null {
  const source = cleanCell(rawHeader);
  if (!source) return null;
  let name = source;
  let assemblyUnitNumber: string | null = null;

  const lead = source.match(/^((?:Сб\.?\s*)?[0-9][0-9A-Za-zА-Яа-я./,\- ]{3,60})\s+([А-ЯA-ZЁ].+)$/i);
  if (lead?.[1] && lead[2]) {
    assemblyUnitNumber = cleanCell(lead[1]).replace(/,$/, '');
    name = cleanCell(lead[2]);
  }

  name = stripQtySuffix(name);
  if (!name) return null;
  return { name, assemblyUnitNumber: assemblyUnitNumber || null };
}

function partKey(name: string, assemblyUnitNumber: string | null): string {
  return `${normalizeToken(name)}|${normalizeToken(assemblyUnitNumber ?? '')}`;
}

function readCsvText(path: string): string {
  const bytes = readFileSync(path);
  try {
    return new TextDecoder('windows-1251').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function parseSourceCsv(path: string): ParsedCsvData {
  if (!existsSync(path)) throw new Error(`CSV not found: ${path}`);
  const text = readCsvText(path);
  const lines = text.split(/\r?\n/);
  const headerLineIndex = lines.findIndex((line) => {
    const h = normalizeHeaderToken(line);
    return h.includes('марка дв') && h.includes('номер двигателя');
  });
  if (headerLineIndex < 0) throw new Error('CSV header row not found');

  const headerLine = lines[headerLineIndex] ?? '';
  const delimiter = detectDelimiter(headerLine);
  const headerCells = parseDelimitedLine(headerLine, delimiter);

  const arrivalCol = headerCells.findIndex((h) => normalizeHeaderToken(h).includes('дата прихода'));
  const shippingCol = headerCells.findIndex((h) => normalizeHeaderToken(h).includes('дата отгрузки'));
  const brandCol = headerCells.findIndex((h) => normalizeHeaderToken(h).includes('марка дв'));
  const engineNoCol = headerCells.findIndex((h) => normalizeHeaderToken(h).includes('номер двигателя'));
  const supplierCol = headerCells.findIndex((h) => normalizeHeaderToken(h).includes('поставщик'));
  if (brandCol < 0 || engineNoCol < 0) throw new Error('Required columns not found: "Марка дв"/"Номер двигателя"');

  const partCols: number[] = [];
  for (let i = engineNoCol + 1; i < headerCells.length; i += 1) {
    const h = headerCells[i] ?? '';
    if (isServiceHeader(h)) continue;
    partCols.push(i);
  }
  if (partCols.length === 0) throw new Error('No part columns detected');

  const brands = new Map<string, DesiredBrand>();
  const parts = new Map<string, DesiredPart>();
  const engines = new Map<string, DesiredEngine>();
  const suppliersByNormalized = new Map<string, string>();
  const supplierConflictsByEngine = new Map<string, string[]>();

  for (let i = headerLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim()) continue;
    const row = parseDelimitedLine(line, delimiter);
    if (row.every((x) => !x)) continue;

    const brandRaw = cleanCell(row[brandCol] ?? '');
    const engineRaw = cleanCell(row[engineNoCol] ?? '');
    const supplierRaw = supplierCol >= 0 ? cleanCell(row[supplierCol] ?? '') : '';
    const supplierNorm = normalizeCounterparty(supplierRaw);
    if (!brandRaw || !engineRaw) continue;

    const brandKey = normalizeBrandKey(brandRaw);
    if (!brandKey) continue;
    const brandName = canonicalBrandName(brandRaw, brandKey);
    if (!brands.has(brandKey)) {
      brands.set(brandKey, { key: brandKey, name: brandName });
    }

    const engineNumber = normalizeEngineNumber(engineRaw);
    if (engineNumber) {
      const existing = engines.get(engineNumber);
      if (!existing) {
        engines.set(engineNumber, {
          engineNumber,
          brandKey,
          brandName,
          supplierName: supplierRaw,
          arrivalDate: arrivalCol >= 0 ? parseDateMs(row[arrivalCol] ?? '') : null,
          shippingDate: shippingCol >= 0 ? parseDateMs(row[shippingCol] ?? '') : null,
        });
      } else {
        const existingSupplierNorm = normalizeCounterparty(existing.supplierName ?? '');
        if (!existingSupplierNorm && supplierNorm) {
          existing.supplierName = supplierRaw;
        } else if (supplierNorm && existingSupplierNorm && existingSupplierNorm !== supplierNorm) {
          const conflicts = supplierConflictsByEngine.get(engineNumber) ?? [];
          if (existing.supplierName && !conflicts.includes(existing.supplierName)) conflicts.push(existing.supplierName);
          if (!conflicts.includes(supplierRaw)) conflicts.push(supplierRaw);
          supplierConflictsByEngine.set(engineNumber, conflicts);
        }
      }
      if (supplierNorm && !suppliersByNormalized.has(supplierNorm)) {
        suppliersByNormalized.set(supplierNorm, supplierRaw);
      }
    }

    for (const col of partCols) {
      const qty = parseNumericQty(row[col] ?? '');
      if (qty <= 0) continue;
      const parsed = parsePartDescriptor(headerCells[col] ?? '');
      if (!parsed) continue;
      const key = partKey(parsed.name, parsed.assemblyUnitNumber);
      const cur = parts.get(key);
      if (!cur) {
        const qtyByBrandKey = new Map<string, number>();
        qtyByBrandKey.set(brandKey, qty);
        parts.set(key, {
          key,
          name: parsed.name,
          assemblyUnitNumber: parsed.assemblyUnitNumber,
          qtyByBrandKey,
        });
      } else {
        const prev = cur.qtyByBrandKey.get(brandKey) ?? 0;
        if (qty > prev) cur.qtyByBrandKey.set(brandKey, qty); // MAX strategy
      }
    }
  }

  return { brands, parts, engines, suppliersByNormalized, supplierConflictsByEngine };
}

async function ensureActor(): Promise<AuthUser> {
  const superadminId = await getSuperadminUserId();
  if (!superadminId) throw new Error('Superadmin user not found');
  return { id: superadminId, username: 'superadmin', role: 'superadmin' };
}

async function ensureBrandInfra(actor: AuthUser) {
  const type = await upsertEntityType(actor, { code: EntityTypeCode.EngineBrand, name: 'Марка двигателя' });
  if (!type.ok || !type.id) throw new Error('Failed to upsert engine_brand type');
  await upsertAttributeDef(actor, {
    entityTypeId: type.id,
    code: 'name',
    name: 'Название',
    dataType: AttributeDataType.Text,
    sortOrder: 10,
  });
  return type.id;
}

async function ensureEngineInfra(actor: AuthUser) {
  const type = await upsertEntityType(actor, { code: EntityTypeCode.Engine, name: 'Двигатель' });
  if (!type.ok || !type.id) throw new Error('Failed to upsert engine type');
  await upsertAttributeDef(actor, { entityTypeId: type.id, code: 'engine_number', name: 'Номер двигателя', dataType: AttributeDataType.Text, sortOrder: 10 });
  await upsertAttributeDef(actor, { entityTypeId: type.id, code: 'engine_brand', name: 'Марка двигателя', dataType: AttributeDataType.Text, sortOrder: 20 });
  await upsertAttributeDef(actor, {
    entityTypeId: type.id,
    code: 'engine_brand_id',
    name: 'Марка двигателя (справочник)',
    dataType: AttributeDataType.Link,
    sortOrder: 25,
    metaJson: JSON.stringify({ linkTargetTypeCode: EntityTypeCode.EngineBrand }),
  });
  await upsertAttributeDef(actor, {
    entityTypeId: type.id,
    code: 'customer_id',
    name: 'Контрагент',
    dataType: AttributeDataType.Link,
    sortOrder: 45,
    metaJson: JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Customer }),
  });
  await upsertAttributeDef(actor, { entityTypeId: type.id, code: 'arrival_date', name: 'Дата прихода', dataType: AttributeDataType.Date, sortOrder: 30 });
  await upsertAttributeDef(actor, { entityTypeId: type.id, code: 'shipping_date', name: 'Дата отгрузки', dataType: AttributeDataType.Date, sortOrder: 31 });
  await upsertAttributeDef(actor, { entityTypeId: type.id, code: 'is_scrap', name: 'Утиль', dataType: AttributeDataType.Boolean, sortOrder: 40 });
  return type.id;
}

async function ensureCounterpartyInfra(actor: AuthUser): Promise<string> {
  const type = await upsertEntityType(actor, { code: EntityTypeCode.Customer, name: 'Контрагенты' });
  if (!type.ok || !type.id) throw new Error('Failed to upsert customer type');
  await upsertAttributeDef(actor, {
    entityTypeId: type.id,
    code: 'name',
    name: 'Название',
    dataType: AttributeDataType.Text,
    sortOrder: 10,
  });
  return type.id;
}

async function loadCounterpartyIdsByNormalizedName(customerTypeId: string): Promise<{
  idByNormalizedName: Map<string, string>;
  duplicateIdsByNormalizedName: Map<string, string[]>;
}> {
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, customerTypeId), isNull(attributeDefs.deletedAt)))
    .limit(5000);
  const nameDefId = defs.find((d) => String(d.code) === 'name')?.id;
  if (!nameDefId) {
    return { idByNormalizedName: new Map(), duplicateIdsByNormalizedName: new Map() };
  }

  const entitiesRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, customerTypeId), isNull(entities.deletedAt)))
    .limit(500_000);
  const entityIds = entitiesRows.map((r) => String(r.id));
  if (entityIds.length === 0) {
    return { idByNormalizedName: new Map(), duplicateIdsByNormalizedName: new Map() };
  }

  const values = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(inArray(attributeValues.entityId, entityIds as any), eq(attributeValues.attributeDefId, nameDefId), isNull(attributeValues.deletedAt)),
    )
    .limit(500_000);

  const idsByNormalizedName = new Map<string, string[]>();
  for (const row of values) {
    const raw = safeJsonParse(row.valueJson) as unknown;
    if (raw == null || typeof raw !== 'string') continue;
    const name = cleanCell(raw);
    const normalized = normalizeCounterparty(name);
    if (!normalized) continue;
    const cur = idsByNormalizedName.get(normalized) ?? [];
    cur.push(String(row.entityId));
    idsByNormalizedName.set(normalized, cur);
  }

  const idByNormalizedName = new Map<string, string>();
  const duplicateIdsByNormalizedName = new Map<string, string[]>();
  for (const [normalized, ids] of idsByNormalizedName.entries()) {
    const firstId = ids[0];
    if (firstId !== undefined) idByNormalizedName.set(normalized, firstId);
    if (ids.length > 1) duplicateIdsByNormalizedName.set(normalized, ids);
  }
  return { idByNormalizedName, duplicateIdsByNormalizedName };
}

function extractDuplicateIdFromError(errorText: string): string | null {
  const match = String(errorText ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match?.[0] ?? null;
}

async function loadBrandIdByKey(brandTypeId: string): Promise<Map<string, string>> {
  const defs = await db.select({ id: attributeDefs.id }).from(attributeDefs).where(and(eq(attributeDefs.entityTypeId, brandTypeId), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt))).limit(1);
  const nameDefId = defs[0]?.id;
  if (!nameDefId) return new Map();
  const rows = await db
    .select({ entityId: entities.id, valueJson: attributeValues.valueJson })
    .from(entities)
    .innerJoin(attributeValues, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(entities.typeId, brandTypeId),
        isNull(entities.deletedAt),
        eq(attributeValues.attributeDefId, nameDefId),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(100000);
  const out = new Map<string, string>();
  for (const row of rows) {
    const name = row.valueJson ? String(JSON.parse(row.valueJson)) : '';
    const key = normalizeBrandKey(name);
    if (key) out.set(key, String(row.entityId));
  }
  return out;
}

async function loadBrandNamesById(brandTypeId: string, brandIds: string[]): Promise<Map<string, string>> {
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, brandTypeId), isNull(attributeDefs.deletedAt)))
    .limit(200);
  const nameDefId = defs.find((d) => String(d.code) === 'name')?.id;
  if (!nameDefId || brandIds.length === 0) return new Map();

  const rows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(inArray(attributeValues.entityId, brandIds as any), eq(attributeValues.attributeDefId, nameDefId), isNull(attributeValues.deletedAt)),
    )
    .limit(2000);
  const out = new Map<string, string>();
  for (const row of rows) {
    const parsed = safeJsonParse(row.valueJson);
    if (parsed == null) continue;
    out.set(String(row.entityId), String(parsed));
  }
  return out;
}

async function loadPartTypeId(): Promise<string> {
  await listParts({ limit: 1 });
  const rows = await db.select({ id: entityTypes.id }).from(entityTypes).where(and(eq(entityTypes.code, EntityTypeCode.Part), isNull(entityTypes.deletedAt))).limit(1);
  if (!rows[0]?.id) throw new Error('Part entity type not found');
  return String(rows[0].id);
}

async function loadExistingPartByKey(partTypeId: string): Promise<Map<string, { id: string; brandIds: string[]; qtyMap: Record<string, number> }>> {
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, partTypeId), isNull(attributeDefs.deletedAt)))
    .limit(1000);
  const defByCode = new Map(defs.map((d) => [String(d.code), String(d.id)]));
  const nameDef = defByCode.get('name');
  const asmDef = defByCode.get('assembly_unit_number');
  const brandsDef = defByCode.get('engine_brand_ids');
  const qtyMapDef = defByCode.get('engine_brand_qty_map');
  if (!nameDef) return new Map();

  const partsRows = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.typeId, partTypeId), isNull(entities.deletedAt))).limit(200000);
  const partIds = partsRows.map((r) => String(r.id));
  if (partIds.length === 0) return new Map();

  const neededDefs = [nameDef, asmDef, brandsDef, qtyMapDef].filter(Boolean) as string[];
  const vals = await db
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, partIds as any), inArray(attributeValues.attributeDefId, neededDefs as any), isNull(attributeValues.deletedAt)))
    .limit(500000);

  const byPart = new Map<string, Record<string, unknown>>();
  for (const v of vals) {
    const id = String(v.entityId);
    const obj = byPart.get(id) ?? {};
    obj[String(v.attributeDefId)] = v.valueJson ? JSON.parse(v.valueJson) : null;
    byPart.set(id, obj);
  }

  const out = new Map<string, { id: string; brandIds: string[]; qtyMap: Record<string, number> }>();
  for (const partId of partIds) {
    const attrs = byPart.get(partId) ?? {};
    const name = typeof attrs[nameDef] === 'string' ? String(attrs[nameDef]) : '';
    const asm = asmDef && typeof attrs[asmDef] === 'string' ? String(attrs[asmDef]) : null;
    if (!name) continue;
    const key = partKey(name, asm);
    const brandIds = brandsDef && Array.isArray(attrs[brandsDef]) ? (attrs[brandsDef] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const rawMap = qtyMapDef && attrs[qtyMapDef] && typeof attrs[qtyMapDef] === 'object' && !Array.isArray(attrs[qtyMapDef]) ? (attrs[qtyMapDef] as Record<string, unknown>) : {};
    const qtyMap: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawMap)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) qtyMap[String(k)] = Math.floor(n);
    }
    out.set(key, { id: partId, brandIds, qtyMap });
  }
  return out;
}

async function loadEngineByNumber(engineTypeId: string): Promise<Map<string, string>> {
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, engineTypeId), isNull(attributeDefs.deletedAt)))
    .limit(1000);
  const engineNumberDef = defs.find((d) => String(d.code) === 'engine_number')?.id;
  if (!engineNumberDef) return new Map();
  const engineRows = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.typeId, engineTypeId), isNull(entities.deletedAt))).limit(300000);
  const ids = engineRows.map((r) => String(r.id));
  if (ids.length === 0) return new Map();
  const vals = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.attributeDefId, engineNumberDef), inArray(attributeValues.entityId, ids as any), isNull(attributeValues.deletedAt)))
    .limit(300000);
  const out = new Map<string, string>();
  for (const row of vals) {
    const number = row.valueJson ? normalizeEngineNumber(String(JSON.parse(row.valueJson))) : '';
    if (!number) continue;
    out.set(number, String(row.entityId));
  }
  return out;
}

async function loadEngineAttributeMapByIds(
  engineTypeId: string,
  engineIds: string[],
): Promise<Map<string, Map<string, unknown>>> {
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, engineTypeId), isNull(attributeDefs.deletedAt)))
    .limit(1000);
  const byCode = new Map<string, string>();
  const neededCodes = ['engine_number', 'engine_brand', 'engine_brand_id', 'arrival_date', 'shipping_date', 'is_scrap', 'customer_id'];
  for (const d of defs) {
    const code = String(d.code);
    if (neededCodes.includes(code)) byCode.set(String(d.id), code);
  }
  if (engineIds.length === 0 || byCode.size === 0) return new Map();

  const defIds = [...new Set(byCode.keys())];
  const vals = await db
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(inArray(attributeValues.entityId, engineIds as any), inArray(attributeValues.attributeDefId, defIds as any), isNull(attributeValues.deletedAt)),
    )
    .limit(400000);

  const out = new Map<string, Map<string, unknown>>();
  for (const row of vals) {
    const code = byCode.get(String(row.attributeDefId));
    if (!code) continue;
    const entityId = String(row.entityId);
    const existing = out.get(entityId) ?? new Map<string, unknown>();
    existing.set(code, safeJsonParse(row.valueJson));
    out.set(entityId, existing);
  }
  return out;
}

async function main() {
  const startedAt = nowMs();
  logStage('start', { source: SOURCE_FILE });
  const actor = await ensureActor();
  const parsed = parseSourceCsv(SOURCE_FILE);
  if (parsed.brands.size === 0) throw new Error('No brands parsed from source');
  if (parsed.parts.size === 0) throw new Error('No parts parsed from source');
  if (parsed.engines.size === 0) throw new Error('No engines parsed from source');
  logStage('parsed', {
    brands: parsed.brands.size,
    parts: parsed.parts.size,
    engines: parsed.engines.size,
    suppliers: parsed.suppliersByNormalized.size,
  });
  if (parsed.supplierConflictsByEngine.size > 0) {
    logStage('supplier-conflicts-detected', {
      rows: parsed.supplierConflictsByEngine.size,
      examples: [...parsed.supplierConflictsByEngine.entries()]
        .slice(0, 5)
        .map(([engineNo, names]) => ({ engineNo, suppliers: names })),
    });
  }

  const brandTypeId = await ensureBrandInfra(actor);
  const engineTypeId = await ensureEngineInfra(actor);
  const customerTypeId = await ensureCounterpartyInfra(actor);
  const partTypeId = await loadPartTypeId();
  const { idByNormalizedName: existingCustomerByNormalizedName, duplicateIdsByNormalizedName } = await loadCounterpartyIdsByNormalizedName(customerTypeId);
  logStage('infra-ready', {
    brandTypeId,
    engineTypeId,
    partTypeId,
    customerTypeId,
    existingCounterparties: existingCustomerByNormalizedName.size,
    existingCounterpartyDuplicates: duplicateIdsByNormalizedName.size,
  });
  if (duplicateIdsByNormalizedName.size > 0) {
    logStage('counterparties-existing-duplicates', {
      count: duplicateIdsByNormalizedName.size,
      examples: [...duplicateIdsByNormalizedName.entries()].slice(0, 5).map(([name, ids]) => ({
        name,
        duplicates: ids,
      })),
    });
  }

  let createdCounterparties = 0;
  let reusedCounterparties = 0;
  let reusedDuplicateCounterparties = 0;
  const supplierNames = [...parsed.suppliersByNormalized.entries()];
  for (const [normalizedSupplier, supplierName] of supplierNames) {
    if (existingCustomerByNormalizedName.has(normalizedSupplier)) {
      reusedCounterparties += 1;
      continue;
    }
    const created = await createEntity(actor, customerTypeId);
    if (!created.ok || !created.id) throw new Error(`Failed to create counterparties: ${supplierName}`);
    const setRes = await setEntityAttribute(actor, created.id, 'name', supplierName);
    if (!setRes.ok) {
      await softDeleteEntity(actor, created.id);
      const duplicatedId = extractDuplicateIdFromError(setRes.error ?? '');
      if (!duplicatedId) {
        throw new Error(`Failed to set counterparty name for ${supplierName}: ${setRes.error}`);
      }
      existingCustomerByNormalizedName.set(normalizedSupplier, duplicatedId);
      reusedDuplicateCounterparties += 1;
      reusedCounterparties += 1;
      continue;
    }
    existingCustomerByNormalizedName.set(normalizedSupplier, created.id);
    createdCounterparties += 1;
    reusedCounterparties += 1;
    if (createdCounterparties % 25 === 0 || createdCounterparties === parsed.suppliersByNormalized.size) {
      logStage('counterparties-progress', {
        processed: createdCounterparties + reusedDuplicateCounterparties,
        total: parsed.suppliersByNormalized.size,
        createdCounterparties,
        reusedCounterparties,
      });
    }
  }

  const brandIdByKey = await loadBrandIdByKey(brandTypeId);
  const existingBrandNamesById = await loadBrandNamesById(brandTypeId, [...brandIdByKey.values()]);
  let createdBrands = 0;
  let updatedBrands = 0;
  let brandIndex = 0;
  for (const brand of parsed.brands.values()) {
    brandIndex += 1;
    let brandId = brandIdByKey.get(brand.key) ?? null;
    let wasCreated = false;
    if (!brandId) {
      const created = await createEntity(actor, brandTypeId);
      if (!created.ok || !created.id) throw new Error(`Failed to create brand: ${brand.name}`);
      brandId = created.id;
      createdBrands += 1;
      wasCreated = true;
    }
    const existingName = existingBrandNamesById.get(brandId) ?? '';
    if (wasCreated || existingName !== brand.name) {
      const setRes = await setEntityAttribute(actor, brandId, 'name', brand.name);
      if (!setRes.ok) throw new Error(`Failed to set brand name: ${brand.name} (${setRes.error})`);
      existingBrandNamesById.set(brandId, brand.name);
    }
    brandIdByKey.set(brand.key, brandId);
    updatedBrands += 1;
    if (brandIndex % 25 === 0 || brandIndex === parsed.brands.size) {
      logStage('brands-progress', { processed: brandIndex, total: parsed.brands.size, createdBrands, updatedBrands });
    }
  }

  const desiredBrandIds = new Set<string>([...brandIdByKey.values()]);

  const existingPartByKey = await loadExistingPartByKey(partTypeId);
  let createdParts = 0;
  let updatedParts = 0;
  let cleanedParts = 0;
  let partIndex = 0;

  for (const desiredPart of parsed.parts.values()) {
    partIndex += 1;
    let rec = existingPartByKey.get(desiredPart.key);
    if (!rec) {
      const created = await createPart({
        actor,
        attributes: {
          name: desiredPart.name,
          ...(desiredPart.assemblyUnitNumber ? { assembly_unit_number: desiredPart.assemblyUnitNumber } : {}),
        },
      });
      if (!created.ok) throw new Error(`Failed to create part: ${desiredPart.name} (${created.error})`);
      rec = { id: created.part.id, brandIds: [], qtyMap: {} };
      existingPartByKey.set(desiredPart.key, rec);
      createdParts += 1;
    }

    const nextQtyMap: Record<string, number> = {};
    for (const [brandKey, qty] of desiredPart.qtyByBrandKey.entries()) {
      const brandId = brandIdByKey.get(brandKey);
      if (!brandId) continue;
      nextQtyMap[brandId] = qty;
    }
    const nextBrandIds = Object.keys(nextQtyMap).sort((a, b) => a.localeCompare(b));

    const curBrandIds = [...rec.brandIds].sort((a, b) => a.localeCompare(b));
    const curQtyMapJson = JSON.stringify(Object.fromEntries(Object.entries(rec.qtyMap).sort(([a], [b]) => a.localeCompare(b))));
    const nextQtyMapJson = JSON.stringify(Object.fromEntries(Object.entries(nextQtyMap).sort(([a], [b]) => a.localeCompare(b))));

    if (JSON.stringify(curBrandIds) !== JSON.stringify(nextBrandIds)) {
      const upd = await updatePartAttribute({ partId: rec.id, attributeCode: 'engine_brand_ids', value: nextBrandIds, actor });
      if (!upd.ok) throw new Error(`Failed to update engine_brand_ids for part ${rec.id}: ${upd.error}`);
    }
    if (curQtyMapJson !== nextQtyMapJson) {
      const upd = await updatePartAttribute({ partId: rec.id, attributeCode: 'engine_brand_qty_map', value: nextQtyMap, actor });
      if (!upd.ok) throw new Error(`Failed to update engine_brand_qty_map for part ${rec.id}: ${upd.error}`);
    }
    updatedParts += 1;
    if (partIndex % 50 === 0 || partIndex === parsed.parts.size) {
      logStage('parts-progress', { processed: partIndex, total: parsed.parts.size, createdParts, updatedParts, cleanedParts });
    }
  }

  const desiredPartKeys = new Set(parsed.parts.keys());
  for (const [key, rec] of existingPartByKey.entries()) {
    if (desiredPartKeys.has(key)) continue;
    const nextBrandIds = rec.brandIds.filter((id) => !desiredBrandIds.has(id));
    const nextQtyMap = Object.fromEntries(Object.entries(rec.qtyMap).filter(([brandId]) => !desiredBrandIds.has(brandId)));
    const curBrandIds = [...rec.brandIds].sort((a, b) => a.localeCompare(b));
    const sortedNextBrandIds = [...nextBrandIds].sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(curBrandIds) !== JSON.stringify(sortedNextBrandIds)) {
      const upd = await updatePartAttribute({ partId: rec.id, attributeCode: 'engine_brand_ids', value: sortedNextBrandIds, actor });
      if (!upd.ok) throw new Error(`Failed to cleanup engine_brand_ids for part ${rec.id}: ${upd.error}`);
      cleanedParts += 1;
    }
    const curQtyJson = JSON.stringify(Object.fromEntries(Object.entries(rec.qtyMap).sort(([a], [b]) => a.localeCompare(b))));
    const nextQtyJson = JSON.stringify(Object.fromEntries(Object.entries(nextQtyMap).sort(([a], [b]) => a.localeCompare(b))));
    if (curQtyJson !== nextQtyJson) {
      const upd = await updatePartAttribute({ partId: rec.id, attributeCode: 'engine_brand_qty_map', value: nextQtyMap, actor });
      if (!upd.ok) throw new Error(`Failed to cleanup engine_brand_qty_map for part ${rec.id}: ${upd.error}`);
      cleanedParts += 1;
    }
  }

  const engineIdByNumber = await loadEngineByNumber(engineTypeId);
  const desiredEngineNumbers = new Set<string>();
  for (const item of parsed.engines.values()) {
    const number = normalizeEngineNumber(item.engineNumber);
    if (!number) continue;
    desiredEngineNumbers.add(number);
  }
  const desiredEngineIds = [...desiredEngineNumbers].map((engineNumber) => engineIdByNumber.get(engineNumber)).filter((engineId): engineId is string => Boolean(engineId));
  const existingEngineAttrsById = await loadEngineAttributeMapByIds(engineTypeId, desiredEngineIds);
  logStage('engine-cache-loaded', {
    cached: existingEngineAttrsById.size,
    desired: desiredEngineNumbers.size,
    existing: engineIdByNumber.size,
  });
  let createdEngines = 0;
  let updatedEngines = 0;
  let deletedEngines = 0;
  let engineIndex = 0;
  let engineAttributeWrites = 0;
  let engineAttributeConflictsRecovered = 0;
  let enginesWithoutEngineChanges = 0;
  const engineIdByDesiredNumber = new Map<string, string>();
  let supplierLinksApplied = 0;
  let supplierLinksMissing = 0;
  let supplierLinksSkipped = 0;
  const expectedSupplierIdByEngineNumber = new Map<string, string | null>();

  for (const item of parsed.engines.values()) {
    engineIndex += 1;
    const number = normalizeEngineNumber(item.engineNumber);
    if (!number) continue;
    const brandId = brandIdByKey.get(item.brandKey);
    if (!brandId) continue;
    let engineId = engineIdByNumber.get(number) ?? null;
    if (!engineId) {
      const created = await createEntity(actor, engineTypeId);
      if (!created.ok || !created.id) throw new Error(`Failed to create engine: ${number}`);
      engineId = created.id;
      createdEngines += 1;
      existingEngineAttrsById.set(engineId, new Map<string, unknown>());
    }

    const updates: Array<[string, unknown]> = [
      ['engine_number', number],
      ['engine_brand', item.brandName],
      ['engine_brand_id', brandId],
      ['arrival_date', item.arrivalDate],
      ['shipping_date', item.shippingDate],
      ['is_scrap', false],
    ];
    const existingEngineAttrs = existingEngineAttrsById.get(engineId) ?? new Map<string, unknown>();
    const changed: Array<[string, unknown]> = [];
    for (const [code, value] of updates) {
      if (!engineAttributeEquals(value, existingEngineAttrs.get(code))) changed.push([code, value]);
    }
    const normalizedSupplier = normalizeCounterparty(item.supplierName ?? '');
    const supplierId = normalizedSupplier ? existingCustomerByNormalizedName.get(normalizedSupplier) : null;
    if (supplierId && !engineAttributeEquals(supplierId, existingEngineAttrs.get('customer_id'))) {
      changed.push(['customer_id', supplierId]);
    }
    for (const [code, value] of changed) {
      let res: { ok: boolean; error?: string } | null = null;
      let recoveredFromConflict = false;
      try {
        res = await setEntityAttribute(actor, engineId, code, value, {
          touchEntity: false,
          allowSyncConflicts: IMPORT_ALLOW_SYNC_CONFLICTS,
        });
      } catch (err) {
        if (IMPORT_ALLOW_SYNC_CONFLICTS && String(err).includes('sync_conflict')) {
          logStage('engine-attribute-sync-conflict-recovered', {
            engineNumber: number,
            engineId,
            attributeCode: code,
            expectedValue: value == null ? null : String(value),
            previousValue: existingEngineAttrs.get(code) == null ? null : String(existingEngineAttrs.get(code)),
            error: String(err),
          });
          res = await setEntityAttribute(actor, engineId, code, value, {
            touchEntity: false,
            allowSyncConflicts: true,
          });
          recoveredFromConflict = true;
          if (!res.ok) throw new Error(`Failed to set ${code} for engine ${number}: ${res.error}`);
          if (recoveredFromConflict) engineAttributeConflictsRecovered += 1;
        } else {
          logStage('engine-attribute-sync-error', {
            engineNumber: number,
            engineId,
            attributeCode: code,
            expectedValue: value == null ? null : String(value),
            previousValue: existingEngineAttrs.get(code) == null ? null : String(existingEngineAttrs.get(code)),
            error: String(err),
          });
          throw err;
        }
      }
      if (!res) throw new Error(`No response from setEntityAttribute for ${code} on engine ${number}`);
      if (!res.ok) throw new Error(`Failed to set ${code} for engine ${number}: ${res.error}`);
      existingEngineAttrs.set(code, value);
      engineAttributeWrites += 1;
    }
    if (changed.length === 0) {
      enginesWithoutEngineChanges += 1;
    }
    if (normalizedSupplier) {
      if (supplierId) {
        supplierLinksApplied += 1;
      } else {
        supplierLinksMissing += 1;
      }
    } else {
      supplierLinksSkipped += 1;
    }
    expectedSupplierIdByEngineNumber.set(number, supplierId ?? null);
    updatedEngines += 1;
    engineIdByDesiredNumber.set(number, engineId);
    engineIdByNumber.set(number, engineId);
    if (engineIndex % 100 === 0 || engineIndex === parsed.engines.size) {
      logStage('engines-progress', { processed: engineIndex, total: parsed.engines.size, createdEngines, updatedEngines });
    }
  }

  for (const [number, engineId] of engineIdByNumber.entries()) {
    if (desiredEngineNumbers.has(number)) continue;
    const del = await softDeleteEntity(actor, engineId);
    if (!del.ok) throw new Error(`Failed to soft delete engine ${number}: ${del.error}`);
    deletedEngines += 1;
  }
  logStage('engines-cleanup-done', { deletedEngines });

  const actualCustomerByEngineId = new Map<string, string>();
  for (const [engineNumber, engineId] of engineIdByDesiredNumber.entries()) {
    const currentValue = existingEngineAttrsById.get(engineId)?.get('customer_id');
    if (typeof currentValue === 'string') actualCustomerByEngineId.set(engineId, currentValue);
  }
  let supplierLinksVerified = 0;
  let supplierLinksInDbMissing = 0;
  let supplierLinksMismatched = 0;
  const supplierVerificationProblems: Array<{
    engineNumber: string;
    expectedCounterpartyId: string;
    actualCounterpartyId: string;
  }> = [];

  for (const [engineNumber, engineId] of engineIdByDesiredNumber.entries()) {
    const expectedCounterpartyId = expectedSupplierIdByEngineNumber.get(engineNumber) ?? null;
    const actualRaw = actualCustomerByEngineId.get(engineId);
    const actualCounterpartyId = actualRaw ?? null;

    if (!expectedCounterpartyId) {
      continue;
    }
    if (actualCounterpartyId === expectedCounterpartyId) {
      supplierLinksVerified += 1;
    } else if (!actualCounterpartyId) {
      supplierLinksInDbMissing += 1;
    } else {
      supplierLinksMismatched += 1;
      if (supplierVerificationProblems.length < 10) {
        supplierVerificationProblems.push({
          engineNumber,
          expectedCounterpartyId,
          actualCounterpartyId,
        });
      }
    }
  }

  logStage('supplier-links-verification', {
    checked: supplierLinksVerified + supplierLinksInDbMissing + supplierLinksMismatched,
    applied: supplierLinksApplied,
    verified: supplierLinksVerified,
    missing: supplierLinksInDbMissing,
    mismatched: supplierLinksMismatched,
    skipped: supplierLinksSkipped,
    conflicts: parsed.supplierConflictsByEngine.size,
    problems: supplierVerificationProblems,
  });

  const defectTemplates = await listRepairChecklistTemplates('defect');
  const completenessTemplates = await listRepairChecklistTemplates('completeness');
  if (!defectTemplates.ok || !defectTemplates.templates[0]) throw new Error('Defect checklist template not found');
  if (!completenessTemplates.ok || !completenessTemplates.templates[0]) throw new Error('Completeness checklist template not found');
  const defectTemplate = defectTemplates.templates[0];
  const completenessTemplate = completenessTemplates.templates[0];

  let syncedDefectChecklists = 0;
  let syncedCompletenessChecklists = 0;
  let checklistSyncConflictsRecovered = 0;

  const partsByBrandKey = new Map<string, Array<{ partName: string; partNumber: string; quantity: number }>>();
  for (const brand of parsed.brands.values()) partsByBrandKey.set(brand.key, []);
  for (const part of parsed.parts.values()) {
    for (const [brandKey, qty] of part.qtyByBrandKey.entries()) {
      const rows = partsByBrandKey.get(brandKey) ?? [];
      rows.push({
        partName: part.name,
        partNumber: part.assemblyUnitNumber ?? '',
        quantity: qty,
      });
      partsByBrandKey.set(brandKey, rows);
    }
  }
  for (const rows of partsByBrandKey.values()) {
    rows.sort((a, b) => a.partName.localeCompare(b.partName, 'ru'));
  }

  let checklistIndex = 0;
  for (const engine of parsed.engines.values()) {
    checklistIndex += 1;
    const engineNumber = normalizeEngineNumber(engine.engineNumber);
    const engineId = engineIdByDesiredNumber.get(engineNumber);
    if (!engineId) continue;
    const rows = partsByBrandKey.get(engine.brandKey) ?? [];

    const defectRows = rows.map((r) => ({
      part_name: r.partName,
      part_number: r.partNumber,
      quantity: r.quantity,
      repairable_qty: r.quantity,
      scrap_qty: 0,
    }));
    const existingDefectChecklist = await getRepairChecklistForEngine(engineId, 'defect');
    if (!existingDefectChecklist.ok) {
      throw new Error(`Failed to read defect checklist for engine ${engineNumber}: ${existingDefectChecklist.error}`);
    }
    const existingDefectPayload = existingDefectChecklist.payload;
    const hasDefectPayload = areChecklistMetaEqual(existingDefectPayload, engine.brandName, engineNumber) && areDefectRowsEqual(existingDefectPayload, defectRows);

    if (!hasDefectPayload) {
      const defectPayload = {
        kind: 'repair_checklist' as const,
        templateId: defectTemplate.id,
        templateVersion: defectTemplate.version,
        stage: 'defect',
        engineEntityId: engineId,
        filledBy: actor.username,
        filledAt: nowMs(),
        answers: {
          engine_brand: { kind: 'text' as const, value: engine.brandName },
          engine_number: { kind: 'text' as const, value: engineNumber },
          defect_items: { kind: 'table' as const, rows: defectRows },
        },
        attachments: existingDefectPayload?.attachments ?? [],
      };
      const defectSave = await saveRepairChecklistForEngine({
        engineId,
        stage: 'defect',
        operationId: existingDefectChecklist.operationId ?? null,
        payload: defectPayload as any,
        actor: { id: actor.id, username: actor.username },
        allowSyncConflicts: false,
      });
      if (!defectSave.ok && IMPORT_ALLOW_SYNC_CONFLICTS && defectSave.error.includes('sync_conflict')) {
        logStage('checklist-save-conflict-recovered', {
          engineNumber,
          checklistStage: 'defect',
          operationId: existingDefectChecklist.operationId ?? null,
          error: defectSave.error,
        });
        const retryDefectSave = await saveRepairChecklistForEngine({
          engineId,
          stage: 'defect',
          operationId: existingDefectChecklist.operationId ?? null,
          payload: defectPayload as any,
          actor: { id: actor.id, username: actor.username },
          allowSyncConflicts: true,
        });
        if (!retryDefectSave.ok) {
          throw new Error(`Failed to save defect checklist for engine ${engineNumber}: ${retryDefectSave.error}`);
        }
        checklistSyncConflictsRecovered += 1;
      } else if (!defectSave.ok) {
        throw new Error(`Failed to save defect checklist for engine ${engineNumber}: ${defectSave.error}`);
      }
      syncedDefectChecklists += 1;
    }

    const completenessRows = rows.map((r) => ({
      part_name: r.partName,
      assembly_unit_number: r.partNumber,
      quantity: r.quantity,
      present: false,
      actual_qty: 0,
    }));
    const existingCompletenessChecklist = await getRepairChecklistForEngine(engineId, 'completeness');
    if (!existingCompletenessChecklist.ok) {
      throw new Error(`Failed to read completeness checklist for engine ${engineNumber}: ${existingCompletenessChecklist.error}`);
    }
    const existingCompletenessPayload = existingCompletenessChecklist.payload;
    const hasCompletenessPayload =
      areChecklistMetaEqual(existingCompletenessPayload, engine.brandName, engineNumber) &&
      areCompletenessRowsEqual(existingCompletenessPayload, completenessRows);
    if (!hasCompletenessPayload) {
      const completenessPayload = {
        kind: 'repair_checklist' as const,
        templateId: completenessTemplate.id,
        templateVersion: completenessTemplate.version,
        stage: 'completeness',
        engineEntityId: engineId,
        filledBy: actor.username,
        filledAt: nowMs(),
        answers: {
          engine_brand: { kind: 'text' as const, value: engine.brandName },
          engine_number: { kind: 'text' as const, value: engineNumber },
          completeness_items: { kind: 'table' as const, rows: completenessRows },
        },
        attachments: existingCompletenessPayload?.attachments ?? [],
      };
      const completenessSave = await saveRepairChecklistForEngine({
        engineId,
        stage: 'completeness',
        operationId: existingCompletenessChecklist.operationId ?? null,
        payload: completenessPayload as any,
        actor: { id: actor.id, username: actor.username },
        allowSyncConflicts: false,
      });
      if (!completenessSave.ok && IMPORT_ALLOW_SYNC_CONFLICTS && completenessSave.error.includes('sync_conflict')) {
        logStage('checklist-save-conflict-recovered', {
          engineNumber,
          checklistStage: 'completeness',
          operationId: existingCompletenessChecklist.operationId ?? null,
          error: completenessSave.error,
        });
        const retryCompletenessSave = await saveRepairChecklistForEngine({
          engineId,
          stage: 'completeness',
          operationId: existingCompletenessChecklist.operationId ?? null,
          payload: completenessPayload as any,
          actor: { id: actor.id, username: actor.username },
          allowSyncConflicts: true,
        });
        if (!retryCompletenessSave.ok) {
          throw new Error(`Failed to save completeness checklist for engine ${engineNumber}: ${retryCompletenessSave.error}`);
        }
        checklistSyncConflictsRecovered += 1;
      } else if (!completenessSave.ok) {
        throw new Error(`Failed to save completeness checklist for engine ${engineNumber}: ${completenessSave.error}`);
      }
      syncedCompletenessChecklists += 1;
    }
    if (checklistIndex % 100 === 0 || checklistIndex === parsed.engines.size) {
      logStage('checklists-progress', {
        processed: checklistIndex,
        total: parsed.engines.size,
        syncedDefectChecklists,
        syncedCompletenessChecklists,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        source: SOURCE_FILE,
        parsed: {
          brands: parsed.brands.size,
          parts: parsed.parts.size,
          engines: parsed.engines.size,
          suppliers: parsed.suppliersByNormalized.size,
        },
        changes: {
          createdBrands,
          updatedBrands,
          createdParts,
          updatedParts,
          cleanedParts,
          createdEngines,
          updatedEngines,
          deletedEngines,
          createdCounterparties,
          reusedCounterparties,
          reusedDuplicateCounterparties,
          engineAttributeWrites,
          enginesWithoutEngineChanges,
          supplierLinksApplied,
          supplierLinksSkipped,
          supplierLinksMissing,
          syncedDefectChecklists,
          syncedCompletenessChecklists,
          engineAttributeConflictsRecovered,
          checklistSyncConflictsRecovered,
        },
        supplierLinkVerification: {
          checked: supplierLinksVerified + supplierLinksInDbMissing + supplierLinksMismatched,
          verified: supplierLinksVerified,
          missingInDb: supplierLinksInDbMissing,
          mismatched: supplierLinksMismatched,
          skipped: supplierLinksSkipped,
          problems: supplierVerificationProblems.slice(0, 10),
        },
        elapsedMs: nowMs() - startedAt,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error('[importEnginesFromCompletenessCsv] failed', error);
  process.exit(1);
});

