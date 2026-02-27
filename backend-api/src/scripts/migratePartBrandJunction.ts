import 'dotenv/config';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { EntityTypeCode } from '@matricarmz/shared';

import type { AuthUser } from '../auth/jwt.js';
import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';
import { upsertPartBrandLink } from '../services/partsService.js';

type LegacyPartRecord = {
  assemblyUnitNumber: string | null;
  brandIds: string[];
  qtyByBrand: Map<string, number>;
};

type LegacyLinkRecord = {
  id: string;
  partId: string;
  engineBrandId: string;
  assemblyUnitNumber: string;
  quantity: number;
};

type LegacyValueRow = {
  entityId: string;
  attributeDefId: string;
  valueJson: string | null;
};

type MigrationSummary = {
  scannedParts: number;
  processedParts: number;
  linksUpserted: number;
  linksCreated: number;
  linksUpdated: number;
  skippedNoAssembly: number;
  skippedNoLegacyQtyOrBrands: number;
  skippedInvalidQty: number;
  skippedInvalidBrandIds: number;
  failedLinks: number;
  failures: Array<{ partId: string; engineBrandId: string; error: string }>;
  dryRun: boolean;
};

function nowMs() {
  return Date.now();
}

function cleanText(value: string | null | undefined): string {
  if (value == null) return '';
  return String(value)
    .replaceAll('\ufeff', '')
    .replaceAll('\u00a0', ' ')
    .replaceAll('\r', '')
    .replaceAll('\n', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonValue(valueJson: string | null | undefined): unknown {
  if (valueJson == null) return null;
  try {
    return JSON.parse(String(valueJson));
  } catch {
    return cleanText(valueJson) || null;
  }
}

function normalizeAssemblyUnitNumber(value: string | null | undefined): string {
  const cleaned = cleanText(value);
  if (!cleaned) return '';
  return cleaned
    .replace(/^\(?\s*(?:сб\.?|сборочной?\s*единицы?|sc\.?)\s*/i, '')
    .replace(/[\s,;]+$/g, '')
    .replace(/\)$/g, '')
    .trim();
}

function isValidUuid(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanText(value));
}

function parseBrandIds(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    const one = cleanText(raw);
    return one ? [one] : [];
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (item == null) continue;
    const text = cleanText(String(item));
    if (!text) continue;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

function parseQuantity(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }

  const text = cleanText(String(raw));
  if (!text) return null;
  const m = text.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const num = Number(m[0].replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function parseQtyMap(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [brandId, qtyRaw] of Object.entries(raw as Record<string, unknown>)) {
    const key = cleanText(brandId);
    if (!key) continue;
    const qty = parseQuantity(qtyRaw);
    if (qty == null || qty < 0) continue;
    out.set(key, qty);
  }
  return out;
}

function chunkBySize<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function ensureSuperadminActor(): Promise<AuthUser> {
  const id = await getSuperadminUserId();
  if (!id) throw new Error('Пользователь superadmin не найден');
  return { id, username: 'superadmin', role: 'superadmin' };
}

async function loadPartAttributeDefIds(partTypeId: string): Promise<{
  assemblyUnitNumberDefId: string | null;
  brandIdsDefId: string | null;
  qtyMapDefId: string | null;
}> {
  const rows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, partTypeId), isNull(attributeDefs.deletedAt)))
    .limit(10_000);

  const byCode = new Map<string, string>(rows.map((r) => [String(r.code), String(r.id)]));
  return {
    assemblyUnitNumberDefId: byCode.get('assembly_unit_number') ?? null,
    brandIdsDefId: byCode.get('engine_brand_ids') ?? null,
    qtyMapDefId: byCode.get('engine_brand_qty_map') ?? null,
  };
}

