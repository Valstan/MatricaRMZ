import { db } from '../database/db.js';
import { entityTypes } from '../database/schema.js';
import { eq, like, or } from 'drizzle-orm';
import { SyncTableName } from '@matricarmz/shared';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';

function nowMs() {
  return Date.now();
}

export async function cleanupBulkEntityTypes(): Promise<{ ok: true; affected: number } | { ok: false; error: string }> {
  try {
    const ts = nowMs();

    // Find "Type Bulk" artifacts (historical bench data)
    const rows = await db
      .select()
      .from(entityTypes)
      .where(
        or(like(entityTypes.code, 't_bulk_%'), like(entityTypes.name, 'Type Bulk %')),
      )
      .limit(50_000);

    if (rows.length === 0) return { ok: true, affected: 0 };

    // Soft delete (if not already) + ALWAYS write a fresh delete event to change_log
    // so existing clients (who may have skipped older events due to server-side filtering)
    // will receive cleanup on next pull.
    for (const r of rows as any[]) {
      const alreadyDeletedAt = r.deletedAt == null ? null : Number(r.deletedAt);
      const nextDeletedAt = alreadyDeletedAt ?? ts;
      const nextUpdatedAt = Math.max(Number(r.updatedAt ?? 0) || 0, nextDeletedAt, ts);

      if (alreadyDeletedAt == null) {
        await db
          .update(entityTypes)
          .set({ deletedAt: nextDeletedAt, updatedAt: nextUpdatedAt, syncStatus: 'synced' })
          .where(eq(entityTypes.id, r.id));
      }
      const payload = {
        id: String(r.id),
        code: String(r.code),
        name: String(r.name),
        created_at: Number(r.createdAt),
        updated_at: nextUpdatedAt,
        deleted_at: nextDeletedAt,
        sync_status: 'synced',
      };
      await recordSyncChanges(
        { id: 'system', username: 'system', role: 'system' },
        [
          {
            tableName: SyncTableName.EntityTypes,
            rowId: String(r.id),
            op: 'delete',
            payload,
            ts,
          },
        ],
      );
    }

    return { ok: true, affected: rows.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function main() {
  const r = await cleanupBulkEntityTypes();
  console.log(JSON.stringify(r));
  if (!r.ok) process.exit(1);
}

void main();


