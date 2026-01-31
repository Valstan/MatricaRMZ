import type { SyncPullResponse } from '@matricarmz/shared';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { changeLog, notes, noteShares } from '../../database/schema.js';

function withServerSeq(payloadJson: string, serverSeq: number): string {
  try {
    const parsed = JSON.parse(String(payloadJson ?? '')) as any;
    if (!parsed || typeof parsed !== 'object') return payloadJson;
    parsed.last_server_seq = serverSeq;
    return JSON.stringify(parsed);
  } catch {
    return payloadJson;
  }
}

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

  let sharedNoteIds = new Set<string>();
  let noteOwnerById = new Map<string, string>();

  if (!actorIsAdmin) {
    const noteRows = pageRows.filter((r) => String(r.table) === 'notes');
    const noteShareRows = pageRows.filter((r) => String(r.table) === 'note_shares');

    if (noteRows.length > 0) {
      const noteIds = noteRows.map((r) => String(r.rowId));
      const shares = await db
        .select({ noteId: noteShares.noteId, hidden: noteShares.hidden })
        .from(noteShares)
        .where(and(eq(noteShares.recipientUserId, actorId), inArray(noteShares.noteId, noteIds as any), isNull(noteShares.deletedAt)))
        .limit(50_000);
      sharedNoteIds = new Set(shares.filter((s) => !s.hidden).map((s) => String(s.noteId)));
    }

    if (noteShareRows.length > 0) {
      const noteIds: string[] = [];
      for (const r of noteShareRows) {
        try {
          const p = JSON.parse(String(r.payloadJson ?? '')) as any;
          if (p?.note_id) noteIds.push(String(p.note_id));
        } catch {
          continue;
        }
      }
      const uniqueIds = Array.from(new Set(noteIds));
      if (uniqueIds.length === 0) {
        noteOwnerById = new Map();
      } else {
      const owners = await db
        .select({ id: notes.id, ownerUserId: notes.ownerUserId })
        .from(notes)
        .where(inArray(notes.id, uniqueIds as any))
        .limit(50_000);
        noteOwnerById = new Map(owners.map((r) => [String(r.id), String(r.ownerUserId)]));
      }
    }
  }

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
    if (table === 'notes') {
      if (actorIsAdmin) return true;
      try {
        const p = JSON.parse(String(r.payloadJson ?? '')) as any;
        const ownerId = String(p?.owner_user_id ?? '');
        if (ownerId === actorId) return true;
        return sharedNoteIds.has(String(r.rowId));
      } catch {
        return false;
      }
    }
    if (table === 'note_shares') {
      if (actorIsAdmin) return true;
      try {
        const p = JSON.parse(String(r.payloadJson ?? '')) as any;
        const recipientId = String(p?.recipient_user_id ?? '');
        if (recipientId === actorId) return true;
        const ownerId = noteOwnerById.get(String(p?.note_id ?? ''));
        return ownerId === actorId;
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
      payload_json: withServerSeq(r.payloadJson, r.serverSeq),
      server_seq: r.serverSeq,
    })),
  };
}


