import { and, asc, eq } from 'drizzle-orm';

import {
  ENGINE_ACT_TEMPLATE_NAME_MAX,
  emptyEngineActTemplatePayload,
  isValidEngineActTemplateName,
  type EngineActTemplateDto,
  type EngineActTemplatePayload,
  type EngineActTemplateSummary,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { engineActTemplates } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

export type { EngineActTemplateDto, EngineActTemplatePayload, EngineActTemplateSummary };

function nowMs() {
  return Date.now();
}

function parsePayload(raw: string | null | undefined): EngineActTemplatePayload {
  const empty = emptyEngineActTemplatePayload();
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const p = parsed as Record<string, unknown>;
    return {
      commissionMembers: Array.isArray(p.commissionMembers) ? (p.commissionMembers as EngineActTemplatePayload['commissionMembers']) : [],
      approverGrif: p.approverGrif && typeof p.approverGrif === 'object' && !Array.isArray(p.approverGrif) ? (p.approverGrif as EngineActTemplatePayload['approverGrif']) : {},
      conditionItems: Array.isArray(p.conditionItems) ? (p.conditionItems as EngineActTemplatePayload['conditionItems']) : [],
    };
  } catch {
    return empty;
  }
}

function rowToDto(row: typeof engineActTemplates.$inferSelect): EngineActTemplateDto {
  return {
    id: String(row.id),
    engineBrandId: String(row.engineBrandId),
    name: String(row.name),
    payload: parsePayload(row.payloadJson),
    updatedAt: Number(row.updatedAt),
    updatedBy: row.updatedBy ?? null,
  };
}

function normalizeBrandId(raw: unknown): Result<{ engineBrandId: string }> {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, error: 'Марка двигателя (engineBrandId) обязательна' };
  return { ok: true, engineBrandId: value };
}

function normalizeName(raw: unknown): Result<{ name: string }> {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, error: 'Название шаблона обязательно' };
  if (!isValidEngineActTemplateName(value)) {
    return { ok: false, error: `Название шаблона не должно превышать ${ENGINE_ACT_TEMPLATE_NAME_MAX} символов` };
  }
  return { ok: true, name: value };
}

function normalizePayload(raw: unknown): Result<{ payload: EngineActTemplatePayload }> {
  const empty = emptyEngineActTemplatePayload();
  if (raw === undefined || raw === null) return { ok: true, payload: empty };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'payload должно быть объектом' };
  }
  const p = raw as Record<string, unknown>;
  return {
    ok: true,
    payload: {
      commissionMembers: Array.isArray(p.commissionMembers) ? (p.commissionMembers as EngineActTemplatePayload['commissionMembers']) : [],
      approverGrif: p.approverGrif && typeof p.approverGrif === 'object' && !Array.isArray(p.approverGrif) ? (p.approverGrif as EngineActTemplatePayload['approverGrif']) : {},
      conditionItems: Array.isArray(p.conditionItems) ? (p.conditionItems as EngineActTemplatePayload['conditionItems']) : [],
    },
  };
}

