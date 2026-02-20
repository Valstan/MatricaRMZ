import { existsSync, readFileSync } from 'node:fs';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AttributeDataType, EntityTypeCode } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';
import { createEntity, setEntityAttribute, upsertAttributeDef, upsertEntityType } from '../services/adminMasterdataService.js';
import { createPart, deletePart, listParts, updatePartAttribute } from '../services/partsService.js';
import type { AuthUser } from '../auth/jwt.js';

type ParsedPart = {
  name: string;
  assemblyUnitNumber: string | null;
  sourceLabel: string;
  brandKeys: Set<string>;
};

type ExistingPart = {
  id: string;
  createdAt: number;
  name: string;
  assemblyUnitNumber: string | null;
  brandIds: Set<string>;
};

const SOURCE_FILES = [
  '/home/valstan/111.txt',
  '/home/valstan/222.txt',
  '/home/valstan/333.txt',
  '/home/valstan/Сводная ведомость актов комплектности.csv',
  '/home/valstan/Сводная ведомость актов комплектности 2.csv',
  '/home/valstan/Сводная ведомость актов комплектности 3.csv',
  '/home/valstan/Сводная ведомость актов комплектности.xlsx',
] as const;

function normalizeSpaces(value: string): string {
  return value.replaceAll('\u00a0', ' ').replaceAll(/\s+/g, ' ').trim();
}

function cleanCell(value: string): string {
  return normalizeSpaces(String(value ?? '').replaceAll('\r', '').replaceAll('\n', ' ').replaceAll('\ufeff', ''));
}

function normalizeToken(value: string): string {
  return cleanCell(value)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/[^a-z0-9а-я]+/gi, '');
}

function normalizeHeaderToken(value: string): string {
  return cleanCell(value)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/\s+/g, ' ');
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
    if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((v) => cleanCell(v));
}

function detectDelimiter(line: string): ';' | '\t' {
  const semicolonCount = (line.match(/;/g) ?? []).length;
  const tabCount = (line.match(/\t/g) ?? []).length;
  return semicolonCount >= tabCount ? ';' : '\t';
}

function isPresenceCell(value: string): boolean {
  const v = cleanCell(value);
  if (!v) return false;
  if (/^\d+(?:[.,]\d+)?$/.test(v)) return Number(v.replace(',', '.')) > 0;
  if (/^(да|yes|y|\+)$/i.test(v)) return true;
  return false;
}

function isServiceHeader(header: string): boolean {
  const h = normalizeHeaderToken(header);
  if (!h) return true;
  const ignoredStarts = [
    'дата прихода',
    'дата отгрузки',
    'поставщик',
    'марка дв',
    'договор',
    'номер двигателя',
    'изменения от',
  ];
  return ignoredStarts.some((x) => h.startsWith(x));
}

function normalizeBrandKey(value: string): string {
  const base = cleanCell(value)
    .toUpperCase()
    .replaceAll('Ё', 'Е')
    .replaceAll(/["'«»]/g, '')
    .replaceAll(/[^0-9A-ZА-Я]+/g, '');

  if (base === 'В59У') return 'В59УМС';
  return base;
}

function toCanonicalBrandName(raw: string, brandKey: string): string {
  const known: Record<string, string> = {
    В59УМС: 'В-59 УМС',
    В84: 'В-84',
    В84АМС: 'В-84 АМС',
    В84ДТ: 'В-84 ДТ',
    В465С: 'В-46-5С',
    В462С1: 'В-46-2С1',
    В46: 'В-46',
  };
  const knownName = known[brandKey];
  if (knownName) return knownName;
  return cleanCell(raw).toUpperCase();
}

function stripQtySuffix(name: string): string {
  return name
    .replace(/,\s*\d+\s*шт\.?\s*$/i, '')
    .replace(/\(\s*100\s*%?\s*зам[^)]*\)\s*$/i, '')
    .replace(/\(\s*100%\s*зам[^)]*\)\s*$/i, '')
    .trim();
}

