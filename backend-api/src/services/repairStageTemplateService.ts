import { and, asc, eq, isNull, ne } from 'drizzle-orm';

import { WORK_SHEET_CODE_RE, type RepairStageTemplate } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { repairStageTemplates } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

/**
 * Шаблон единого списка этапов (план unified-repair-stages, шаг 5a).
 * Живёт только на сервере, как work_sheet_types: клиент ходит по REST.
 * Код у существующего этапа не меняется (на него ссылаются stage-строки).
 */

const AUTO_FROM = ['defectAct', 'kittingAct', 'obkatkaRow'] as const;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function parseAutoFrom(raw: unknown): string | null {
  const v = text(raw);
  if (!v) return null;
  return (AUTO_FROM as readonly string[]).includes(v) ? v : null;
}

export function rowToRepairStageTemplate(row: typeof repairStageTemplates.$inferSelect): RepairStageTemplate {
  const out: RepairStageTemplate = {
    code: String(row.code) as RepairStageTemplate['code'],
    name: String(row.name),
    sortOrder: Number(row.sortOrder ?? 0),
    id: String(row.id),
    updatedAt: Number(row.updatedAt),
  };
  if (row.autoFrom) out.autoFrom = String(row.autoFrom) as NonNullable<RepairStageTemplate['autoFrom']>;
  if (row.sideBranch === true) out.sideBranch = true;
  out.archivedAt = row.archivedAt == null ? null : Number(row.archivedAt);
  return out;
}

