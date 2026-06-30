import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import type {
  WorkshopRepairTemplateDto,
  WorkshopRepairTemplateLine,
  WorkshopRepairTemplateSummary,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { directoryWorkshops, erpNomenclature, workshopRepairTemplates } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

export type { WorkshopRepairTemplateDto, WorkshopRepairTemplateLine, WorkshopRepairTemplateSummary };

const DEFAULT_TEMPLATE_NAME = 'Базовый';

function nowMs() {
  return Date.now();
}

function parseLinesJson(raw: string | null | undefined): WorkshopRepairTemplateLine[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: WorkshopRepairTemplateLine[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const rec = row as Record<string, unknown>;
      const nomenclatureId = String(rec.nomenclatureId ?? '').trim();
      const unit = String(rec.unit ?? '').trim();
      if (!nomenclatureId || !unit) continue;
      const line: WorkshopRepairTemplateLine = { nomenclatureId, unit };
      const defaultQtyRaw = Number(rec.defaultQty);
      if (Number.isFinite(defaultQtyRaw) && defaultQtyRaw > 0) {
        line.defaultQty = defaultQtyRaw;
      }
      const serviceId = typeof rec.serviceId === 'string' ? rec.serviceId.trim() : '';
      if (serviceId) line.serviceId = serviceId;
      out.push(line);
    }
    return out;
  } catch {
    return [];
  }
}

function rowToDto(row: typeof workshopRepairTemplates.$inferSelect): WorkshopRepairTemplateDto {
  return {
    id: String(row.id),
    workshopId: String(row.workshopId),
    name: String(row.name),
    lines: parseLinesJson(row.linesJson),
    updatedAt: Number(row.updatedAt),
    updatedBy: row.updatedBy ?? null,
  };
}

async function ensureWorkshopExists(workshopId: string): Promise<boolean> {
  const rows = await db
    .select({ id: directoryWorkshops.id })
    .from(directoryWorkshops)
    .where(and(eq(directoryWorkshops.id, workshopId), isNull(directoryWorkshops.deletedAt)))
    .limit(1);
  return !!rows[0];
}

async function validateLines(rawLines: unknown): Promise<Result<{ lines: WorkshopRepairTemplateLine[] }>> {
  if (!Array.isArray(rawLines)) return { ok: false, error: 'Поле lines должно быть массивом' };
  const normalized: WorkshopRepairTemplateLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `Строка ${i + 1}: некорректный формат` };
    }
    const rec = raw as Record<string, unknown>;
    const nomenclatureId = String(rec.nomenclatureId ?? '').trim();
    if (!nomenclatureId) return { ok: false, error: `Строка ${i + 1}: не указана номенклатура` };
    const unit = String(rec.unit ?? '').trim();
    if (!unit) return { ok: false, error: `Строка ${i + 1}: не указана единица измерения` };
    const line: WorkshopRepairTemplateLine = { nomenclatureId, unit };
    if (rec.defaultQty !== undefined && rec.defaultQty !== null) {
      const qty = Number(rec.defaultQty);
      if (!Number.isFinite(qty) || qty < 0) {
        return { ok: false, error: `Строка ${i + 1}: defaultQty должно быть числом >= 0` };
      }
      if (qty > 0) line.defaultQty = qty;
    }
    if (rec.serviceId !== undefined && rec.serviceId !== null && rec.serviceId !== '') {
      const serviceId = String(rec.serviceId).trim();
      if (serviceId) line.serviceId = serviceId;
    }
    normalized.push(line);
  }
  if (normalized.length > 0) {
    const ids = Array.from(new Set(normalized.map((l) => l.nomenclatureId)));
    const found = await db
      .select({ id: erpNomenclature.id })
      .from(erpNomenclature)
      .where(and(inArray(erpNomenclature.id, ids), isNull(erpNomenclature.deletedAt)));
    const foundSet = new Set(found.map((r) => String(r.id)));
    const missing = ids.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      return { ok: false, error: `Номенклатура не найдена: ${missing.join(', ')}` };
    }
  }

  // serviceId не проверяем против erp_nomenclature: в v1.27.0 шаблон UI использовал
  // именно этот источник, но dropdown «Вид работ» в WorkOrderDetailsPage идёт через
  // admin.entities (EAV / directory_services) — разные пространства id, и autofill
  // в нaряде не находил услугу. Hotfix 1.27.1: храним serviceId как opaque-строку
  // (UUID), валидация переезжает в будущую систему шаблонов нарядов (когда оба места
  // будут использовать единый источник services). Старые шаблоны с erp_nomenclature-id
  // принимаются как есть — на проде сейчас все строки шаблонов созданы пользователем
  // вручную, и заведомо валидных у нас единицы.

  return { ok: true, lines: normalized };
}

