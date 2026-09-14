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
) {
  const ts = nowMs();
  await db.insert(operations).values({
    id: randomUUID(),
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
}



/**
 * Операции заданных типов по ВСЕМ двигателям — для экрана «Ведомости работ» (15.09.2026).
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
 * Вставить или обновить операцию по id — ключ идемпотентности строки ведомости: клиент
 * генерирует id при создании, правка бьёт в ту же строку, дублей не возникает. `performed_at`
 * остаётся моментом первой записи, дата события живёт в meta (`at`).
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
    await db
      .update(operations)
      .set({
        engineEntityId: input.engineId,
        operationType: input.operationType,
        status: input.status,
        note: input.note ?? null,
        metaJson: input.metaJson ?? null,
        performedBy: actor,
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

/** Мягкое удаление: строка уезжает синком как delete, история других клиентов её погасит. */
export async function softDeleteOperation(db: BetterSQLite3Database, id: string): Promise<boolean> {
  const existing = await getOperation(db, id);
  if (!existing || existing.deletedAt) return false;
  const ts = nowMs();
  await db.update(operations).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'pending' }).where(eq(operations.id, id));
  return true;
}
