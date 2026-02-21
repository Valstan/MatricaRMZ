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
};
type DesiredPart = {
  key: string;
  name: string;
  assemblyUnitNumber: string | null;
  qtyByBrandKey: Map<string, number>;
};

const SOURCE_FILE = process.env.MATRICA_COMPLETENESS_CSV ?? '/home/valstan/Сводная ведомость актов комплектности2.csv';

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

function parseSourceCsv(path: string): {
  brands: Map<string, DesiredBrand>;
  parts: Map<string, DesiredPart>;
  engines: Map<string, DesiredEngine>;
} {
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

  for (let i = headerLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim()) continue;
    const row = parseDelimitedLine(line, delimiter);
    if (row.every((x) => !x)) continue;

    const brandRaw = cleanCell(row[brandCol] ?? '');
    const engineRaw = cleanCell(row[engineNoCol] ?? '');
    if (!brandRaw || !engineRaw) continue;

    const brandKey = normalizeBrandKey(brandRaw);
    if (!brandKey) continue;
    const brandName = canonicalBrandName(brandRaw, brandKey);
    if (!brands.has(brandKey)) {
      brands.set(brandKey, { key: brandKey, name: brandName });
    }

    const engineNumber = normalizeEngineNumber(engineRaw);
    if (engineNumber) {
      engines.set(engineNumber, {
        engineNumber,
        brandKey,
        brandName,
        arrivalDate: arrivalCol >= 0 ? parseDateMs(row[arrivalCol] ?? '') : null,
        shippingDate: shippingCol >= 0 ? parseDateMs(row[shippingCol] ?? '') : null,
      });
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

  return { brands, parts, engines };
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
  await upsertAttributeDef(actor, { entityTypeId: type.id, code: 'arrival_date', name: 'Дата прихода', dataType: AttributeDataType.Date, sortOrder: 30 });
  await upsertAttributeDef(actor, { entityTypeId: type.id, code: 'shipping_date', name: 'Дата отгрузки', dataType: AttributeDataType.Date, sortOrder: 31 });
  await upsertAttributeDef(actor, { entityTypeId: type.id, code: 'is_scrap', name: 'Утиль', dataType: AttributeDataType.Boolean, sortOrder: 40 });
  return type.id;
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

async function main() {
  const startedAt = nowMs();
  logStage('start', { source: SOURCE_FILE });
  const actor = await ensureActor();
  const parsed = parseSourceCsv(SOURCE_FILE);
  if (parsed.brands.size === 0) throw new Error('No brands parsed from source');
  if (parsed.parts.size === 0) throw new Error('No parts parsed from source');
  if (parsed.engines.size === 0) throw new Error('No engines parsed from source');
  logStage('parsed', { brands: parsed.brands.size, parts: parsed.parts.size, engines: parsed.engines.size });

  const brandTypeId = await ensureBrandInfra(actor);
  const engineTypeId = await ensureEngineInfra(actor);
  const partTypeId = await loadPartTypeId();
  logStage('infra-ready', { brandTypeId, engineTypeId, partTypeId });

  const brandIdByKey = await loadBrandIdByKey(brandTypeId);
  let createdBrands = 0;
  let updatedBrands = 0;
  let brandIndex = 0;
  for (const brand of parsed.brands.values()) {
    brandIndex += 1;
    let brandId = brandIdByKey.get(brand.key) ?? null;
    if (!brandId) {
      const created = await createEntity(actor, brandTypeId);
      if (!created.ok || !created.id) throw new Error(`Failed to create brand: ${brand.name}`);
      brandId = created.id;
      createdBrands += 1;
    }
    const setRes = await setEntityAttribute(actor, brandId, 'name', brand.name);
    if (!setRes.ok) throw new Error(`Failed to set brand name: ${brand.name} (${setRes.error})`);
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
  let createdEngines = 0;
  let updatedEngines = 0;
  let deletedEngines = 0;
  let engineIndex = 0;
  const desiredEngineNumbers = new Set<string>();
  const engineIdByDesiredNumber = new Map<string, string>();

  for (const item of parsed.engines.values()) {
    engineIndex += 1;
    const number = normalizeEngineNumber(item.engineNumber);
    if (!number) continue;
    desiredEngineNumbers.add(number);
    const brandId = brandIdByKey.get(item.brandKey);
    if (!brandId) continue;
    let engineId = engineIdByNumber.get(number) ?? null;
    if (!engineId) {
      const created = await createEntity(actor, engineTypeId);
      if (!created.ok || !created.id) throw new Error(`Failed to create engine: ${number}`);
      engineId = created.id;
      createdEngines += 1;
    }

    const updates: Array<[string, unknown]> = [
      ['engine_number', number],
      ['engine_brand', item.brandName],
      ['engine_brand_id', brandId],
      ['arrival_date', item.arrivalDate],
      ['shipping_date', item.shippingDate],
      ['is_scrap', false],
    ];
    for (const [code, value] of updates) {
      const res = await setEntityAttribute(actor, engineId, code, value);
      if (!res.ok) throw new Error(`Failed to set ${code} for engine ${number}: ${res.error}`);
    }
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

  const defectTemplates = await listRepairChecklistTemplates('defect');
  const completenessTemplates = await listRepairChecklistTemplates('completeness');
  if (!defectTemplates.ok || !defectTemplates.templates[0]) throw new Error('Defect checklist template not found');
  if (!completenessTemplates.ok || !completenessTemplates.templates[0]) throw new Error('Completeness checklist template not found');
  const defectTemplate = defectTemplates.templates[0];
  const completenessTemplate = completenessTemplates.templates[0];

  let syncedDefectChecklists = 0;
  let syncedCompletenessChecklists = 0;

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
    const defectExisting = await getRepairChecklistForEngine(engineId, 'defect');
    if (!defectExisting.ok) throw new Error(`Failed to read defect checklist for engine ${engineNumber}: ${defectExisting.error}`);
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
      attachments: defectExisting.payload?.attachments ?? [],
    };
    const defectSave = await saveRepairChecklistForEngine({
      engineId,
      stage: 'defect',
      operationId: defectExisting.operationId ?? null,
      payload: defectPayload as any,
      actor: { id: actor.id, username: actor.username },
    });
    if (!defectSave.ok) throw new Error(`Failed to save defect checklist for engine ${engineNumber}: ${defectSave.error}`);
    syncedDefectChecklists += 1;

    const completenessRows = rows.map((r) => ({
      part_name: r.partName,
      assembly_unit_number: r.partNumber,
      quantity: r.quantity,
      present: false,
      actual_qty: 0,
    }));
    const completenessExisting = await getRepairChecklistForEngine(engineId, 'completeness');
    if (!completenessExisting.ok) {
      throw new Error(`Failed to read completeness checklist for engine ${engineNumber}: ${completenessExisting.error}`);
    }
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
      attachments: completenessExisting.payload?.attachments ?? [],
    };
    const completenessSave = await saveRepairChecklistForEngine({
      engineId,
      stage: 'completeness',
      operationId: completenessExisting.operationId ?? null,
      payload: completenessPayload as any,
      actor: { id: actor.id, username: actor.username },
    });
    if (!completenessSave.ok) {
      throw new Error(`Failed to save completeness checklist for engine ${engineNumber}: ${completenessSave.error}`);
    }
    syncedCompletenessChecklists += 1;
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
          syncedDefectChecklists,
          syncedCompletenessChecklists,
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