function normalizeName(raw: unknown): string {
  return String(raw ?? '').trim();
}

// ─── New CRUD API (v1.27.0) ──────────────────────────────────────────────────

export async function listRepairTemplates(
  workshopId: string,
): Promise<Result<{ templates: WorkshopRepairTemplateSummary[] }>> {
  try {
    const id = String(workshopId || '').trim();
    if (!id) return { ok: false, error: 'workshopId обязателен' };
    const rows = await db
      .select()
      .from(workshopRepairTemplates)
      .where(eq(workshopRepairTemplates.workshopId, id))
      .orderBy(asc(workshopRepairTemplates.name));
    const templates = rows.map((row): WorkshopRepairTemplateSummary => ({
      id: String(row.id),
      workshopId: String(row.workshopId),
      name: String(row.name),
      lineCount: parseLinesJson(row.linesJson).length,
      updatedAt: Number(row.updatedAt),
    }));
    return { ok: true, templates };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getRepairTemplateById(id: string): Promise<Result<{ template: WorkshopRepairTemplateDto }>> {
  try {
    const tid = String(id || '').trim();
    if (!tid) return { ok: false, error: 'id обязателен' };
    const rows = await db
      .select()
      .from(workshopRepairTemplates)
      .where(eq(workshopRepairTemplates.id, tid))
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: 'Шаблон не найден' };
    return { ok: true, template: rowToDto(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createRepairTemplate(args: {
  workshopId: string;
  name: unknown;
  lines: unknown;
  actor?: string | null;
}): Promise<Result<{ template: WorkshopRepairTemplateDto }>> {
  try {
    const workshopId = String(args.workshopId || '').trim();
    if (!workshopId) return { ok: false, error: 'workshopId обязателен' };
    const name = normalizeName(args.name);
    if (!name) return { ok: false, error: 'Название шаблона обязательно' };
    if (name.length > 100) return { ok: false, error: 'Название шаблона не должно превышать 100 символов' };
    if (!(await ensureWorkshopExists(workshopId))) return { ok: false, error: 'Цех не найден' };

    const existing = await db
      .select({ id: workshopRepairTemplates.id })
      .from(workshopRepairTemplates)
      .where(and(eq(workshopRepairTemplates.workshopId, workshopId), eq(workshopRepairTemplates.name, name)))
      .limit(1);
    if (existing[0]) return { ok: false, error: `Шаблон «${name}» в этом цехе уже существует` };

    const linesResult = await validateLines(args.lines);
    if (!linesResult.ok) return linesResult;

    const ts = nowMs();
    const actor = args.actor ? String(args.actor) : null;
    const linesJson = JSON.stringify(linesResult.lines);

    const inserted = await db
      .insert(workshopRepairTemplates)
      .values({ workshopId, name, linesJson, updatedAt: ts, updatedBy: actor })
      .returning();
    const row = inserted[0];
    if (!row) return { ok: false, error: 'Не удалось создать шаблон' };
    return { ok: true, template: rowToDto(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function updateRepairTemplate(args: {
  id: string;
  name?: unknown;
  lines?: unknown;
  actor?: string | null;
}): Promise<Result<{ template: WorkshopRepairTemplateDto }>> {
  try {
    const id = String(args.id || '').trim();
    if (!id) return { ok: false, error: 'id обязателен' };

    const currentRows = await db
      .select()
      .from(workshopRepairTemplates)
      .where(eq(workshopRepairTemplates.id, id))
      .limit(1);
    const current = currentRows[0];
    if (!current) return { ok: false, error: 'Шаблон не найден' };

    const patch: Record<string, unknown> = {};

    if (args.name !== undefined) {
      const name = normalizeName(args.name);
      if (!name) return { ok: false, error: 'Название шаблона обязательно' };
      if (name.length > 100) return { ok: false, error: 'Название шаблона не должно превышать 100 символов' };
      if (name !== current.name) {
        const dup = await db
          .select({ id: workshopRepairTemplates.id })
          .from(workshopRepairTemplates)
          .where(
            and(eq(workshopRepairTemplates.workshopId, current.workshopId), eq(workshopRepairTemplates.name, name)),
          )
          .limit(1);
        if (dup[0]) return { ok: false, error: `Шаблон «${name}» в этом цехе уже существует` };
      }
      patch.name = name;
    }

    if (args.lines !== undefined) {
      const linesResult = await validateLines(args.lines);
      if (!linesResult.ok) return linesResult;
      patch.linesJson = JSON.stringify(linesResult.lines);
    }

    if (Object.keys(patch).length === 0) {
      return { ok: true, template: rowToDto(current) };
    }

    const ts = nowMs();
    patch.updatedAt = ts;
    patch.updatedBy = args.actor ? String(args.actor) : null;

    const updated = await db
      .update(workshopRepairTemplates)
      .set(patch as Partial<typeof workshopRepairTemplates.$inferInsert>)
      .where(eq(workshopRepairTemplates.id, id))
      .returning();
    const row = updated[0];
    if (!row) return { ok: false, error: 'Шаблон не найден после обновления' };
    return { ok: true, template: rowToDto(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteRepairTemplate(id: string): Promise<Result<{ deleted: true }>> {
  try {
    const tid = String(id || '').trim();
    if (!tid) return { ok: false, error: 'id обязателен' };
    const deleted = await db
      .delete(workshopRepairTemplates)
      .where(eq(workshopRepairTemplates.id, tid))
      .returning({ id: workshopRepairTemplates.id });
    if (deleted.length === 0) return { ok: false, error: 'Шаблон не найден' };
    return { ok: true, deleted: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ─── Legacy single-template API (backward-compat) ────────────────────────────
// Used by existing UI dialog and existing tests. Will be removed after PR 5.
// Behavior:
//   getRepairTemplate(workshopId) → first template ordered by name (or empty DTO).
//   setRepairTemplate({ workshopId, lines }) → upsert «Базовый» template:
//     - if any template exists for the workshop, update the first one;
//     - otherwise create a new one with name='Базовый'.

export async function getRepairTemplate(
  workshopId: string,
): Promise<Result<{ template: { workshopId: string; lines: WorkshopRepairTemplateLine[]; updatedAt: number | null; updatedBy: string | null } }>> {
  try {
    const id = String(workshopId || '').trim();
    if (!id) return { ok: false, error: 'workshopId обязателен' };
    const rows = await db
      .select()
      .from(workshopRepairTemplates)
      .where(eq(workshopRepairTemplates.workshopId, id))
      .orderBy(asc(workshopRepairTemplates.name))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return { ok: true, template: { workshopId: id, lines: [], updatedAt: null, updatedBy: null } };
    }
    return {
      ok: true,
      template: {
        workshopId: String(row.workshopId),
        lines: parseLinesJson(row.linesJson),
        updatedAt: Number(row.updatedAt),
        updatedBy: row.updatedBy ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function setRepairTemplate(args: {
  workshopId: string;
  lines: unknown;
  actor?: string | null;
}): Promise<Result<{ workshopId: string; lineCount: number }>> {
  try {
    const workshopId = String(args.workshopId || '').trim();
    if (!workshopId) return { ok: false, error: 'workshopId обязателен' };
    if (!(await ensureWorkshopExists(workshopId))) return { ok: false, error: 'Цех не найден' };

    const linesResult = await validateLines(args.lines);
    if (!linesResult.ok) return linesResult;

    const ts = nowMs();
    const actor = args.actor ? String(args.actor) : null;
    const linesJson = JSON.stringify(linesResult.lines);

    const existing = await db
      .select({ id: workshopRepairTemplates.id })
      .from(workshopRepairTemplates)
      .where(eq(workshopRepairTemplates.workshopId, workshopId))
      .orderBy(asc(workshopRepairTemplates.name))
      .limit(1);

    if (existing[0]) {
      await db
        .update(workshopRepairTemplates)
        .set({ linesJson, updatedAt: ts, updatedBy: actor })
        .where(eq(workshopRepairTemplates.id, existing[0].id));
    } else {
      await db.insert(workshopRepairTemplates).values({
        workshopId,
        name: DEFAULT_TEMPLATE_NAME,
        linesJson,
        updatedAt: ts,
        updatedBy: actor,
      });
    }

    return { ok: true, workshopId, lineCount: linesResult.lines.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