export async function listRepairStageTemplates(
  opts: { includeArchived?: boolean } = {},
): Promise<Result<{ rows: RepairStageTemplate[] }>> {
  try {
    const rows = await db
      .select()
      .from(repairStageTemplates)
      .where(opts.includeArchived ? undefined : isNull(repairStageTemplates.archivedAt))
      // Боковая ветка — всегда после линейки, хоть у неё и приоритет 0.
      .orderBy(asc(repairStageTemplates.sideBranch), asc(repairStageTemplates.sortOrder), asc(repairStageTemplates.name));
    return { ok: true, rows: rows.map(rowToRepairStageTemplate) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export type UpsertRepairStageTemplateInput = {
  id?: string | undefined;
  code?: string | undefined;
  name: string;
  autoFrom?: string | null | undefined;
  sideBranch?: boolean | undefined;
  sortOrder?: number | undefined;
  actor?: string | null | undefined;
  expectedUpdatedAt?: number | undefined;
};

export async function upsertRepairStageTemplate(
  input: UpsertRepairStageTemplateInput,
): Promise<Result<{ row: RepairStageTemplate }>> {
  const name = text(input.name).slice(0, 120);
  if (!name) return { ok: false, error: 'Название этапа обязательно' };
  if (input.autoFrom != null && parseAutoFrom(input.autoFrom) === null && text(input.autoFrom)) {
    return { ok: false, error: 'Неизвестный источник автопростановки' };
  }
  const autoFrom = parseAutoFrom(input.autoFrom);
  const sideBranch = input.sideBranch === true;
  const now = Date.now();
  const actor = text(input.actor) || null;
  const id = text(input.id);

  try {
    if (id) {
      const [existing] = await db.select().from(repairStageTemplates).where(eq(repairStageTemplates.id, id)).limit(1);
      if (!existing) return { ok: false, error: 'Этап не найден' };
      if (
        typeof input.expectedUpdatedAt === 'number' &&
        Number.isFinite(input.expectedUpdatedAt) &&
        Number(existing.updatedAt) !== input.expectedUpdatedAt
      ) {
        return { ok: false, error: 'Этап успели изменить в другом месте — закройте окно и откройте его заново, иначе чужая правка пропадёт' };
      }
      const [row] = await db
        .update(repairStageTemplates)
        .set({
          name,
          autoFrom,
          sideBranch,
          ...(typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder) ? { sortOrder: Math.trunc(input.sortOrder) } : {}),
          updatedAt: now,
          updatedBy: actor,
        })
        .where(eq(repairStageTemplates.id, id))
        .returning();
      if (!row) return { ok: false, error: 'Этап не найден' };
      return { ok: true, row: rowToRepairStageTemplate(row) };
    }

    const code = text(input.code).toLowerCase();
    if (!WORK_SHEET_CODE_RE.test(code)) {
      return { ok: false, error: 'Код этапа — латиница, цифры и «_», от 2 до 40 знаков, с буквы' };
    }
    // Архивный этап код НЕ освобождает: на код ссылаются stage-строки.
    const [dup] = await db
      .select({ id: repairStageTemplates.id, archivedAt: repairStageTemplates.archivedAt })
      .from(repairStageTemplates)
      .where(eq(repairStageTemplates.code, code))
      .limit(1);
    if (dup) {
      return {
        ok: false,
        error: dup.archivedAt
          ? `Код «${code}» занят этапом в архиве — верните его из архива или назовите новый этап иначе`
          : `Этап с кодом «${code}» уже есть`,
      };
    }

    let sortOrder = typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder) : null;
    if (sortOrder == null) {
      const all = await db.select({ sortOrder: repairStageTemplates.sortOrder }).from(repairStageTemplates);
      const live = all.map((r) => Number(r.sortOrder ?? 0)).filter((n) => n > 0);
      sortOrder = (live.length > 0 ? Math.max(...live) : 0) + 10;
    }
    const [row] = await db
      .insert(repairStageTemplates)
      .values({ code, name, autoFrom, sideBranch, sortOrder, updatedAt: now, updatedBy: actor })
      .returning();
    if (!row) return { ok: false, error: 'Этап не создан' };
    return { ok: true, row: rowToRepairStageTemplate(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Архив, не удаление: stage-строки ссылаются на этап и обязаны читаться дальше. */
export async function archiveRepairStageTemplate(id: string, actor?: string | null): Promise<Result<{ id: string }>> {
  const key = text(id);
  if (!key) return { ok: false, error: 'id обязателен' };
  try {
    const [row] = await db
      .update(repairStageTemplates)
      .set({ archivedAt: Date.now(), updatedAt: Date.now(), updatedBy: text(actor) || null })
      .where(and(eq(repairStageTemplates.id, key), isNull(repairStageTemplates.archivedAt)))
      .returning({ id: repairStageTemplates.id });
    if (!row) return { ok: false, error: 'Этап не найден или уже в архиве' };
    return { ok: true, id: String(row.id) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Вернуть из архива (код должен быть свободен). */
export async function restoreRepairStageTemplate(id: string, actor?: string | null): Promise<Result<{ id: string }>> {
  const key = text(id);
  if (!key) return { ok: false, error: 'Этап не найден' };
  try {
    const [target] = await db.select().from(repairStageTemplates).where(eq(repairStageTemplates.id, key)).limit(1);
    if (!target) return { ok: false, error: 'Этап не найден' };
    const [dup] = await db
      .select({ id: repairStageTemplates.id })
      .from(repairStageTemplates)
      .where(and(eq(repairStageTemplates.code, target.code), isNull(repairStageTemplates.archivedAt), ne(repairStageTemplates.id, key)))
      .limit(1);
    if (dup) return { ok: false, error: `Код «${target.code}» уже занят другим этапом` };
    await db
      .update(repairStageTemplates)
      .set({ archivedAt: null, updatedAt: Date.now(), updatedBy: text(actor) || null })
      .where(eq(repairStageTemplates.id, key));
    return { ok: true, id: key };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Перестановка приоритетов целиком (drag-and-drop в справочнике): порядок массива —
 * новый порядок линейки, приоритеты пересчитываются 10, 20, … Боковая ветка в
 * перестановке не участвует — её приоритет всегда 0 и правится отдельно.
 */
export async function reorderRepairStageTemplates(
  ids: string[],
  actor?: string | null,
): Promise<Result<{ updated: number }>> {
  const keys = ids.map((v) => text(v)).filter(Boolean);
  if (keys.length === 0) return { ok: false, error: 'Пустой порядок' };
  try {
    const rows = await db.select().from(repairStageTemplates).where(isNull(repairStageTemplates.archivedAt));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const key of keys) {
      if (!byId.has(key)) return { ok: false, error: 'Этап не найден или в архиве' };
    }
    const now = Date.now();
    const by = text(actor) || null;
    let updated = 0;
    let order = 10;
    for (const key of keys) {
      const current = byId.get(key)!;
      if (current.sideBranch === true) continue;
      if (Number(current.sortOrder) !== order) {
        await db
          .update(repairStageTemplates)
          .set({ sortOrder: order, updatedAt: now, updatedBy: by })
          .where(eq(repairStageTemplates.id, key));
        updated++;
      }
      order += 10;
    }
    return { ok: true, updated };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