async function loadLegacyPartData(
  partTypeId: string,
  defIds: { assemblyUnitNumberDefId: string | null; brandIdsDefId: string | null; qtyMapDefId: string | null },
): Promise<Map<string, LegacyPartRecord>> {
  const partRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, partTypeId), isNull(entities.deletedAt)))
    .limit(500_000);
  const parts = new Map<string, LegacyPartRecord>();
  const ensureRecord = (partId: string) =>
    parts.get(partId) ?? { assemblyUnitNumber: null, brandIds: [], qtyByBrand: new Map<string, number>() };

  const neededDefs = [defIds.assemblyUnitNumberDefId, defIds.brandIdsDefId, defIds.qtyMapDefId].filter(Boolean) as string[];
  if (!neededDefs.length) return parts;
  if (!partRows.length) return parts;

  const partIds = partRows.map((r) => String(r.id));
  for (const chunk of chunkBySize(partIds, 2000)) {
    const valueRows: LegacyValueRow[] = await db
      .select({
        entityId: attributeValues.entityId,
        attributeDefId: attributeValues.attributeDefId,
        valueJson: attributeValues.valueJson,
      })
      .from(attributeValues)
      .where(
        and(
          inArray(attributeValues.entityId, chunk as any),
          inArray(attributeValues.attributeDefId, neededDefs as any),
          isNull(attributeValues.deletedAt),
        ),
      )
      .limit(1_200_000);

    for (const row of valueRows) {
      const partId = String(row.entityId);
      const rec = ensureRecord(partId);

      const parsed = parseJsonValue(row.valueJson);
      if (row.attributeDefId === defIds.assemblyUnitNumberDefId && typeof parsed === 'string') {
        rec.assemblyUnitNumber = normalizeAssemblyUnitNumber(parsed);
      }

      if (row.attributeDefId === defIds.brandIdsDefId) {
        const nextBrandIds = parseBrandIds(parsed);
        const unique = new Set(rec.brandIds.concat(nextBrandIds));
        rec.brandIds = [...unique];
      }

      if (row.attributeDefId === defIds.qtyMapDefId) {
        const nextMap = parseQtyMap(parsed);
        for (const [brandId, qty] of nextMap) {
          rec.qtyByBrand.set(brandId, qty);
        }
      }

      parts.set(partId, rec);
    }
  }

  return parts;
}

