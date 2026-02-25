import 'dotenv/config';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { RepairChecklistTemplate } from '@matricarmz/shared';
import { EntityTypeCode } from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';
import { getRepairChecklistForEngine, listRepairChecklistTemplates, saveRepairChecklistForEngine } from '../services/checklistService.js';
import { listParts } from '../services/partsService.js';

type EngineRow = {
  id: string;
  engineBrandId: string;
  engineNumber: string;
};

type DefectRow = {
  part_name: string;
  part_number: string;
  quantity: number;
  repairable_qty: number;
  scrap_qty: number;
};

type CompletenessRow = {
  part_name: string;
  assembly_unit_number: string;
  quantity: number;
  present: boolean;
  actual_qty: number;
};

function nowMs() {
  return Date.now();
}

function safeJsonParse(value: string | null | undefined): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function toQty(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function toDefectRows(parts: Array<{ id: string; name?: string; article?: string; brandLinks?: Array<{ engineBrandId: string; assemblyUnitNumber: string; quantity: number }> }>, engineBrandId: string): DefectRow[] {
  return parts
    .map((part) => {
      const links = Array.isArray(part.brandLinks) ? part.brandLinks : [];
      const link = links.find((x) => asText(x?.engineBrandId) === engineBrandId);
      if (!link) return null;
      const qty = toQty(link.quantity);
      return {
        part_name: asText(part.name) || asText(part.article) || part.id,
        part_number: asText(link.assemblyUnitNumber),
        quantity: qty,
        repairable_qty: qty,
        scrap_qty: 0,
      } satisfies DefectRow;
    })
    .filter((x): x is DefectRow => x != null)
    .sort((a, b) => (a.part_name + a.part_number).localeCompare(b.part_name + b.part_number, 'ru'));
}

function toCompletenessRows(parts: Array<{ id: string; name?: string; article?: string; brandLinks?: Array<{ engineBrandId: string; assemblyUnitNumber: string; quantity: number }> }>, engineBrandId: string): CompletenessRow[] {
  return parts
    .map((part) => {
      const links = Array.isArray(part.brandLinks) ? part.brandLinks : [];
      const link = links.find((x) => asText(x?.engineBrandId) === engineBrandId);
      if (!link) return null;
      const qty = toQty(link.quantity);
      const row: CompletenessRow = {
        part_name: asText(part.name) || asText(part.article) || part.id,
        assembly_unit_number: asText(link.assemblyUnitNumber),
        quantity: qty,
        present: false,
        actual_qty: 0,
      };
      return row;
    })
    .filter((x): x is CompletenessRow => x != null)
    .sort((a, b) => (a.part_name + a.assembly_unit_number).localeCompare(b.part_name + b.assembly_unit_number, 'ru'));
}

function normalizeDefectRows(rows: unknown): DefectRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const data = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      const qty = toQty(data.quantity);
      const repairable = toQty(data.repairable_qty);
      const scrap = toQty(data.scrap_qty);
      return {
        part_name: asText(data.part_name),
        part_number: asText(data.part_number),
        quantity: qty,
        repairable_qty: repairable,
        scrap_qty: scrap,
      } satisfies DefectRow;
    })
    .sort((a, b) => (a.part_name + a.part_number).localeCompare(b.part_name + b.part_number, 'ru'));
}

function normalizeCompletenessRows(rows: unknown): CompletenessRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const data = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      return {
        part_name: asText(data.part_name),
        assembly_unit_number: asText(data.assembly_unit_number),
        quantity: toQty(data.quantity),
        present: Boolean(data.present),
        actual_qty: toQty(data.actual_qty),
      } satisfies CompletenessRow;
    })
    .sort((a, b) => (a.part_name + a.assembly_unit_number).localeCompare(b.part_name + b.assembly_unit_number, 'ru'));
}

function rowsEqual(left: unknown, right: unknown, stage: 'defect' | 'completeness'): boolean {
  const a = stage === 'defect' ? normalizeDefectRows(left) : normalizeCompletenessRows(left);
  const b = stage === 'defect' ? normalizeDefectRows(right) : normalizeCompletenessRows(right);
  return JSON.stringify(a) === JSON.stringify(b);
}

function pickTemplate(templates: RepairChecklistTemplate[], stage: 'defect' | 'completeness'): RepairChecklistTemplate {
  const byStage = templates.filter((t) => t.stage === stage);
  const active = byStage.find((t) => t.active);
  const picked = active ?? byStage[0] ?? null;
  if (!picked) throw new Error(`Шаблон для stage="${stage}" не найден`);
  return picked;
}

