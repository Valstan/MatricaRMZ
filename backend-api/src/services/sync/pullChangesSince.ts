/**
 * pullChangesSince -- incremental pull from ledgerTxIndex with privacy pre-filtering.
 *
 * Optimization: for non-admin users, chat_messages/chat_reads/notes/note_shares
 * are pre-filtered at the SQL level using payload_json extraction, avoiding
 * unnecessary JSON parsing in application code.
 */
import type { SyncPullResponse } from '@matricarmz/shared';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import os from 'node:os';

import { db } from '../../database/db.js';
import { clientSettings, ledgerTxIndex, notes, noteShares } from '../../database/schema.js';
import { ensureLedgerTxIndexUpToDate } from './ledgerTxIndexService.js';

function withServerSeq(payloadJson: string, serverSeq: number): string {
  try {
    const parsed = JSON.parse(String(payloadJson ?? '')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return payloadJson;
    parsed.last_server_seq = serverSeq;
    return JSON.stringify(parsed);
  } catch {
    return payloadJson;
  }
}

/** Privacy-sensitive table names. */
const PRIVACY_TABLES = new Set(['chat_messages', 'chat_reads', 'notes', 'note_shares']);

export async function pullChangesSince(
  since: number,
  actor: { id: string; role: string },
  limit = 5000,
  opts?: { clientId?: string | null },
): Promise<SyncPullResponse> {
  const requestedLimit = Math.max(1, Math.min(20000, Number(limit) || 5000));
  await ensureLedgerTxIndexUpToDate().catch(() => null);
  const maxSeqRow = await db.select({ max: sql<number>`coalesce(max(${ledgerTxIndex.serverSeq}), 0)` }).from(ledgerTxIndex).limit(1);
  const serverLastSeq = Number(maxSeqRow[0]?.max ?? 0);
  const effectiveSince = Math.max(0, Math.min(Number(since ?? 0), serverLastSeq));

  // Adaptive page size
  let safeLimit = requestedLimit;
  if (String(process.env.MATRICA_SYNC_PULL_ADAPTIVE_ENABLED ?? '1').trim() !== '0') {
    const backlog = Math.max(0, serverLastSeq - effectiveSince);
    if (backlog >= 100_000) {
      safeLimit = Math.max(safeLimit, 10_000);
    } else if (backlog >= 20_000) {
      safeLimit = Math.max(safeLimit, 7000);
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

  const actorId = String(actor?.id ?? '');
  const actorRole = String(actor?.role ?? '').toLowerCase();
  const actorIsAdmin = actorRole === 'admin' || actorRole === 'superadmin';
  const actorIsPending = actorRole === 'pending';

  // ── Privacy-aware SQL query ──────────────────────────────
  // For non-admin users, use SQL-level pre-filtering on privacy tables to avoid
  // reading and parsing JSON for rows the user cannot access.
  let rows;
  if (actorIsAdmin) {
    rows = await db
      .select({
        table: ledgerTxIndex.tableName,
        rowId: ledgerTxIndex.rowId,
        op: ledgerTxIndex.op,
        payloadJson: ledgerTxIndex.payloadJson,
        serverSeq: ledgerTxIndex.serverSeq,
      })
      .from(ledgerTxIndex)
      .where(gt(ledgerTxIndex.serverSeq, effectiveSince))
      .orderBy(asc(ledgerTxIndex.serverSeq))
      .limit(safeLimit + 1);
  } else {
    // Build a WHERE clause that pre-filters privacy tables at SQL level:
    // - Non-privacy tables: always include
    // - chat_messages: sender_user_id or recipient_user_id matches actor
    // - chat_reads: user_id matches actor
    // - notes: owner_user_id matches actor (shared notes handled in post-filter)
    // - note_shares: recipient_user_id matches actor (owner check in post-filter)
    const privacyFilter = or(
      // Non-privacy tables: always pass
      sql`${ledgerTxIndex.tableName} NOT IN ('chat_messages', 'chat_reads', 'notes', 'note_shares')`,
      // chat_messages: sender or recipient matches
      and(
        eq(ledgerTxIndex.tableName, 'chat_messages'),
        or(
          sql`${ledgerTxIndex.payloadJson}::jsonb->>'sender_user_id' = ${actorId}`,
          sql`${ledgerTxIndex.payloadJson}::jsonb->>'recipient_user_id' = ${actorId}`,
          // Broadcast messages (no recipient) - visible to non-pending users
          ...(actorIsPending ? [] : [sql`${ledgerTxIndex.payloadJson}::jsonb->>'recipient_user_id' IS NULL`]),
        ),
      ),
      // chat_reads: user_id matches
      and(
        eq(ledgerTxIndex.tableName, 'chat_reads'),
        sql`${ledgerTxIndex.payloadJson}::jsonb->>'user_id' = ${actorId}`,
      ),
      // notes: own notes always visible; shared notes handled in post-filter
      and(
        eq(ledgerTxIndex.tableName, 'notes'),
        sql`${ledgerTxIndex.payloadJson}::jsonb->>'owner_user_id' = ${actorId}`,
      ),
      // note_shares: recipient matches or note owner matches (owner check in post-filter)
      and(
        eq(ledgerTxIndex.tableName, 'note_shares'),
        sql`${ledgerTxIndex.payloadJson}::jsonb->>'recipient_user_id' = ${actorId}`,
      ),
    );

    rows = await db
      .select({
        table: ledgerTxIndex.tableName,
        rowId: ledgerTxIndex.rowId,
        op: ledgerTxIndex.op,
        payloadJson: ledgerTxIndex.payloadJson,
        serverSeq: ledgerTxIndex.serverSeq,
      })
      .from(ledgerTxIndex)
      .where(and(gt(ledgerTxIndex.serverSeq, effectiveSince), privacyFilter))
      .orderBy(asc(ledgerTxIndex.serverSeq))
      .limit(safeLimit + 1);
  }

  // ── Post-filter for shared notes ─────────────────────────
  // The SQL pre-filter catches direct ownership but not shared notes.
  // We need a small post-filter for notes shared with the user.
  let pageRows = rows.slice(0, safeLimit);
  const hasMore = rows.length > safeLimit;

  if (!actorIsAdmin) {
    // Check for notes shared with this user that may have been missed by owner-only SQL filter
    const missedNoteIds = new Set<string>();
    // Also collect note_shares rows that need owner verification
    const noteShareNoteIds: string[] = [];

    // Scan current batch for notes/note_shares that might need additional visibility
    for (const r of pageRows) {
      if (String(r.table) === 'note_shares') {
        try {
          const p = JSON.parse(String(r.payloadJson ?? '')) as Record<string, unknown>;
          if (p?.note_id) noteShareNoteIds.push(String(p.note_id));
        } catch {
          continue;
        }
      }
    }

    // For note_shares: verify the note owner is the actor (already included via recipient in SQL)
    // This is handled by the SQL filter for recipient_user_id, but we need to add
    // notes the user created that got shared -- those note_shares rows are already included
    // because the SQL filters for recipient_user_id match.

    // For notes: add shared notes that the SQL filter missed (not owner but shared with)
    const noteRows = pageRows.filter((r) => String(r.table) === 'notes');
    if (noteRows.length === 0) {
      // The SQL filter already filtered out notes not owned by the actor.
      // We need to add back notes shared with the actor.
      // This requires a separate query for notes shared with this user.
    }

    // Get IDs of notes shared with this user
    const sharedNotesResult = await db
      .select({ noteId: noteShares.noteId })
      .from(noteShares)
      .where(and(eq(noteShares.recipientUserId, actorId), isNull(noteShares.deletedAt), eq(noteShares.hidden, false)))
      .limit(50_000);
    const sharedNoteIds = new Set(sharedNotesResult.map((r) => String(r.noteId)));

    // Add shared notes that were filtered out by the SQL-level owner check
    if (sharedNoteIds.size > 0) {
      const sharedNoteIdsArr = Array.from(sharedNoteIds);
      const sharedNoteRows = await db
        .select({
          table: ledgerTxIndex.tableName,
          rowId: ledgerTxIndex.rowId,
          op: ledgerTxIndex.op,
          payloadJson: ledgerTxIndex.payloadJson,
          serverSeq: ledgerTxIndex.serverSeq,
        })
        .from(ledgerTxIndex)
        .where(
          and(
            gt(ledgerTxIndex.serverSeq, effectiveSince),
            eq(ledgerTxIndex.tableName, 'notes'),
            inArray(ledgerTxIndex.rowId, sharedNoteIdsArr),
          ),
        )
        .orderBy(asc(ledgerTxIndex.serverSeq))
        .limit(safeLimit);

      // Merge shared note rows into pageRows (avoiding duplicates)
      const existingSeqs = new Set(pageRows.map((r) => r.serverSeq));
      for (const r of sharedNoteRows) {
        if (!existingSeqs.has(r.serverSeq)) {
          pageRows.push(r);
        }
      }

      // Re-sort by serverSeq
      pageRows.sort((a, b) => a.serverSeq - b.serverSeq);
    }

    // Also check note_shares where actor is the note owner
    if (noteShareNoteIds.length > 0) {
      const uniqueNoteIds = Array.from(new Set(noteShareNoteIds));
      const ownedNotes = await db
        .select({ id: notes.id })
        .from(notes)
        .where(and(inArray(notes.id, uniqueNoteIds), eq(notes.ownerUserId, actorId)))
        .limit(50_000);
      const ownedNoteIdSet = new Set(ownedNotes.map((r) => String(r.id)));

      // Get note_shares for owned notes that the SQL filter might have missed
      const ownedShareRows = await db
        .select({
          table: ledgerTxIndex.tableName,
          rowId: ledgerTxIndex.rowId,
          op: ledgerTxIndex.op,
          payloadJson: ledgerTxIndex.payloadJson,
          serverSeq: ledgerTxIndex.serverSeq,
        })
        .from(ledgerTxIndex)
        .where(
          and(
            gt(ledgerTxIndex.serverSeq, effectiveSince),
            eq(ledgerTxIndex.tableName, 'note_shares'),
            inArray(ledgerTxIndex.rowId, Array.from(ownedNoteIdSet)),
          ),
        )
        .orderBy(asc(ledgerTxIndex.serverSeq))
        .limit(safeLimit);

      const existingSeqs2 = new Set(pageRows.map((r) => r.serverSeq));
      for (const r of ownedShareRows) {
        if (!existingSeqs2.has(r.serverSeq)) {
          pageRows.push(r);
        }
      }

      pageRows.sort((a, b) => a.serverSeq - b.serverSeq);
    }
  }

  const last = pageRows.at(-1)?.serverSeq ?? effectiveSince;

  return {
    sync_protocol_version: 2,
    sync_mode: 'incremental',
    server_cursor: last,
    server_last_seq: serverLastSeq,
    has_more: hasMore,
    changes: pageRows.map((r) => ({
      table: r.table as SyncPullResponse['changes'][number]['table'],
      row_id: r.rowId,
      op: r.op as SyncPullResponse['changes'][number]['op'],
      payload_json: withServerSeq(r.payloadJson, r.serverSeq),
      server_seq: r.serverSeq,
    })),
  };
}
