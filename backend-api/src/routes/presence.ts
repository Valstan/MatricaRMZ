import { Router } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { db } from '../database/db.js';
import { userPresence } from '../database/schema.js';
import { requireAuth, type AuthenticatedRequest } from '../auth/middleware.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';
import { SyncTableName } from '@matricarmz/shared';

export const presenceRouter = Router();

presenceRouter.use(requireAuth);

presenceRouter.get('/me', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });
    const now = Date.now();

    await db
      .insert(userPresence)
      .values({
        id: actor.id as any,
        userId: actor.id as any,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        syncStatus: 'synced',
      })
      .onConflictDoUpdate({
        target: userPresence.id,
        set: {
          userId: sql`excluded.user_id`,
          lastActivityAt: sql`excluded.last_activity_at`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
          syncStatus: 'synced',
        },
      });
    await recordSyncChanges(
      { id: actor.id, username: actor.username ?? actor.id, role: actor.role ?? 'user' },
      [
        {
          tableName: SyncTableName.UserPresence,
          rowId: actor.id,
          op: 'upsert',
          payload: {
            id: actor.id,
            user_id: actor.id,
            last_activity_at: now,
            created_at: now,
            updated_at: now,
            deleted_at: null,
            sync_status: 'synced',
          },
          ts: now,
        },
      ],
    );

    const row = await db
      .select({ lastActivityAt: userPresence.lastActivityAt })
      .from(userPresence)
      .where(and(eq(userPresence.userId, actor.id as any), isNull(userPresence.deletedAt)))
      .limit(1);

    const last = row[0]?.lastActivityAt == null ? null : Number(row[0].lastActivityAt);
    const onlineWindowMs = 5 * 60_000;
    const online = last != null && now - last < onlineWindowMs;

    return res.json({ ok: true, online, lastActivityAt: last });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