function parsePartDescriptor(rawHeader: string): { name: string; assemblyUnitNumber: string | null; sourceLabel: string } | null {
  const sourceLabel = cleanCell(rawHeader).replaceAll(/\s*;\s*/g, '; ');
  if (!sourceLabel) return null;

  let name = sourceLabel;
  let assemblyUnitNumber: string | null = null;

  // Частый формат: "<код/сб.> <наименование>".
  const m = name.match(/^((?:Сб\.?\s*)?[0-9][0-9A-Za-zА-Яа-я./,\- ]{3,60})\s+([А-ЯA-ZЁ].+)$/i);
  if (m?.[1] && m[2]) {
    const candidate = cleanCell(m[1]).replace(/,$/, '');
    const candidateTail = cleanCell(m[2]);
    if (candidate && candidateTail) {
      assemblyUnitNumber = candidate;
      name = candidateTail;
    }
  }

  name = stripQtySuffix(cleanCell(name));
  if (!name) return null;

  if (assemblyUnitNumber) {
    assemblyUnitNumber = cleanCell(assemblyUnitNumber);
    if (!assemblyUnitNumber) assemblyUnitNumber = null;
  }

  return { name, assemblyUnitNumber, sourceLabel };
}

function partKey(name: string, assemblyUnitNumber: string | null): string {
  return `${normalizeToken(name)}|${normalizeToken(assemblyUnitNumber ?? '')}`;
}

function parseFileToMap(
  filePath: string,
  brandNameByKey: Map<string, string>,
  partsByKey: Map<string, ParsedPart>,
): { processed: boolean; rowsUsed: number; linksFound: number; note?: string } {
  if (!existsSync(filePath)) {
    return { processed: false, rowsUsed: 0, linksFound: 0, note: 'missing' };
  }
  if (filePath.toLowerCase().endsWith('.xlsx')) {
    return { processed: false, rowsUsed: 0, linksFound: 0, note: 'xlsx is skipped in this script' };
  }

  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const headerLineIndex = lines.findIndex((line) => {
    const normalized = normalizeHeaderToken(line);
    return normalized.includes('марка дв') && normalized.includes('номер двигателя');
  });
  if (headerLineIndex < 0) {
    return { processed: false, rowsUsed: 0, linksFound: 0, note: 'header not found' };
  }

  const headerLine = lines[headerLineIndex] ?? '';
  const delimiter = detectDelimiter(headerLine);
  const headerCells = parseDelimitedLine(headerLine, delimiter);

  const brandCol = headerCells.findIndex((h) => normalizeHeaderToken(h).includes('марка дв'));
  const engineNumberCol = headerCells.findIndex((h) => normalizeHeaderToken(h).includes('номер двигателя'));
  if (brandCol < 0) {
    return { processed: false, rowsUsed: 0, linksFound: 0, note: 'brand column not found' };
  }

  const partStart = engineNumberCol >= 0 ? engineNumberCol + 1 : brandCol + 1;
  const partColumns: number[] = [];
  for (let i = partStart; i < headerCells.length; i += 1) {
    const header = headerCells[i] ?? '';
    if (isServiceHeader(header)) continue;
    partColumns.push(i);
  }
  if (partColumns.length === 0) {
    return { processed: false, rowsUsed: 0, linksFound: 0, note: 'part columns not found' };
  }

  let rowsUsed = 0;
  let linksFound = 0;

  for (let i = headerLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim()) continue;
    const row = parseDelimitedLine(line, delimiter);
    if (row.every((cell) => !cell)) continue;

    const brandRaw = cleanCell(row[brandCol] ?? '');
    if (!brandRaw) continue;
    const lowered = brandRaw.toLowerCase();
    if (lowered.startsWith('начальник') || lowered.startsWith('экономист')) continue;

    const brandKey = normalizeBrandKey(brandRaw);
    if (!brandKey) continue;
    if (!brandNameByKey.has(brandKey)) {
      brandNameByKey.set(brandKey, toCanonicalBrandName(brandRaw, brandKey));
    }

    let rowHadLinks = false;
    for (const col of partColumns) {
      const cell = cleanCell(row[col] ?? '');
      if (!isPresenceCell(cell)) continue;

      const rawHeader = cleanCell(headerCells[col] ?? '');
      const parsedPart = parsePartDescriptor(rawHeader);
      if (!parsedPart) continue;
      const key = partKey(parsedPart.name, parsedPart.assemblyUnitNumber);
      const existing = partsByKey.get(key);
      if (existing) {
        existing.brandKeys.add(brandKey);
      } else {
        partsByKey.set(key, {
          name: parsedPart.name,
          assemblyUnitNumber: parsedPart.assemblyUnitNumber,
          sourceLabel: parsedPart.sourceLabel,
          brandKeys: new Set([brandKey]),
        });
      }
      rowHadLinks = true;
      linksFound += 1;
    }

    if (rowHadLinks) rowsUsed += 1;
  }

  return { processed: true, rowsUsed, linksFound };
}