function pickTableItemId(template: RepairChecklistTemplate, preferredId: string): string {
  const table = template.items.find((it) => it.kind === 'table' && it.id === preferredId)
    ?? template.items.find((it) => it.kind === 'table')
    ?? null;
  if (!table) throw new Error(`В шаблоне ${template.id} нет табличного поля`);
  return table.id;
}

async function loadEngineBrandNames(): Promise<Map<string, string>> {
  const typeRow = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, EntityTypeCode.EngineBrand), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRow[0]?.id ? String(typeRow[0].id) : '';
  if (!typeId) return new Map();

  const nameDef = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
    .limit(1);
  const nameDefId = nameDef[0]?.id ? String(nameDef[0].id) : '';
  if (!nameDefId) return new Map();

  const brandEntities = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, typeId), isNull(entities.deletedAt)))
    .limit(20000);
  const brandIds = brandEntities.map((x) => String(x.id));
  if (brandIds.length === 0) return new Map();

  const values = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.attributeDefId, nameDefId), inArray(attributeValues.entityId, brandIds as any), isNull(attributeValues.deletedAt)))
    .limit(40000);

  const out = new Map<string, string>();
  for (const row of values) {
    const parsed = safeJsonParse(row.valueJson == null ? null : String(row.valueJson));
    const name = asText(parsed);
    if (!name) continue;
    out.set(String(row.entityId), name);
  }
  return out;
}

