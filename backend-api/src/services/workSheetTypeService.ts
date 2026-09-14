import { and, asc, eq, isNull, ne } from 'drizzle-orm';

import {
  WORK_SHEET_CODE_RE,
  sanitizeWorkSheetColumns,
  workSheetCodeFromName,
  type WorkSheetType,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { workSheetTypes } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

/**
 * Справочник узлов ведомостей работ (владелец 15.09.2026). Живёт только на сервере, как шаблоны
 * нарядов: клиент ходит по REST и держит последний удачный список в кэше. Набор колонок
 * принимается через общий санитайзер — единственную точку, где форма колонок определена.
 */

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function parseColumns(raw: string | null | undefined) {
  if (!raw) return [];
  try {
    return sanitizeWorkSheetColumns(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function rowToWorkSheetType(row: typeof workSheetTypes.$inferSelect): WorkSheetType {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    workshopId: row.workshopId ? String(row.workshopId) : null,
    completesRepair: row.completesRepair === true,
    columns: parseColumns(row.columnsJson),
    sortOrder: Number(row.sortOrder ?? 0),
    archivedAt: row.archivedAt == null ? null : Number(row.archivedAt),
    updatedAt: Number(row.updatedAt),
  };
}

export async function listWorkSheetTypes(opts: { includeArchived?: boolean } = {}): Promise<Result<{ rows: WorkSheetType[] }>> {
  try {
    const rows = await db
      .select()
      .from(workSheetTypes)
      .where(opts.includeArchived ? undefined : isNull(workSheetTypes.archivedAt))
      .orderBy(asc(workSheetTypes.sortOrder), asc(workSheetTypes.name));
    return { ok: true, rows: rows.map(rowToWorkSheetType) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export type UpsertWorkSheetTypeInput = {
  id?: string | undefined;
  code?: string | undefined;
  name: string;
  workshopId?: string | null | undefined;
  completesRepair?: boolean | undefined;
  columns?: unknown;
  sortOrder?: number | undefined;
  actor?: string | null | undefined;
};

/**
 * Создать или обновить узел. Код у существующего узла не меняется (на него ссылаются строки
 * ведомостей через `sheet.typeCode`); у нового — из тела либо из названия.
 */
export async function upsertWorkSheetType(input: UpsertWorkSheetTypeInput): Promise<Result<{ row: WorkSheetType }>> {
  const name = text(input.name).slice(0, 120);
  if (!name) return { ok: false, error: 'Название узла обязательно' };
  const columns = sanitizeWorkSheetColumns(input.columns ?? []);
  const workshopId = text(input.workshopId) || null;
  const completesRepair = input.completesRepair === true;
  const now = Date.now();
  const actor = text(input.actor) || null;
  const id = text(input.id);

  try {
    if (id) {
      const [existing] = await db.select().from(workSheetTypes).where(eq(workSheetTypes.id, id)).limit(1);
      if (!existing) return { ok: false, error: 'Узел не найден' };
      const [row] = await db
        .update(workSheetTypes)
        .set({
          name,
          workshopId,
          completesRepair,
          columnsJson: JSON.stringify(columns),
          ...(typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder) ? { sortOrder: Math.trunc(input.sortOrder) } : {}),
          updatedAt: now,
          updatedBy: actor,
        })
        .where(eq(workSheetTypes.id, id))
        .returning();
      if (!row) return { ok: false, error: 'Узел не найден' };
      return { ok: true, row: rowToWorkSheetType(row) };
    }

    const code = text(input.code).toLowerCase() || workSheetCodeFromName(name);
    if (!WORK_SHEET_CODE_RE.test(code)) {
      return { ok: false, error: 'Код узла — латиница, цифры и «_», от 2 до 40 знаков, с буквы' };
    }
    const [dup] = await db
      .select({ id: workSheetTypes.id })
      .from(workSheetTypes)
      .where(and(eq(workSheetTypes.code, code), isNull(workSheetTypes.archivedAt)))
      .limit(1);
    if (dup) return { ok: false, error: `Узел с кодом «${code}» уже есть` };

    let sortOrder = typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder) : null;
    if (sortOrder == null) {
      const all = await db.select({ sortOrder: workSheetTypes.sortOrder }).from(workSheetTypes);
      sortOrder = all.reduce((m, r) => Math.max(m, Number(r.sortOrder ?? 0)), 0) + 10;
    }
    const [row] = await db
      .insert(workSheetTypes)
      .values({
        code,
        name,
        workshopId,
        completesRepair,
        columnsJson: JSON.stringify(columns),
        sortOrder,
        updatedAt: now,
        updatedBy: actor,
      })
      .returning();
    if (!row) return { ok: false, error: 'Узел не создан' };
    return { ok: true, row: rowToWorkSheetType(row) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Архив, не удаление: строки ведомостей ссылаются на узел и обязаны читаться дальше. */
export async function archiveWorkSheetType(id: string, actor?: string | null): Promise<Result<{ id: string }>> {
  const key = text(id);
  if (!key) return { ok: false, error: 'id обязателен' };
  try {
    const [row] = await db
      .update(workSheetTypes)
      .set({ archivedAt: Date.now(), updatedAt: Date.now(), updatedBy: text(actor) || null })
      .where(and(eq(workSheetTypes.id, key), isNull(workSheetTypes.archivedAt)))
      .returning({ id: workSheetTypes.id });
    if (!row) return { ok: false, error: 'Узел не найден или уже в архиве' };
    return { ok: true, id: String(row.id) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Вернуть из архива (код должен быть свободен). */
export async function restoreWorkSheetType(id: string, actor?: string | null): Promise<Result<{ id: string }>> {
  const key = text(id);
  if (!key) return { ok: false, error: 'id обязателен' };
  try {
    const [target] = await db.select().from(workSheetTypes).where(eq(workSheetTypes.id, key)).limit(1);
    if (!target) return { ok: false, error: 'Узел не найден' };
    const [dup] = await db
      .select({ id: workSheetTypes.id })
      .from(workSheetTypes)
      .where(and(eq(workSheetTypes.code, target.code), isNull(workSheetTypes.archivedAt), ne(workSheetTypes.id, key)))
      .limit(1);
    if (dup) return { ok: false, error: `Код «${target.code}» уже занят другим узлом` };
    await db
      .update(workSheetTypes)
      .set({ archivedAt: null, updatedAt: Date.now(), updatedBy: text(actor) || null })
      .where(eq(workSheetTypes.id, key));
    return { ok: true, id: key };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
