import type { SyncPullResponse } from '@matricarmz/shared';
import { gt, asc } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { changeLog } from '../../database/schema.js';

export async function pullChangesSince(
  since: number,
  actor: { id: string; role: string },
): Promise<SyncPullResponse> {
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
    .limit(5000);

  const actorId = String(actor?.id ?? '');
  const actorRole = String(actor?.role ?? '').toLowerCase();
  const actorIsAdmin = actorRole === 'admin' || actorRole === 'superadmin';
  const actorIsPending = actorRole === 'pending';

  // Filter out test/bulk artifacts (historical bench data) so new clients don't pull them.
  // IMPORTANT: we MUST still allow delete events through, otherwise clients can't get rid of them.
  function isBulkEntityTypePayload(payloadJson: string): boolean {
    try {
      const p = JSON.parse(payloadJson) as any;
      const code = String(p?.code ?? '');
      const name = String(p?.name ?? '');
      if (code.startsWith('t_bulk_')) return true;
      if (name.startsWith('Type Bulk ')) return true;
      return false;
    } catch {
      return false;
    }
  }

  const filtered = rows.filter((r) => {
    const table = String(r.table);

    // Chat privacy filter:
    // - chat_messages: private messages are visible only to sender/recipient (or admin)
    // - chat_reads: visible only to the owning user (or admin)
    if (table === 'chat_messages') {
      if (actorIsAdmin) return true;
      try {
        const p = JSON.parse(String(r.payloadJson ?? '')) as any;
        const senderId = String(p?.sender_user_id ?? '');
        const recipientId = p?.recipient_user_id == null ? null : String(p?.recipient_user_id);
        if (!recipientId) return actorIsPending ? false : true; // pending не видит общий чат
        return senderId === actorId || recipientId === actorId;
      } catch {
        // If payload is corrupted, be safe and do not leak it.
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

    if (table !== 'entity_types') return true;
    // Always allow delete operations (they are needed to clean up client caches).
    if (String(r.op) === 'delete') return true;
    return !isBulkEntityTypePayload(String(r.payloadJson ?? ''));
  });

  // IMPORTANT: cursor must reflect the real last server_seq we observed,
  // even if we filtered some changes out, otherwise clients will "loop".
  const last = rows.at(-1)?.serverSeq ?? since;

  return {
    server_cursor: last,
    changes: filtered.map((r) => ({
      table: r.table as any,
      row_id: r.rowId,
      op: r.op as any,
      payload_json: r.payloadJson,
      server_seq: r.serverSeq,
    })),
  };
}


