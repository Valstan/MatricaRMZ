import { and, asc, eq, isNull, like, ne, or } from 'drizzle-orm';

import {
  REPAIR_HISTORY_OPERATION_TYPE,
  WORK_SHEET_COLUMN_TYPE_LABELS,
  WORK_SHEET_CODE_RE,
  parseRepairHistoryMeta,
  sanitizeWorkSheetColumns,
  workSheetCodeFromName,
  type WorkSheetColumnType,
  type WorkSheetType,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { operations, workSheetTypes } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
type Result<T> = Ok<T> | Err;

/**
 * Справочник видов работ для этапов (владелец 15.09.2026). Живёт только на сервере, как шаблоны
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
  /** `updatedAt` узла, каким его видел редактор. Не совпал — узел правил кто-то ещё. */
  expectedUpdatedAt?: number | undefined;
};

/**
 * Типы полей, которыми узел УЖЕ заполнен, по коду колонки. Источник правды — сами строки, а
 * не прежний набор колонок узла: сравнение с прежним набором обходится в два сохранения
 * (удалить колонку → завести заново с тем же кодом и другим типом), и старые значения молча
 * меняют смысл. Строка несёт тип своего поля с собой, поэтому ответ честен даже там, где
 * колонку успели переименовать.
 *
 * Запрос идёт по `meta_json` подстрокой — индекса на содержимое JSON нет; он сужен типом
 * операции и выполняется только при правке узла (редкое действие), не при чтении строк.
 */
async function columnTypesInUse(typeId: string, typeCode: string): Promise<Map<string, { type: WorkSheetColumnType; rows: number }>> {
  const out = new Map<string, { type: WorkSheetColumnType; rows: number }>();
  const conds = [like(operations.metaJson, `%"typeId":"${typeId}"%`), like(operations.metaJson, `%"typeCode":"${typeCode}"%`)];
  const rows = await db
    .select({ metaJson: operations.metaJson })
    .from(operations)
    .where(and(eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE), isNull(operations.deletedAt), or(...conds)))
    .limit(50_000);
  for (const row of rows) {
    const meta = parseRepairHistoryMeta(row.metaJson ?? null);
    const sheet = meta?.sheet;
    if (!sheet) continue;
    if (sheet.typeId !== typeId && sheet.typeCode !== typeCode) continue;
    for (const field of sheet.fields) {
      const seen = out.get(field.code);
      if (seen) seen.rows += 1;
      else out.set(field.code, { type: field.type, rows: 1 });
    }
  }
  return out;
}

/**
 * Создать или обновить узел. Код у существующего узла не меняется (на него ссылаются строки
 * этапов работ через `sheet.typeCode`); у нового — из тела либо из названия.
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
      if (
        typeof input.expectedUpdatedAt === 'number' &&
        Number.isFinite(input.expectedUpdatedAt) &&
        Number(existing.updatedAt) !== input.expectedUpdatedAt
      ) {
        return { ok: false, error: 'Узел успели изменить в другом месте — закройте окно и откройте его заново, иначе чужая правка пропадёт' };
      }
      const inUse = await columnTypesInUse(String(existing.id), String(existing.code));
      for (const col of columns) {
        const used = inUse.get(col.code);
        if (used && used.type !== col.type) {
          return {
            ok: false,
            error:
              `Колонка «${col.label}» уже заполнена в ${used.rows} стр. как «${WORK_SHEET_COLUMN_TYPE_LABELS[used.type]}» — ` +
              `сменить тип на «${WORK_SHEET_COLUMN_TYPE_LABELS[col.type]}» нельзя: старые значения сменили бы смысл. ` +
              'Заведите новую колонку с другим названием.',
          };
        }
      }
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
    // Архивный узел код НЕ освобождает: на код ссылаются его строки (`sheet.typeCode`), и
    // вкладка экрана отбирает строки по нему. Заведись новый узел с тем же кодом — строки
    // старого приехали бы в чужую вкладку с чужими колонками. Частичный уникальный индекс
    // миграции 0097 такого дубля не ловит: он живых и архивных не различает по коду.
    const [dup] = await db
      .select({ id: workSheetTypes.id, archivedAt: workSheetTypes.archivedAt })
      .from(workSheetTypes)
      .where(eq(workSheetTypes.code, code))
      .limit(1);
    if (dup) {
      return {
        ok: false,
        error: dup.archivedAt
          ? `Код «${code}» занят узлом в архиве — верните его из архива или назовите новый узел иначе`
          : `Узел с кодом «${code}» уже есть`,
      };
    }

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

/** Архив, не удаление: строки этапов работ ссылаются на узел и обязаны читаться дальше. */
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
