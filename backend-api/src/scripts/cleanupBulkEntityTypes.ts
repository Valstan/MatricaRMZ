import { db } from '../database/db.js';
import { changeLog, entityTypes } from '../database/schema.js';
import { and, eq, isNull, like, or } from 'drizzle-orm';

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
        and(
          isNull(entityTypes.deletedAt),
          or(like(entityTypes.code, 't_bulk_%'), like(entityTypes.name, 'Type Bulk %')),
        ),
      )
      .limit(50_000);

    if (rows.length === 0) return { ok: true, affected: 0 };

    // Soft delete + write change_log so clients remove/hide them on next pull.
    for (const r of rows as any[]) {
      await db.update(entityTypes).set({ deletedAt: ts, updatedAt: ts, syncStatus: 'synced' }).where(eq(entityTypes.id, r.id));
      const payload = {
        id: String(r.id),
        code: String(r.code),
        name: String(r.name),
        created_at: Number(r.createdAt),
        updated_at: ts,
        deleted_at: ts,
        sync_status: 'synced',
      };
      await db.insert(changeLog).values({
        tableName: 'entity_types',
        rowId: r.id,
        op: 'delete',
        payloadJson: JSON.stringify(payload),
        createdAt: ts,
      });
    }

    return { ok: true, affected: rows.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function main() {
  const r = await cleanupBulkEntityTypes();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(r));
  if (!r.ok) process.exit(1);
}

void main();