function parseJsonString(valueJson: string | null): string | null {
  if (valueJson == null) return null;
  try {
    const parsed = JSON.parse(valueJson);
    if (typeof parsed === 'string') return parsed;
    if (parsed == null) return null;
    return String(parsed);
  } catch {
    return valueJson;
  }
}

function parseJsonStringArray(valueJson: string | null): string[] {
  if (!valueJson) return [];
  try {
    const parsed = JSON.parse(valueJson);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
    }
    return [];
  } catch {
    return [];
  }
}

function tryExtractDuplicateId(errorText: string): string | null {
  const m = errorText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return m?.[0] ? String(m[0]) : null;
}

async function getEntityTypeIdByCode(code: string): Promise<string | null> {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function ensureActor(): Promise<AuthUser> {
  const superadminId = await getSuperadminUserId();
  if (!superadminId) {
    throw new Error('Не найден superadmin для выполнения импорта');
  }
  return { id: superadminId, username: 'superadmin', role: 'superadmin' };
}

async function ensureBrandTypeInfra(actor: AuthUser): Promise<{ brandTypeId: string; brandNameDefId: string }> {
  const typeResult = await upsertEntityType(actor, {
    code: EntityTypeCode.EngineBrand,
    name: 'Марка двигателя',
  });
  if (!typeResult.ok || !typeResult.id) {
    throw new Error('Не удалось подготовить entity_type engine_brand');
  }

  const brandTypeId = typeResult.id;
  const defResult = await upsertAttributeDef(actor, {
    entityTypeId: brandTypeId,
    code: 'name',
    name: 'Название',
    dataType: AttributeDataType.Text,
    sortOrder: 10,
  });
  if (!defResult.ok || !defResult.id) {
    throw new Error('Не удалось подготовить attribute_def engine_brand.name');
  }

  return { brandTypeId, brandNameDefId: defResult.id };
}

async function ensurePartInfra(): Promise<{ partTypeId: string; partNameDefId: string; partAssemblyDefId: string | null }> {
  const warmup = await listParts({ limit: 1 });
  if (!warmup.ok) {
    throw new Error(`Не удалось инициализировать тип "part": ${warmup.error}`);
  }

  const partTypeId = await getEntityTypeIdByCode(EntityTypeCode.Part);
  if (!partTypeId) throw new Error('Не найден entity_type part');

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, partTypeId as any), isNull(attributeDefs.deletedAt)));

  const byCode = new Map(defs.map((d) => [String(d.code), String(d.id)]));
  const partNameDefId = byCode.get('name');
  if (!partNameDefId) throw new Error('Не найден attribute_def part.name');

  const partAssemblyDefId = byCode.get('assembly_unit_number') ?? null;
  return { partTypeId, partNameDefId, partAssemblyDefId };
}

