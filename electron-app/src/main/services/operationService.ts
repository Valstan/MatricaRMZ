import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { operations } from '../database/schema.js';

function nowMs() {
  return Date.now();
}

export async function listOperations(db: BetterSQLite3Database, engineId: string) {
  return db
    .select()
    .from(operations)
    .where(and(eq(operations.engineEntityId, engineId), isNull(operations.deletedAt)))
    .orderBy(desc(operations.updatedAt))
    .limit(500);
}

export async function addOperation(
  db: BetterSQLite3Database,
  engineId: string,
  operationType: string,
  status: string,
  note?: string,
  performedBy?: string,
  metaJson?: string | null,
): Promise<{ id: string }> {
  const ts = nowMs();
  const id = randomUUID();
  await db.insert(operations).values({
    id,
    engineEntityId: engineId,
    operationType,
    status,
    note: note ?? null,
    performedAt: ts,
    performedBy: performedBy?.trim() ? performedBy.trim() : 'local',
    metaJson: metaJson ?? null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
  return { id };
}



/**
 * Операции заданных типов по ВСЕМ двигателям — для экрана «Этапы работ» (15.09.2026).
 * `listOperations` режет 500 строками на двигатель и не умеет «по всем»; здесь окно задаётся
 * датой (`sinceMs`, по умолчанию 12 месяцев) и потолком строк.
 */
export async function listOperationsByType(
  db: BetterSQLite3Database,
  operationTypes: readonly string[],
  opts: { sinceMs?: number | null; limit?: number } = {},
) {
  const types = [...new Set(operationTypes.map((t) => String(t ?? '').trim()).filter(Boolean))];
  if (types.length === 0) return [];
  const limit = Math.max(1, Math.min(50_000, Math.trunc(opts.limit ?? 20_000)));
  const conds = [inArray(operations.operationType, types), isNull(operations.deletedAt)];
  if (typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) && opts.sinceMs > 0) {
    conds.push(gte(operations.updatedAt, opts.sinceMs));
  }
  return db
    .select()
    .from(operations)
    .where(and(...conds))
    .orderBy(desc(operations.updatedAt))
    .limit(limit);
}

export async function getOperation(db: BetterSQLite3Database, id: string) {
  const rows = await db.select().from(operations).where(eq(operations.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Вставить или обновить операцию по id — ключ идемпотентности строки этапа работ: клиент
 * генерирует id при создании, правка бьёт в ту же строку, дублей не возникает. `performed_at`
 * остаётся моментом первой записи, дата события живёт в meta (`at`). H1: `performed_by`
 * тоже автор навсегда — правка его не переписывает (пустой/`local` при создании лечится
 * первым настоящим логином).
 */
export async function upsertOperation(
  db: BetterSQLite3Database,
  input: {
    id: string;
    engineId: string;
    operationType: string;
    status: string;
    note?: string | null;
    performedBy?: string | null;
    metaJson?: string | null;
  },
): Promise<{ created: boolean }> {
  const ts = nowMs();
  const existing = await getOperation(db, input.id);
  const actor = input.performedBy?.trim() ? input.performedBy.trim() : 'local';
  if (existing) {
    const prevBy = String((existing as any).performedBy ?? '').trim();
    // Автор первой записи сохраняется: правщик «Кто» не становится. Пустой/`local`
    // след офлайн-создания — лечится первым настоящим логином.
    const keptBy = !prevBy || prevBy === 'local' ? actor : prevBy;
    await db
      .update(operations)
      .set({
        engineEntityId: input.engineId,
        operationType: input.operationType,
        status: input.status,
        note: input.note ?? null,
        metaJson: input.metaJson ?? null,
        performedBy: keptBy,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'pending',
      })
      .where(eq(operations.id, input.id));
    return { created: false };
  }
  await db.insert(operations).values({
    id: input.id,
    engineEntityId: input.engineId,
    operationType: input.operationType,
    status: input.status,
    note: input.note ?? null,
    performedAt: ts,
    performedBy: actor,
    metaJson: input.metaJson ?? null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
  return { created: true };
}

/**
 * Ручная запись ленты истории (то, что оператор внёс «Добавить запись»): без этапа
 * (`stage`), без строки работ (`sheet`), без авто-статуса и без переезда в другой цех.
 * Этапы правятся датой и снимаются в той же ленте, акты — кнопками проводки; общий
 * канал `ops:*` их не трогает, чтобы одна дверь не обошла логику другой.
 */
export function isManualHistoryRow(existing: {
  metaJson?: unknown;
  operationType?: unknown;
}): boolean {
  // Без разборчивой меты строка неопознана — закрываем, а не доверяем: ручную запись
  // всегда пишет `buildRepairHistoryMeta`, и меты у неё не может не быть.
  if (typeof existing.metaJson !== 'string' || !existing.metaJson.trim().startsWith('{')) return false;
  let meta: Record<string, unknown>;
  try {
    const parsed = JSON.parse(existing.metaJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    meta = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  const entryType = typeof meta.entryType === 'string' ? meta.entryType : '';
  if (meta.stage != null || meta.sheet != null || meta.auto === true) return false;
  if (entryType !== '' && entryType !== 'manual') return false;
  if (String(existing.operationType ?? '') === 'workshop_transfer') return false;
  return true;
}

/** Мягкое удаление: строка уезжает синком как delete, история других клиентов её погасит. */
export async function softDeleteOperation(db: BetterSQLite3Database, id: string): Promise<boolean> {
  const existing = await getOperation(db, id);
  if (!existing || existing.deletedAt) return false;
  const ts = nowMs();
  await db.update(operations).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(operations.id, id));
  return true;
}

/**
 * Правка ручной записи в ленте истории: меняет текст действия (`meta.action`), дату
 * (`meta.at`) и/или примечание (`meta.note`) в строке `operations`. Пустое действие
 * отклоняем — строка без него ничего не говорит. `performed_at` (момент ввода) и
 * автора не меняем: правка не переписывает, кто и когда внёс.
 */
export async function updateManualEntry(
  db: BetterSQLite3Database,
  id: string,
  patch: { action?: string; at?: number; note?: string },
): Promise<boolean> {
  const existing = await getOperation(db, id);
  if (!existing || existing.deletedAt) return false;
  let meta: Record<string, unknown> = {};
  try {
    const parsed = typeof existing.metaJson === 'string' && existing.metaJson.trim().startsWith('{')
      ? JSON.parse(existing.metaJson)
      : {};
    meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  // Только ручная запись: этап (`stage`), строку работ (`sheet`), переезд в другой цех
  // и авто-статус этим каналом править нельзя — у каждого своя дверь со своей логикой
  // (этапы правятся датой в той же ленте, акты — кнопками проводки).
  if (!isManualHistoryRow(existing)) return false;
  const ts = nowMs();
  const action = typeof patch.action === 'string' ? patch.action.trim().slice(0, 200) : '';
  if (patch.action !== undefined && !action) return false;
  const next = {
    ...meta,
    ...(action ? { action } : {}),
    ...(patch.at !== undefined && Number.isFinite(patch.at) && patch.at > 0 ? { at: Math.trunc(patch.at) } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
  };
  await db
    .update(operations)
    .set({ metaJson: JSON.stringify(next), updatedAt: ts, syncStatus: 'pending' })
    .where(eq(operations.id, id));
  return true;
}