async function loadExistingPartBrandLinks(): Promise<Map<string, Map<string, LegacyLinkRecord>>> {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, EntityTypeCode.PartEngineBrand), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id ? String(typeRows[0].id) : null;
  if (!typeId) return new Map();

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)))
    .limit(20);

  const byCode = new Map(defs.map((r) => [String(r.code), String(r.id)]));
  const partIdDefId = byCode.get('part_id') ?? null;
  const engineBrandDefId = byCode.get('engine_brand_id') ?? null;
  const asmDefId = byCode.get('assembly_unit_number') ?? null;
  const qtyDefId = byCode.get('quantity') ?? null;
  if (!partIdDefId || !engineBrandDefId || !asmDefId || !qtyDefId) return new Map();

  const linkRows = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.typeId, typeId), isNull(entities.deletedAt))).limit(500_000);
  const linkIds = linkRows.map((r) => String(r.id));
  if (!linkIds.length) return new Map();

  const parsedByLink = new Map<string, Partial<LegacyLinkRecord>>();
  for (const chunk of chunkBySize(linkIds, 2000)) {
    const valueRows: LegacyValueRow[] = await db
      .select({
        entityId: attributeValues.entityId,
        attributeDefId: attributeValues.attributeDefId,
        valueJson: attributeValues.valueJson,
      })
      .from(attributeValues)
      .where(
        and(
          inArray(attributeValues.entityId, chunk as any),
          inArray(attributeValues.attributeDefId, [partIdDefId, engineBrandDefId, asmDefId, qtyDefId] as any),
          isNull(attributeValues.deletedAt),
        ),
      )
      .limit(1_500_000);

    for (const row of valueRows) {
      const linkId = String(row.entityId);
      const current = parsedByLink.get(linkId) ?? {};
      const parsed = parseJsonValue(row.valueJson);

      if (row.attributeDefId === partIdDefId && typeof parsed === 'string') {
        current.partId = cleanText(parsed);
      }

      if (row.attributeDefId === engineBrandDefId && typeof parsed === 'string') {
        current.engineBrandId = cleanText(parsed);
      }

      if (row.attributeDefId === asmDefId && typeof parsed === 'string') {
        current.assemblyUnitNumber = cleanText(parsed);
      }

      if (row.attributeDefId === qtyDefId) {
        const qty = parseQuantity(parsed);
        if (qty != null && qty >= 0) current.quantity = qty;
      }

      parsedByLink.set(linkId, current);
    }
  }

  const result = new Map<string, Map<string, LegacyLinkRecord>>();
  for (const [linkId, link] of parsedByLink.entries()) {
    if (!link.partId || !link.engineBrandId || !link.assemblyUnitNumber) continue;
    const asm = normalizeAssemblyUnitNumber(link.assemblyUnitNumber);
    if (!asm) continue;
    const byPart = result.get(link.partId) ?? new Map<string, LegacyLinkRecord>();
    byPart.set(`${link.engineBrandId}|${asm}`, {
      id: linkId,
      partId: link.partId,
      engineBrandId: link.engineBrandId,
      assemblyUnitNumber: asm,
      quantity: typeof link.quantity === 'number' && Number.isFinite(link.quantity) ? link.quantity : 0,
    });
    result.set(link.partId, byPart);
  }
  return result;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ignoreFailures = process.argv.includes('--ignore-failures');
  const actor = await ensureSuperadminActor();

  const summary: MigrationSummary = {
    scannedParts: 0,
    processedParts: 0,
    linksUpserted: 0,
    linksCreated: 0,
    linksUpdated: 0,
    skippedNoAssembly: 0,
    skippedNoLegacyQtyOrBrands: 0,
    skippedInvalidQty: 0,
    skippedInvalidBrandIds: 0,
    failedLinks: 0,
    failures: [],
    dryRun,
  };

  const partTypeRows = await db.select({ id: entityTypes.id }).from(entityTypes).where(and(eq(entityTypes.code, EntityTypeCode.Part), isNull(entityTypes.deletedAt))).limit(1);
  const partTypeId = partTypeRows[0]?.id ? String(partTypeRows[0].id) : null;
  if (!partTypeId) throw new Error('Тип сущности детали не найден');

  const defIds = await loadPartAttributeDefIds(partTypeId);
  if (!defIds.brandIdsDefId || !defIds.qtyMapDefId || !defIds.assemblyUnitNumberDefId) {
    throw new Error('Неполный legacy-набор атрибутов Part не найден (assembly_unit_number, engine_brand_ids, engine_brand_qty_map)');
  }

  const legacyByPart = await loadLegacyPartData(partTypeId, defIds);
  summary.scannedParts = legacyByPart.size;
  if (!summary.scannedParts) {
    console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
    return;
  }

  const existingPartBrandIndex = await loadExistingPartBrandLinks();
  const startAt = nowMs();

  for (const [partId, legacy] of legacyByPart) {
    const normalizedAssembly = normalizeAssemblyUnitNumber(legacy.assemblyUnitNumber);
    if (!normalizedAssembly) {
      summary.skippedNoAssembly += 1;
      continue;
    }

    const linksForPart = existingPartBrandIndex.get(partId) ?? new Map<string, LegacyLinkRecord>();
    const brandByQty = new Map<string, number>(legacy.qtyByBrand);
    const brandIds = new Set<string>();
    for (const rawBrandId of legacy.brandIds) {
      const brandId = cleanText(rawBrandId);
      if (!brandId) continue;
      if (!isValidUuid(brandId)) {
        summary.skippedInvalidBrandIds += 1;
        continue;
      }
      brandIds.add(brandId);
    }

    for (const brandId of legacy.qtyByBrand.keys()) {
      if (!isValidUuid(brandId)) {
        summary.skippedInvalidBrandIds += 1;
        continue;
      }
      brandIds.add(brandId);
    }

    if (!brandIds.size) {
      summary.skippedNoLegacyQtyOrBrands += 1;
      continue;
    }

    let touchedPart = false;
    for (const brandId of brandIds) {
      const qty = brandByQty.get(brandId);
      if (qty == null || !Number.isFinite(qty) || qty < 0) {
        summary.skippedInvalidQty += 1;
        continue;
      }

      const brandKey = `${brandId}|${normalizedAssembly}`;
      const existing = linksForPart.get(brandKey);

      const payload = {
        actor,
        partId,
        engineBrandId: brandId,
        assemblyUnitNumber: normalizedAssembly,
        quantity: qty,
        ...(existing ? { linkId: existing.id } : {}),
      };

      if (dryRun) {
        summary.linksUpserted += 1;
        if (existing) summary.linksUpdated += 1;
        else summary.linksCreated += 1;
      } else {
        const res = await upsertPartBrandLink(payload);
        if (!res.ok) {
          summary.failedLinks += 1;
          summary.failures.push({ partId, engineBrandId: brandId, error: res.error });
          continue;
        }
        summary.linksUpserted += 1;
        if (existing) summary.linksUpdated += 1;
        else summary.linksCreated += 1;
      }

      touchedPart = true;
    }

    if (touchedPart) summary.processedParts += 1;
  }

  const elapsedMs = nowMs() - startAt;
  console.log(
    JSON.stringify(
      {
        ok: summary.failedLinks === 0,
        elapsedMs,
        ...summary,
      },
      null,
      2,
    ),
  );

  if (!dryRun && summary.failedLinks > 0 && !ignoreFailures) {
    throw new Error(`Миграция завершена с ошибками: ${summary.failedLinks} ссылок не удалось создать/обновить`);
  }
}

main()
  .catch((e) => {
    console.error('[migratePartBrandJunction] ошибка', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
