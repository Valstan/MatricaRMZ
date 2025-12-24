import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
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
    metaJson: null,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'pending',
  });
}