export async function listEngineActTemplates(
  filter: { engineBrandId?: unknown } = {},
): Promise<Result<{ templates: EngineActTemplateSummary[] }>> {
  try {
    let rows: Array<typeof engineActTemplates.$inferSelect>;
    if (filter.engineBrandId !== undefined) {
      const brand = normalizeBrandId(filter.engineBrandId);
      if (!brand.ok) return brand;
      rows = await db
        .select()
        .from(engineActTemplates)
        .where(eq(engineActTemplates.engineBrandId, brand.engineBrandId))
        .orderBy(asc(engineActTemplates.name));
    } else {
      rows = await db.select().from(engineActTemplates).orderBy(asc(engineActTemplates.engineBrandId), asc(engineActTemplates.name));
    }
    const templates = rows.map((row): EngineActTemplateSummary => ({
      id: String(row.id),
      engineBrandId: String(row.engineBrandId),
      name: String(row.name),
      updatedAt: Number(row.updatedAt),
    }));
    return { ok: true, templates };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getEngineActTemplateById(id: string): Promise<Result<{ template: EngineActTemplateDto }>> {
  try {
    const tid = String(id || '').trim();
    if (!tid) return { ok: false, error: 'id обязателен' };
    const rows = await db.select().from(engineActTemplates).where(eq(engineActTemplates.id, tid)).limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Шаблон не найден' };
    return { ok: true, template: rowToDto(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createEngineActTemplate(args: {
  engineBrandId: unknown;
  name: unknown;
  payload?: unknown;
  actor?: string | null;
}): Promise<Result<{ template: EngineActTemplateDto }>> {
  try {
    const brand = normalizeBrandId(args.engineBrandId);
    if (!brand.ok) return brand;
    const nameResult = normalizeName(args.name);
    if (!nameResult.ok) return nameResult;
    const payloadResult = normalizePayload(args.payload);
    if (!payloadResult.ok) return payloadResult;

    const existing = await db
      .select({ id: engineActTemplates.id })
      .from(engineActTemplates)
      .where(and(eq(engineActTemplates.engineBrandId, brand.engineBrandId), eq(engineActTemplates.name, nameResult.name)))
      .limit(1);
    if (existing[0]) {
      return { ok: false, error: `Шаблон «${nameResult.name}» для этой марки уже существует` };
    }

    const inserted = await db
      .insert(engineActTemplates)
      .values({
        engineBrandId: brand.engineBrandId,
        name: nameResult.name,
        payloadJson: JSON.stringify(payloadResult.payload),
        updatedAt: nowMs(),
        updatedBy: args.actor ? String(args.actor) : null,
      })
      .returning();
    const row = inserted[0];
    if (!row) return { ok: false, error: 'Не удалось создать шаблон' };
    return { ok: true, template: rowToDto(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function updateEngineActTemplate(args: {
  id: string;
  name?: unknown;
  payload?: unknown;
  actor?: string | null;
}): Promise<Result<{ template: EngineActTemplateDto }>> {
  try {
    const id = String(args.id || '').trim();
    if (!id) return { ok: false, error: 'id обязателен' };

    const currentRows = await db.select().from(engineActTemplates).where(eq(engineActTemplates.id, id)).limit(1);
    const current = currentRows[0];
    if (!current) return { ok: false, error: 'Шаблон не найден' };

    const patch: Record<string, unknown> = {};

    if (args.name !== undefined) {
      const nameResult = normalizeName(args.name);
      if (!nameResult.ok) return nameResult;
      if (nameResult.name !== current.name) {
        const dup = await db
          .select({ id: engineActTemplates.id })
          .from(engineActTemplates)
          .where(and(eq(engineActTemplates.engineBrandId, String(current.engineBrandId)), eq(engineActTemplates.name, nameResult.name)))
          .limit(1);
        if (dup[0]) {
          return { ok: false, error: `Шаблон «${nameResult.name}» для этой марки уже существует` };
        }
      }
      patch.name = nameResult.name;
    }

    if (args.payload !== undefined) {
      const payloadResult = normalizePayload(args.payload);
      if (!payloadResult.ok) return payloadResult;
      patch.payloadJson = JSON.stringify(payloadResult.payload);
    }

    if (Object.keys(patch).length === 0) {
      return { ok: true, template: rowToDto(current) };
    }

    patch.updatedAt = nowMs();
    patch.updatedBy = args.actor ? String(args.actor) : null;

    const updated = await db
      .update(engineActTemplates)
      .set(patch as Partial<typeof engineActTemplates.$inferInsert>)
      .where(eq(engineActTemplates.id, id))
      .returning();
    const row = updated[0];
    if (!row) return { ok: false, error: 'Шаблон не найден после обновления' };
    return { ok: true, template: rowToDto(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteEngineActTemplate(id: string): Promise<Result<{ deleted: true }>> {
  try {
    const tid = String(id || '').trim();
    if (!tid) return { ok: false, error: 'id обязателен' };
    const deleted = await db.delete(engineActTemplates).where(eq(engineActTemplates.id, tid)).returning({ id: engineActTemplates.id });
    if (deleted.length === 0) return { ok: false, error: 'Шаблон не найден' };
    return { ok: true, deleted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
