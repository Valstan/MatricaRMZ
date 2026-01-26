import type { SyncPullResponse } from '@matricarmz/shared';
import { gt, asc } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { changeLog } from '../../database/schema.js';

export async function pullChangesSince(
  since: number,
  actor: { id: string; role: string },
  limit = 5000,
): Promise<SyncPullResponse> {
  const safeLimit = Math.max(1, Math.min(20000, Number(limit) || 5000));
  const rows = await db
    .select({
      table: changeLog.tableName,
      rowId: changeLog.rowId,
      op: changeLog.op,
      payloadJson: changeLog.payloadJson,
      serverSeq: changeLog.serverSeq,
    })
    .from(changeLog)
    .where(gt(changeLog.serverSeq, since))
    .orderBy(asc(changeLog.serverSeq))
    .limit(safeLimit + 1);
  const pageRows = rows.slice(0, safeLimit);
  const hasMore = rows.length > safeLimit;

  const actorId = String(actor?.id ?? '');
  const actorRole = String(actor?.role ?? '').toLowerCase();
  const actorIsAdmin = actorRole === 'admin' || actorRole === 'superadmin';
  const actorIsPending = actorRole === 'pending';

  const filtered = pageRows.filter((r) => {
    const table = String(r.table);
    if (table === 'chat_messages') {
      if (actorIsAdmin) return true;
      try {
        const p = JSON.parse(String(r.payloadJson ?? '')) as any;
        const senderId = String(p?.sender_user_id ?? '');
        const recipientId = p?.recipient_user_id == null ? null : String(p?.recipient_user_id);
        if (!recipientId) return actorIsPending ? false : true;
        return senderId === actorId || recipientId === actorId;
      } catch {
        return false;
      }
    }
    if (table === 'chat_reads') {
      if (actorIsAdmin) return true;
      try {
        const p = JSON.parse(String(r.payloadJson ?? '')) as any;
        const userId = String(p?.user_id ?? '');
        return userId === actorId;
      } catch {
        return false;
      }
    }
    return true;
  });

  // IMPORTANT: cursor must reflect the real last server_seq we observed.
  const last = pageRows.at(-1)?.serverSeq ?? since;

  return {
    server_cursor: last,
    has_more: hasMore,
    changes: filtered.map((r) => ({
      table: r.table as any,
      row_id: r.rowId,
      op: r.op as any,
      payload_json: r.payloadJson,
      server_seq: r.serverSeq,
    })),
  };
}


