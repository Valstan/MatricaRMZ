import type { SyncPullResponse } from '@matricarmz/shared';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import os from 'node:os';

import { db } from '../../database/db.js';
import { clientSettings, ledgerTxIndex, notes, noteShares } from '../../database/schema.js';

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
  opts?: { clientId?: string | null },
): Promise<SyncPullResponse> {
  const requestedLimit = Math.max(1, Math.min(20000, Number(limit) || 5000));
  if (since === 0 && typeof (db as any).execute === 'function') {
    // Мягкий backfill для старых инсталляций: индексируем уже существующий change_log.
    await (db as any).execute(sql`
      INSERT INTO ledger_tx_index (server_seq, table_name, row_id, op, payload_json, created_at)
      SELECT server_seq, table_name, row_id, op, payload_json, created_at
      FROM change_log
      ON CONFLICT (server_seq) DO NOTHING
    `);
  }
  const maxSeqRow = await db.select({ max: sql<number>`coalesce(max(${ledgerTxIndex.serverSeq}), 0)` }).from(ledgerTxIndex).limit(1);
  const serverLastSeq = Number(maxSeqRow[0]?.max ?? 0);
  let safeLimit = requestedLimit;
  if (String(process.env.MATRICA_SYNC_PULL_ADAPTIVE_ENABLED ?? '1').trim() !== '0') {
    const backlog = Math.max(0, serverLastSeq - Number(since ?? 0));
    const cores = Math.max(1, Number((os as any).availableParallelism?.() ?? os.cpus()?.length ?? 1));
    const load = Number(os.loadavg?.()[0] ?? 0);
    if (backlog >= 100_000) {
      safeLimit = Math.max(safeLimit, 10_000);
    } else if (backlog >= 20_000) {
      safeLimit = Math.max(safeLimit, 7000);
    }
    if (load > cores * 1.2) {
      safeLimit = Math.max(1500, Math.min(safeLimit, Math.floor(safeLimit * 0.5)));
    }
    const driftRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(clientSettings)
      .where(sql`${clientSettings.syncRequestType} is not null`)
      .limit(1)
      .catch(() => [{ count: 0 }]);
    const driftClients = Number(driftRows?.[0]?.count ?? 0);
    if (driftClients >= 10) {
      safeLimit = Math.max(1000, Math.min(safeLimit, 3000));
    }
    if (opts?.clientId && backlog > 0 && backlog <= 5000 && driftClients >= 5) {
      safeLimit = Math.max(500, Math.min(safeLimit, 2000));
    }
    safeLimit = Math.max(1, Math.min(20_000, safeLimit));
  }
  const rows = await db
    .select({
      table: ledgerTxIndex.tableName,
      rowId: ledgerTxIndex.rowId,
      op: ledgerTxIndex.op,
      payloadJson: ledgerTxIndex.payloadJson,
      serverSeq: ledgerTxIndex.serverSeq,
    })
    .from(ledgerTxIndex)
    .where(gt(ledgerTxIndex.serverSeq, since))
    .orderBy(asc(ledgerTxIndex.serverSeq))
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
    sync_protocol_version: 2,
    sync_mode: 'incremental',
    server_cursor: last,
    server_last_seq: serverLastSeq,
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


