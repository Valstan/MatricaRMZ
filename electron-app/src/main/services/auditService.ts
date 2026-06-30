import { desc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';

import { auditLog } from '../database/schema.js';

export async function listAudit(db: BetterSQLite3Database) {
  return db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(500);
}

export async function addAudit(
  db: BetterSQLite3Database,
  args: { actor: string; action: string; entityId?: string | null; tableName?: string | null; payload?: unknown },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ts = Date.now();
    const actor = String(args.actor || '').trim() || 'local';
    const action = String(args.action || '').trim();
    if (!action) return { ok: false, error: 'action is empty' };
    const entityId = args.entityId == null ? null : String(args.entityId);
    const tableName = args.tableName == null ? null : String(args.tableName);
    const payloadJson = args.payload === undefined ? null : JSON.stringify(args.payload ?? null);

    await db.insert(auditLog).values({
      id: randomUUID(),
      actor,
      action,
      entityId,
      tableName,
      payloadJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'pending',
    });
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}


