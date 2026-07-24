import { randomUUID } from 'node:crypto';

import type {
  RepairNormLine,
  RepairNormSetDetails,
  RepairNormSetInput,
  RepairNormSetStatus,
  RepairNormSetSummary,
} from '@matricarmz/shared';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { db } from '../database/db.js';
import {
  entities,
  entityTypes,
  erpNomenclature,
  repairNormLines,
  repairNormSetBrandLinks,
  repairNormSets,
} from '../database/schema.js';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function validateReferences(engineBrandIds: string[], nomenclatureIds: string[]): Promise<string | null> {
  const uniqueBrands = [...new Set(engineBrandIds)];
  const brandRows = uniqueBrands.length
    ? await db
        .select({ id: entities.id, typeCode: entityTypes.code })
        .from(entities)
        .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
        .where(and(inArray(entities.id, uniqueBrands as any), isNull(entities.deletedAt), isNull(entityTypes.deletedAt)))
    : [];
  const validBrands = new Set(brandRows.filter((row) => row.typeCode === 'engine_brand').map((row) => String(row.id)));
  const invalidBrand = uniqueBrands.find((id) => !validBrands.has(id));
  if (invalidBrand) return `engineBrandIds: ссылка ${invalidBrand} не существует или имеет тип, отличный от engine_brand`;

  const uniqueNomenclature = [...new Set(nomenclatureIds)];
  const nomenclatureRows = uniqueNomenclature.length
    ? await db
        .select({ id: erpNomenclature.id })
        .from(erpNomenclature)
        .where(and(inArray(erpNomenclature.id, uniqueNomenclature as any), isNull(erpNomenclature.deletedAt)))
    : [];
  const validNomenclature = new Set(nomenclatureRows.map((row) => String(row.id)));
  const invalidNomenclature = uniqueNomenclature.find((id) => !validNomenclature.has(id));
  return invalidNomenclature
    ? `lines.nomenclatureId: ссылка ${invalidNomenclature} не существует или удалена`
    : null;
}

async function loadBrandIds(normSetIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (normSetIds.length === 0) return result;
  const rows = await db
    .select({ normSetId: repairNormSetBrandLinks.normSetId, engineBrandId: repairNormSetBrandLinks.engineBrandId })
    .from(repairNormSetBrandLinks)
    .where(and(inArray(repairNormSetBrandLinks.normSetId, normSetIds as any), isNull(repairNormSetBrandLinks.deletedAt)));
  for (const row of rows) {
    const setId = String(row.normSetId);
    const values = result.get(setId) ?? [];
    values.push(String(row.engineBrandId));
    result.set(setId, values);
  }
  return result;
}

