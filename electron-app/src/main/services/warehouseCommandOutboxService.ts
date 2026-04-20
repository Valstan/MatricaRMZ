import { randomUUID } from 'node:crypto';

import { and, asc, eq, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { warehouseCommandOutbox } from '../database/schema.js';

export type WarehouseCommandType = 'document_upsert' | 'document_cancel';

export type WarehouseOutboxPayload = {
  commandType: WarehouseCommandType;
  aggregateType?: string;
  aggregateId?: string | null;
  body: Record<string, unknown>;
};

function nowMs() {
  return Date.now();
}

export async function enqueueWarehouseCommand(
  db: BetterSQLite3Database,
  payload: WarehouseOutboxPayload,
): Promise<{ id: string; clientOperationId: string }> {
  const ts = nowMs();
  const id = randomUUID();
  const clientOperationId = randomUUID();
  await db.insert(warehouseCommandOutbox).values({
    id,
    clientOperationId,
    commandType: payload.commandType,
    aggregateType: String(payload.aggregateType ?? 'warehouse_document'),
    aggregateId: payload.aggregateId == null ? null : String(payload.aggregateId),
    payloadJson: JSON.stringify(payload.body ?? {}),
    status: 'pending',
    attempts: 0,
    nextRetryAt: ts,
    lastError: null,
    createdAt: ts,
    updatedAt: ts,
  });
  return { id, clientOperationId };
}

export async function listDueWarehouseCommands(
  db: BetterSQLite3Database,
  limit = 20,
): Promise<Array<{ id: string; clientOperationId: string; commandType: WarehouseCommandType; body: Record<string, unknown> }>> {
  const ts = nowMs();
  const rows = await db
    .select()
    .from(warehouseCommandOutbox)
    .where(and(eq(warehouseCommandOutbox.status, 'pending'), lte(warehouseCommandOutbox.nextRetryAt, ts)))
    .orderBy(asc(warehouseCommandOutbox.createdAt))
    .limit(Math.max(1, Math.min(200, Math.trunc(limit))));
  return rows.map((row) => ({
    id: String(row.id),
    clientOperationId: String(row.clientOperationId),
    commandType: String(row.commandType) as WarehouseCommandType,
    body: (() => {
      try {
        const parsed = JSON.parse(String(row.payloadJson ?? '{}'));
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    })(),
  }));
}

export async function markWarehouseCommandApplied(db: BetterSQLite3Database, id: string): Promise<void> {
  const ts = nowMs();
  await db
    .update(warehouseCommandOutbox)
    .set({ status: 'applied', updatedAt: ts, lastError: null })
    .where(eq(warehouseCommandOutbox.id, String(id)));
}

export async function markWarehouseCommandFailed(db: BetterSQLite3Database, id: string, error: string): Promise<void> {
  const ts = nowMs();
  const row = await db.select().from(warehouseCommandOutbox).where(eq(warehouseCommandOutbox.id, String(id))).limit(1);
  const attempts = Number(row[0]?.attempts ?? 0) + 1;
  const backoffMs = Math.min(5 * 60_000, 2000 * 2 ** Math.min(6, attempts));
  const status = attempts >= 8 ? 'dead_letter' : 'pending';
  await db
    .update(warehouseCommandOutbox)
    .set({
      status,
      attempts,
      nextRetryAt: ts + backoffMs,
      updatedAt: ts,
      lastError: String(error).slice(0, 500),
    })
    .where(eq(warehouseCommandOutbox.id, String(id)));
}