async function loadExistingBrands(brandTypeId: string, brandNameDefId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      entityId: entities.id,
      createdAt: entities.createdAt,
      valueJson: attributeValues.valueJson,
    })
    .from(entities)
    .innerJoin(attributeValues, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(entities.typeId, brandTypeId as any),
        isNull(entities.deletedAt),
        eq(attributeValues.attributeDefId, brandNameDefId as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(100_000);

  type Item = { id: string; createdAt: number };
  const bestByKey = new Map<string, Item>();
  for (const row of rows) {
    const brandName = parseJsonString(row.valueJson == null ? null : String(row.valueJson));
    if (!brandName) continue;
    const key = normalizeBrandKey(brandName);
    if (!key) continue;
    const cur = bestByKey.get(key);
    const candidate: Item = { id: String(row.entityId), createdAt: Number(row.createdAt) };
    if (!cur || candidate.createdAt < cur.createdAt || (candidate.createdAt === cur.createdAt && candidate.id < cur.id)) {
      bestByKey.set(key, candidate);
    }
  }

  const out = new Map<string, string>();
  for (const [key, value] of bestByKey.entries()) out.set(key, value.id);
  return out;
}

async function loadExistingParts(partTypeId: string): Promise<Map<string, ExistingPart>> {
  const partRows = await db
    .select({ id: entities.id, createdAt: entities.createdAt })
    .from(entities)
    .where(and(eq(entities.typeId, partTypeId as any), isNull(entities.deletedAt)))
    .limit(200_000);

  const partIds = partRows.map((r) => String(r.id));
  if (partIds.length === 0) return new Map();

  const defs = ['name', 'assembly_unit_number', 'engine_brand_ids'];
  const defRows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, partTypeId as any), isNull(attributeDefs.deletedAt), inArray(attributeDefs.code, defs as any)))
    .limit(100);
  const defByCode = new Map(defRows.map((d) => [String(d.code), String(d.id)]));

  const valueDefIds = [defByCode.get('name'), defByCode.get('assembly_unit_number'), defByCode.get('engine_brand_ids')].filter(
    Boolean,
  ) as string[];
  if (valueDefIds.length === 0) return new Map();

  const valueRows = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, partIds as any),
        inArray(attributeValues.attributeDefId, valueDefIds as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(500_000);

  const out = new Map<string, ExistingPart>();
  for (const row of partRows) {
    out.set(String(row.id), {
      id: String(row.id),
      createdAt: Number(row.createdAt),
      name: '',
      assemblyUnitNumber: null,
      brandIds: new Set<string>(),
    });
  }

  const nameDefId = defByCode.get('name') ?? null;
  const assemblyDefId = defByCode.get('assembly_unit_number') ?? null;
  const brandIdsDefId = defByCode.get('engine_brand_ids') ?? null;

  for (const row of valueRows) {
    const part = out.get(String(row.entityId));
    if (!part) continue;
    const defId = String(row.attributeDefId);
    const valueJson = row.valueJson == null ? null : String(row.valueJson);
    if (nameDefId && defId === nameDefId) {
      part.name = parseJsonString(valueJson) ?? '';
    } else if (assemblyDefId && defId === assemblyDefId) {
      part.assemblyUnitNumber = parseJsonString(valueJson);
    } else if (brandIdsDefId && defId === brandIdsDefId) {
      const brandIds = parseJsonStringArray(valueJson);
      part.brandIds = new Set(brandIds);
    }
  }

  return out;
}