export async function listRepairNormSets(args: {
  engineBrandId?: string;
  status?: RepairNormSetStatus;
} = {}): Promise<Result<{ rows: RepairNormSetSummary[] }>> {
  try {
    const conditions = [isNull(repairNormSets.deletedAt)];
    if (args.status) conditions.push(eq(repairNormSets.status, args.status));
    if (args.engineBrandId) {
      conditions.push(sql`exists (
        select 1 from repair_norm_set_brand_links l
        where l.norm_set_id = ${repairNormSets.id}
          and l.engine_brand_id = ${args.engineBrandId}
          and l.deleted_at is null
      )`);
    }
    const headers = await db
      .select({
        id: repairNormSets.id,
        name: repairNormSets.name,
        version: repairNormSets.version,
        status: repairNormSets.status,
        sourceKind: repairNormSets.sourceKind,
        sourceKey: repairNormSets.sourceKey,
        sourceImportedAt: repairNormSets.sourceImportedAt,
        sourceContentHash: repairNormSets.sourceContentHash,
        notes: repairNormSets.notes,
        createdAt: repairNormSets.createdAt,
        updatedAt: repairNormSets.updatedAt,
        lineCount: sql<number>`count(${repairNormLines.id})`,
      })
      .from(repairNormSets)
      .leftJoin(
        repairNormLines,
        and(eq(repairNormLines.normSetId, repairNormSets.id), isNull(repairNormLines.deletedAt)),
      )
      .where(and(...conditions))
      .groupBy(repairNormSets.id)
      .orderBy(desc(repairNormSets.status), desc(repairNormSets.updatedAt));
    const brandsBySet = await loadBrandIds(headers.map((row) => String(row.id)));
    return {
      ok: true,
      rows: headers.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        version: Number(row.version),
        status: row.status as RepairNormSetStatus,
        sourceKind: row.sourceKind,
        sourceKey: row.sourceKey,
        sourceImportedAt: row.sourceImportedAt,
        sourceContentHash: row.sourceContentHash,
        notes: row.notes,
        engineBrandIds: brandsBySet.get(String(row.id)) ?? [],
        lineCount: Number(row.lineCount ?? 0),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      })),
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function getRepairNormSet(id: string): Promise<Result<{ normSet: RepairNormSetDetails }>> {
  try {
    const list = await listRepairNormSets();
    if (!list.ok) return list;
    const header = list.rows.find((row) => row.id === id);
    if (!header) return { ok: false, error: 'Набор норм не найден' };
    const rows = await db
      .select({
        id: repairNormLines.id,
        normSetId: repairNormLines.normSetId,
        nomenclatureId: repairNormLines.nomenclatureId,
        nomenclatureName: erpNomenclature.name,
        nomenclatureCode: erpNomenclature.code,
        qtyPerEngine: repairNormLines.qtyPerEngine,
        replacementPercent: repairNormLines.replacementPercent,
        groupName: repairNormLines.groupName,
        sourceRowKey: repairNormLines.sourceRowKey,
        sourceMetaJson: repairNormLines.sourceMetaJson,
        position: repairNormLines.position,
      })
      .from(repairNormLines)
      .innerJoin(erpNomenclature, eq(erpNomenclature.id, repairNormLines.nomenclatureId))
      .where(and(eq(repairNormLines.normSetId, id as any), isNull(repairNormLines.deletedAt)))
      .orderBy(asc(repairNormLines.position), asc(repairNormLines.createdAt));
    const lines: RepairNormLine[] = rows.map((row) => ({
      id: String(row.id),
      normSetId: String(row.normSetId),
      nomenclatureId: String(row.nomenclatureId),
      nomenclatureName: String(row.nomenclatureName),
      nomenclatureCode: String(row.nomenclatureCode ?? ''),
      qtyPerEngine: Number(row.qtyPerEngine),
      replacementPercent: Number(row.replacementPercent),
      groupName: row.groupName,
      sourceRowKey: row.sourceRowKey,
      sourceMeta: parseJsonObject(row.sourceMetaJson),
      position: Number(row.position),
    }));
    return { ok: true, normSet: { ...header, lines } };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function upsertRepairNormSet(input: RepairNormSetInput): Promise<Result<{ normSet: RepairNormSetDetails }>> {
  try {
    const id = String(input.id ?? randomUUID()).trim();
    const name = input.name.trim();
    if (!name) return { ok: false, error: 'name обязателен' };
    const engineBrandIds = [...new Set(input.engineBrandIds.map((value) => value.trim()).filter(Boolean))];
    if (engineBrandIds.length === 0) return { ok: false, error: 'engineBrandIds обязателен' };
    if (input.lines.length === 0) return { ok: false, error: 'Набор норм должен содержать хотя бы одну строку' };
    for (const [index, line] of input.lines.entries()) {
      if (!Number.isFinite(line.qtyPerEngine) || line.qtyPerEngine <= 0) {
        return { ok: false, error: `lines[${index}].qtyPerEngine должен быть больше нуля` };
      }
      if (!Number.isFinite(line.replacementPercent) || line.replacementPercent < 0 || line.replacementPercent > 100) {
        return { ok: false, error: `lines[${index}].replacementPercent должен быть от 0 до 100` };
      }
    }
    const referenceError = await validateReferences(engineBrandIds, input.lines.map((line) => line.nomenclatureId));
    if (referenceError) return { ok: false, error: referenceError };
    const status = input.status ?? 'draft';
    if (status === 'active') {
      const conflicts = await db
        .select({ setId: repairNormSetBrandLinks.normSetId })
        .from(repairNormSetBrandLinks)
        .innerJoin(repairNormSets, eq(repairNormSets.id, repairNormSetBrandLinks.normSetId))
        .where(
          and(
            inArray(repairNormSetBrandLinks.engineBrandId, engineBrandIds as any),
            isNull(repairNormSetBrandLinks.deletedAt),
            isNull(repairNormSets.deletedAt),
            eq(repairNormSets.status, 'active'),
            ne(repairNormSets.id, id as any),
          ),
        )
        .limit(1);
      if (conflicts.length > 0) return { ok: false, error: 'Для одной из выбранных марок уже действует другой набор норм' };
    }

    const now = Date.now();
    await db.transaction(async (tx) => {
      const existing = await tx.select({ id: repairNormSets.id }).from(repairNormSets).where(eq(repairNormSets.id, id as any)).limit(1);
      const values = {
        name,
        version: Math.max(1, Math.trunc(input.version ?? 1)),
        status,
        sourceKind: input.sourceKind ?? null,
        sourceKey: input.sourceKey ?? null,
        sourceImportedAt: input.sourceImportedAt ?? null,
        sourceContentHash: input.sourceContentHash ?? null,
        notes: input.notes ?? null,
        updatedAt: now,
        deletedAt: null,
      };
      if (existing.length > 0) await tx.update(repairNormSets).set(values).where(eq(repairNormSets.id, id as any));
      else await tx.insert(repairNormSets).values({ id, ...values, createdAt: now });

      await tx
        .update(repairNormSetBrandLinks)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(repairNormSetBrandLinks.normSetId, id as any), isNull(repairNormSetBrandLinks.deletedAt)));
      await tx.insert(repairNormSetBrandLinks).values(
        engineBrandIds.map((engineBrandId) => ({
          id: randomUUID(),
          normSetId: id,
          engineBrandId,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })),
      );

      await tx
        .update(repairNormLines)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(repairNormLines.normSetId, id as any), isNull(repairNormLines.deletedAt)));
      await tx.insert(repairNormLines).values(
        input.lines.map((line, index) => ({
          id: randomUUID(),
          normSetId: id,
          nomenclatureId: line.nomenclatureId,
          qtyPerEngine: String(line.qtyPerEngine),
          replacementPercent: String(line.replacementPercent),
          groupName: line.groupName ?? null,
          sourceRowKey: line.sourceRowKey ?? null,
          sourceMetaJson: line.sourceMeta ? JSON.stringify(line.sourceMeta) : null,
          position: line.position ?? index,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })),
      );
    });
    return getRepairNormSet(id);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