async function loadEnginesWithBrand(): Promise<EngineRow[]> {
  const engineType = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, EntityTypeCode.Engine), isNull(entityTypes.deletedAt)))
    .limit(1);
  const engineTypeId = engineType[0]?.id ? String(engineType[0].id) : '';
  if (!engineTypeId) throw new Error('Тип сущности engine не найден');

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, engineTypeId), isNull(attributeDefs.deletedAt)))
    .limit(5000);
  const defByCode = new Map(defs.map((x) => [String(x.code), String(x.id)]));
  const engineBrandIdDefId = defByCode.get('engine_brand_id') ?? '';
  const engineNumberDefId = defByCode.get('engine_number') ?? '';
  if (!engineBrandIdDefId) throw new Error('Атрибут engine_brand_id не найден');

  const engineRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, engineTypeId), isNull(entities.deletedAt)))
    .limit(500000);
  const engineIds = engineRows.map((x) => String(x.id));
  if (engineIds.length === 0) return [];

  const defIds = [engineBrandIdDefId, engineNumberDefId].filter(Boolean);
  const values = await db
    .select({
      entityId: attributeValues.entityId,
      attributeDefId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, engineIds as any), inArray(attributeValues.attributeDefId, defIds as any), isNull(attributeValues.deletedAt)))
    .limit(1000000);

  const byEngine = new Map<string, { engineBrandId: string; engineNumber: string }>();
  for (const value of values) {
    const id = String(value.entityId);
    const current = byEngine.get(id) ?? { engineBrandId: '', engineNumber: '' };
    const parsed = safeJsonParse(value.valueJson == null ? null : String(value.valueJson));
    if (String(value.attributeDefId) === engineBrandIdDefId) current.engineBrandId = asText(parsed);
    if (engineNumberDefId && String(value.attributeDefId) === engineNumberDefId) current.engineNumber = asText(parsed);
    byEngine.set(id, current);
  }

  const out: EngineRow[] = [];
  for (const id of engineIds) {
    const row = byEngine.get(id);
    if (!row?.engineBrandId) continue;
    out.push({ id, engineBrandId: row.engineBrandId, engineNumber: row.engineNumber });
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const superadminId = await getSuperadminUserId();
  if (!superadminId) throw new Error('Не найден superadmin user');
  const actor = { id: superadminId, username: 'superadmin' };

  const templatesResult = await listRepairChecklistTemplates();
  if (!templatesResult.ok) throw new Error(`Не удалось загрузить шаблоны чеклистов: ${templatesResult.error}`);
  const defectTemplate = pickTemplate(templatesResult.templates, 'defect');
  const completenessTemplate = pickTemplate(templatesResult.templates, 'completeness');
  const defectTableId = pickTableItemId(defectTemplate, 'defect_items');
  const completenessTableId = pickTableItemId(completenessTemplate, 'completeness_items');

  const engineBrandNames = await loadEngineBrandNames();
  const engines = await loadEnginesWithBrand();

  const rowsCache = new Map<string, { defect: DefectRow[]; completeness: CompletenessRow[] }>();
  async function getRowsForBrand(engineBrandId: string) {
    const cached = rowsCache.get(engineBrandId);
    if (cached) return cached;
    const partsResult = await listParts({ limit: 5000, engineBrandId });
    if (!partsResult.ok) throw new Error(`Не удалось загрузить детали для марки ${engineBrandId}: ${partsResult.error}`);
    const built = {
      defect: toDefectRows(partsResult.parts as any, engineBrandId),
      completeness: toCompletenessRows(partsResult.parts as any, engineBrandId),
    };
    rowsCache.set(engineBrandId, built);
    return built;
  }

  let processed = 0;
  let updatedDefect = 0;
  let updatedCompleteness = 0;
  let skippedNoChanges = 0;
  const failures: Array<{ engineId: string; stage: 'defect' | 'completeness'; error: string }> = [];

  async function saveWithFallback(args: {
    engineId: string;
    stage: 'defect' | 'completeness';
    operationId: string | null;
    payload: Record<string, unknown>;
    dryRun: boolean;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (args.dryRun) return { ok: true };
    const first = await saveRepairChecklistForEngine({
      engineId: args.engineId,
      stage: args.stage,
      operationId: args.operationId,
      payload: args.payload as any,
      actor,
      allowSyncConflicts: true,
    });
    if (first.ok) return { ok: true };

    const err = String(first.error ?? '');
    const isJsonParseCrash = err.includes('Unexpected non-whitespace character after JSON');
    if (!isJsonParseCrash || !args.operationId) {
      return { ok: false, error: err || 'save failed' };
    }

    // Fallback for corrupted legacy operation payloads: create a fresh checklist operation.
    const second = await saveRepairChecklistForEngine({
      engineId: args.engineId,
      stage: args.stage,
      operationId: null,
      payload: args.payload as any,
      actor,
      allowSyncConflicts: true,
    });
    if (second.ok) return { ok: true };
    return { ok: false, error: String(second.error ?? err ?? 'save failed') };
  }

  for (const engine of engines) {
    processed += 1;
    const rows = await getRowsForBrand(engine.engineBrandId);
    const brandName = engineBrandNames.get(engine.engineBrandId) ?? '';

    for (const stage of ['defect', 'completeness'] as const) {
      try {
        const existing = await getRepairChecklistForEngine(engine.id, stage);
        if (!existing.ok) throw new Error(existing.error);

        const template = stage === 'defect' ? defectTemplate : completenessTemplate;
        const tableId = stage === 'defect' ? defectTableId : completenessTableId;
        const nextRows = stage === 'defect' ? rows.defect : rows.completeness;
        const existingRows = ((existing.payload as any)?.answers?.[tableId] as any)?.rows;
        if (rowsEqual(existingRows, nextRows, stage)) {
          skippedNoChanges += 1;
          continue;
        }

        const previousAnswers = (existing.payload as any)?.answers;
        const answers: Record<string, unknown> = previousAnswers && typeof previousAnswers === 'object' ? { ...(previousAnswers as Record<string, unknown>) } : {};
        answers[tableId] = { kind: 'table', rows: nextRows };
        if (!answers.engine_number && engine.engineNumber) {
          answers.engine_number = { kind: 'text', value: engine.engineNumber };
        }
        if (!answers.engine_brand && brandName) {
          answers.engine_brand = { kind: 'text', value: brandName };
        }

        const payload = {
          kind: 'repair_checklist' as const,
          templateId: String((existing.payload as any)?.templateId ?? template.id),
          templateVersion: Number((existing.payload as any)?.templateVersion ?? template.version ?? 1),
          stage,
          engineEntityId: engine.id,
          filledBy: actor.username,
          filledAt: nowMs(),
          answers,
          attachments: Array.isArray((existing.payload as any)?.attachments) ? (existing.payload as any).attachments : [],
        };

        const saved = await saveWithFallback({
          engineId: engine.id,
          stage,
          operationId: existing.operationId,
          payload: payload as any,
          dryRun,
        });
        if (!saved.ok) throw new Error(saved.error);

        if (stage === 'defect') updatedDefect += 1;
        else updatedCompleteness += 1;
      } catch (error) {
        failures.push({
          engineId: engine.id,
          stage,
          error: String(error),
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        dryRun,
        processedEngines: processed,
        uniqueBrands: rowsCache.size,
        updatedDefect,
        updatedCompleteness,
        skippedNoChanges,
        failuresCount: failures.length,
        failures: failures.slice(0, 100),
      },
      null,
      2,
    ),
  );

  if (!dryRun && failures.length > 0) {
    throw new Error(`Восстановление завершено с ошибками: ${failures.length}`);
  }
}

main()
  .catch((error) => {
    console.error('[restoreEngineChecklistParts] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