async function dedupeExistingParts(
  actor: AuthUser,
  existingParts: Map<string, ExistingPart>,
): Promise<{ dedupedGroups: number; deletedDuplicates: number; updatedKeepers: number }> {
  const groups = new Map<string, ExistingPart[]>();
  for (const part of existingParts.values()) {
    if (!part.name.trim()) continue;
    const key = partKey(part.name, part.assemblyUnitNumber);
    const arr = groups.get(key) ?? [];
    arr.push(part);
    groups.set(key, arr);
  }

  let dedupedGroups = 0;
  let deletedDuplicates = 0;
  let updatedKeepers = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    dedupedGroups += 1;

    const sorted = [...group].sort((a, b) => {
      if (a.brandIds.size !== b.brandIds.size) return b.brandIds.size - a.brandIds.size;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });
    const keeper = sorted[0];
    if (!keeper) continue;
    const duplicates = sorted.slice(1);

    const mergedBrandIds = new Set<string>(keeper.brandIds);
    for (const row of duplicates) {
      for (const brandId of row.brandIds) mergedBrandIds.add(brandId);
    }

    for (const row of duplicates) {
      const deleted = await deletePart({ partId: row.id, actor });
      if (!deleted.ok) {
        throw new Error(`Не удалось удалить дубль детали ${row.id}: ${deleted.error}`);
      }
      existingParts.delete(row.id);
      deletedDuplicates += 1;
    }

    if (mergedBrandIds.size !== keeper.brandIds.size) {
      const update = await updatePartAttribute({
        partId: keeper.id,
        attributeCode: 'engine_brand_ids',
        value: [...mergedBrandIds].sort((a, b) => a.localeCompare(b)),
        actor,
      });
      if (!update.ok) {
        throw new Error(`Не удалось обновить keeper детали ${keeper.id}: ${update.error ?? 'unknown'}`);
      }
      keeper.brandIds = mergedBrandIds;
      updatedKeepers += 1;
    }
  }

  return { dedupedGroups, deletedDuplicates, updatedKeepers };
}

function buildPartIndices(existingParts: Map<string, ExistingPart>): {
  idsByExactKey: Map<string, string[]>;
  idsByNameOnly: Map<string, string[]>;
} {
  const idsByExactKey = new Map<string, string[]>();
  const idsByNameOnly = new Map<string, string[]>();

  const sorted = [...existingParts.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });

  for (const part of sorted) {
    if (!part.name) continue;
    const exact = partKey(part.name, part.assemblyUnitNumber);
    const byExact = idsByExactKey.get(exact) ?? [];
    byExact.push(part.id);
    idsByExactKey.set(exact, byExact);

    const byName = idsByNameOnly.get(normalizeToken(part.name)) ?? [];
    byName.push(part.id);
    idsByNameOnly.set(normalizeToken(part.name), byName);
  }

  return { idsByExactKey, idsByNameOnly };
}

function pickSingle(ids: string[] | undefined): string | null {
  if (!ids || ids.length !== 1) return null;
  return ids[0] ?? null;
}

async function main() {
  const startedAt = Date.now();
  const actor = await ensureActor();

  const brandNameByKey = new Map<string, string>();
  const partsByKey = new Map<string, ParsedPart>();
  const fileStats: Array<{ file: string; processed: boolean; rowsUsed: number; linksFound: number; note?: string }> = [];

  for (const filePath of SOURCE_FILES) {
    const stat = parseFileToMap(filePath, brandNameByKey, partsByKey);
    fileStats.push({ file: filePath, ...stat });
  }

  if (brandNameByKey.size === 0 || partsByKey.size === 0) {
    throw new Error('Не удалось извлечь марки/детали из входных файлов');
  }

  const { brandTypeId, brandNameDefId } = await ensureBrandTypeInfra(actor);
  const { partTypeId } = await ensurePartInfra();

  const brandIdByKey = await loadExistingBrands(brandTypeId, brandNameDefId);
  let createdBrands = 0;

  for (const [brandKey, brandName] of [...brandNameByKey.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'))) {
    if (brandIdByKey.has(brandKey)) continue;

    const created = await createEntity(actor, brandTypeId);
    if (!created.ok || !created.id) {
      throw new Error(`Не удалось создать марку двигателя: ${brandName}`);
    }
    const setResult = await setEntityAttribute(actor, created.id, 'name', brandName);
    if (!setResult.ok) {
      const duplicateId = tryExtractDuplicateId(setResult.error ?? '');
      if (duplicateId) {
        brandIdByKey.set(brandKey, duplicateId);
        continue;
      }
      throw new Error(`Не удалось сохранить марку двигателя "${brandName}": ${setResult.error}`);
    }

    brandIdByKey.set(brandKey, created.id);
    createdBrands += 1;
  }

  const existingParts = await loadExistingParts(partTypeId);
  const dedupeResult = await dedupeExistingParts(actor, existingParts);
  let { idsByExactKey, idsByNameOnly } = buildPartIndices(existingParts);

  let createdParts = 0;
  let linkedPartsUpdated = 0;
  let skippedPartRows = 0;
  const unresolvedParts: string[] = [];

  const partBrandsToApply = new Map<string, Set<string>>();

  for (const [parsedKey, parsedPart] of partsByKey.entries()) {
    let partId = pickSingle(idsByExactKey.get(parsedKey));
    if (!partId && !parsedPart.assemblyUnitNumber) {
      partId = pickSingle(idsByNameOnly.get(normalizeToken(parsedPart.name)));
    }

    if (!partId) {
      const attrs: Record<string, unknown> = { name: parsedPart.name };
      if (parsedPart.assemblyUnitNumber) attrs.assembly_unit_number = parsedPart.assemblyUnitNumber;

      const created = await createPart({ actor, attributes: attrs });
      if (!created.ok) {
        const duplicateId = tryExtractDuplicateId(created.error ?? '');
        if (duplicateId) {
          partId = duplicateId;
        } else {
          skippedPartRows += 1;
          unresolvedParts.push(`${parsedPart.name}${parsedPart.assemblyUnitNumber ? ` [${parsedPart.assemblyUnitNumber}]` : ''}`);
          continue;
        }
      } else {
        partId = created.part.id;
        createdParts += 1;

        existingParts.set(partId, {
          id: partId,
          createdAt: Date.now(),
          name: parsedPart.name,
          assemblyUnitNumber: parsedPart.assemblyUnitNumber,
          brandIds: new Set<string>(),
        });
        ({ idsByExactKey, idsByNameOnly } = buildPartIndices(existingParts));
      }
    }

    if (!partId) {
      skippedPartRows += 1;
      continue;
    }

    const targetBrandIds = partBrandsToApply.get(partId) ?? new Set<string>();
    for (const brandKey of parsedPart.brandKeys) {
      const brandId = brandIdByKey.get(brandKey);
      if (brandId) targetBrandIds.add(brandId);
    }
    if (targetBrandIds.size > 0) {
      partBrandsToApply.set(partId, targetBrandIds);
    }
  }

  for (const [partId, addBrandIds] of partBrandsToApply.entries()) {
    const existing = existingParts.get(partId);
    const currentBrandIds = existing?.brandIds ?? new Set<string>();
    const next = new Set<string>([...currentBrandIds, ...addBrandIds]);
    if (next.size === currentBrandIds.size) continue;

    const update = await updatePartAttribute({
      partId,
      attributeCode: 'engine_brand_ids',
      value: [...next].sort((a, b) => a.localeCompare(b)),
      actor,
    });
    if (!update.ok) {
      unresolvedParts.push(`partId=${partId} (update engine_brand_ids failed: ${update.error ?? 'unknown'})`);
      continue;
    }

    linkedPartsUpdated += 1;
    if (existing) existing.brandIds = next;
  }

  const finishedAt = Date.now();
  const elapsedMs = finishedAt - startedAt;

  console.log('[import] done');
  console.log(
    JSON.stringify(
      {
        files: fileStats,
        parsed: {
          brands: brandNameByKey.size,
          parts: partsByKey.size,
        },
        dbChanges: {
          createdBrands,
          dedupedPartGroups: dedupeResult.dedupedGroups,
          deletedDuplicateParts: dedupeResult.deletedDuplicates,
          updatedPartKeepers: dedupeResult.updatedKeepers,
          createdParts,
          linkedPartsUpdated,
          skippedPartRows,
        },
        unresolvedPartsPreview: unresolvedParts.slice(0, 30),
        unresolvedPartsTotal: unresolvedParts.length,
        elapsedMs,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error('[import] failed', error);
  process.exit(1);
});
