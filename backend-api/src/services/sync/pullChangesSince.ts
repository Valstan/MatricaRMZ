/**
 * pullChangesSince -- incremental pull from PostgreSQL (sync tables) + ledgerTxIndex (non-sync).
 *
 * For all SyncTable names the query goes directly against the canonical PG table
 * using `last_server_seq > since`.  This avoids phantom UUIDs that exist in the
 * in-memory ledger / ledger_tx_index but not in PG.
 *
 * Privacy pre-filtering for chat_messages / chat_reads / notes / note_shares is
 * applied at the SQL level so non-admin users only receive rows they are allowed
 * to see.
 *
 * Non-sync tables (e.g. release_registry) still fall through to ledger_tx_index.
 */
import type { SyncPullResponse } from '@matricarmz/shared';
import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import { db } from '../../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  chatMessages,
  chatReads,
  clientSettings,
  entities,
  entityTypes,
  ledgerTxIndex,
  notes,
  noteShares,
  operations,
  userPresence,
} from '../../database/schema.js';
import { getLedgerLastSeq } from '../../ledger/ledgerService.js';
import { ensureLedgerTxIndexUpToDate } from './ledgerTxIndexService.js';

// ── PG table map (same structure used by /state/snapshot) ────────────
const PG_SYNC_TABLES: Record<
  string,
  { drizzle: any; toSyncRow: (r: any) => Record<string, unknown> }
> = {
  [SyncTableName.EntityTypes]: { drizzle: entityTypes, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.EntityTypes, r) },
  [SyncTableName.Entities]: { drizzle: entities, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.Entities, r) },
  [SyncTableName.AttributeDefs]: { drizzle: attributeDefs, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.AttributeDefs, r) },
  [SyncTableName.AttributeValues]: { drizzle: attributeValues, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.AttributeValues, r) },
  [SyncTableName.Operations]: { drizzle: operations, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.Operations, r) },
  [SyncTableName.AuditLog]: { drizzle: auditLog, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.AuditLog, r) },
  [SyncTableName.ChatMessages]: { drizzle: chatMessages, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ChatMessages, r) },
  [SyncTableName.ChatReads]: { drizzle: chatReads, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ChatReads, r) },
  [SyncTableName.UserPresence]: { drizzle: userPresence, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.UserPresence, r) },
  [SyncTableName.Notes]: { drizzle: notes, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.Notes, r) },
  [SyncTableName.NoteShares]: { drizzle: noteShares, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.NoteShares, r) },
};

/** Privacy-sensitive table names that need per-user filtering. */
const PRIVACY_TABLES = new Set<string>([
  SyncTableName.ChatMessages,
  SyncTableName.ChatReads,
  SyncTableName.Notes,
  SyncTableName.NoteShares,
]);

// ── Helpers ──────────────────────────────────────────────────────────

/** Compute adaptive page-size limit based on backlog and drift. */
async function computeSafeLimit(
  requestedLimit: number,
  effectiveSince: number,
  serverLastSeq: number,
  clientId: string | null | undefined,
): Promise<number> {
  let safeLimit = requestedLimit;
  if (String(process.env.MATRICA_SYNC_PULL_ADAPTIVE_ENABLED ?? '1').trim() === '0') return safeLimit;

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
  if (clientId && backlog > 0 && backlog <= 5000 && driftClients >= 5) {
    safeLimit = Math.max(500, Math.min(safeLimit, 2000));
  }
  return Math.max(1, Math.min(20_000, safeLimit));
}

type ChangeRow = SyncPullResponse['changes'][number];

/** Convert a PG row to the standard change-row format used by the pull response. */
function pgRowToChange(
  tableName: string,
  pgRow: Record<string, unknown>,
  toSyncRow: (r: any) => Record<string, unknown>,
): ChangeRow {
  const dto = toSyncRow(pgRow);
  const serverSeq = Number(pgRow.lastServerSeq ?? 0);
  dto.last_server_seq = serverSeq;
  const deletedAt = pgRow.deletedAt ?? null;
  return {
    table: tableName as ChangeRow['table'],
    row_id: String(pgRow.id ?? ''),
    op: deletedAt != null ? 'delete' : 'upsert',
    payload_json: JSON.stringify(dto),
    server_seq: serverSeq,
  };
}

// ── Privacy filter helpers ───────────────────────────────────────────

function privacyFilterForTable(
  tableName: string,
  pgTable: any,
  actorId: string,
  actorIsPending: boolean,
): any | null {
  switch (tableName) {
    case SyncTableName.ChatMessages: {
      const conditions = [
        eq(pgTable.senderUserId, actorId),
        eq(pgTable.recipientUserId, actorId),
      ];
      if (!actorIsPending) {
        conditions.push(isNull(pgTable.recipientUserId));
      }
      return or(...conditions);
    }
    case SyncTableName.ChatReads:
      return eq(pgTable.userId, actorId);
    case SyncTableName.Notes:
      return eq(pgTable.ownerUserId, actorId);
    case SyncTableName.NoteShares:
      return eq(pgTable.recipientUserId, actorId);
    default:
      return undefined;
  }
}

/** Fetch shared-note IDs for the actor so we can include notes shared with them. */
async function getSharedNoteIds(actorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ noteId: noteShares.noteId })
    .from(noteShares)
    .where(and(eq(noteShares.recipientUserId, actorId), isNull(noteShares.deletedAt), eq(noteShares.hidden, false)))
    .limit(50_000);
  return new Set(rows.map((r) => String(r.noteId)));
}

// ── Main function ────────────────────────────────────────────────────

export async function pullChangesSince(
  since: number,
  actor: { id: string; role: string },
  limit = 5000,
  opts?: { clientId?: string | null },
): Promise<SyncPullResponse> {
  const requestedLimit = Math.max(1, Math.min(20000, Number(limit) || 5000));

  // Still keep LTI up-to-date for non-sync tables (release_registry etc.)
  await ensureLedgerTxIndexUpToDate().catch(() => null);

  // Determine the global "last seq" from both PG-based sync tables and ledger
  const ltiMaxRow = await db
    .select({ max: sql<number>`coalesce(max(${ledgerTxIndex.serverSeq}), 0)` })
    .from(ledgerTxIndex)
    .limit(1);
  const ltiLastSeq = Number(ltiMaxRow[0]?.max ?? 0);
  const ledgerLastSeq = getLedgerLastSeq();
  const serverLastSeq = Math.max(ltiLastSeq, ledgerLastSeq);

  const effectiveSince = Math.max(0, Math.min(Number(since ?? 0), serverLastSeq));

  const safeLimit = await computeSafeLimit(requestedLimit, effectiveSince, serverLastSeq, opts?.clientId);

  const actorId = String(actor?.id ?? '');
  const actorRole = String(actor?.role ?? '').toLowerCase();
  const actorIsAdmin = actorRole === 'admin' || actorRole === 'superadmin';
  const actorIsPending = actorRole === 'pending';

  // ── 1. Query PG sync tables ──────────────────────────────
  // For each sync table, SELECT rows WHERE last_server_seq > since,
  // applying privacy filters for non-admin users, then merge all results.
  const allChanges: ChangeRow[] = [];
  const sharedNoteIds = (!actorIsAdmin && !actorIsPending) ? await getSharedNoteIds(actorId) : new Set<string>();

  for (const [tableName, entry] of Object.entries(PG_SYNC_TABLES)) {
    const pgTable = entry.drizzle;
    const isPrivacy = PRIVACY_TABLES.has(tableName);

    const conditions: any[] = [];
    if ('lastServerSeq' in pgTable) {
      conditions.push(gt(pgTable.lastServerSeq, effectiveSince));
    }

    // Privacy filtering for non-admin
    if (!actorIsAdmin && isPrivacy) {
      const pf = privacyFilterForTable(tableName, pgTable, actorId, actorIsPending);
      if (pf) {
        if (tableName === SyncTableName.Notes && sharedNoteIds.size > 0) {
          // Include notes owned by actor OR shared with actor
          const sharedArr = Array.from(sharedNoteIds);
          conditions.push(or(pf, inArray(pgTable.id, sharedArr)));
        } else {
          conditions.push(pf);
        }
      }
    }

    // Pending users should not see most privacy tables at all
    if (actorIsPending && isPrivacy) continue;

    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

    const rows = await db
      .select()
      .from(pgTable)
      .$dynamic()
      .where(where)
      .orderBy('lastServerSeq' in pgTable ? asc(pgTable.lastServerSeq) : asc(pgTable.id))
      .limit(safeLimit);

    for (const row of rows) {
      allChanges.push(pgRowToChange(tableName, row as Record<string, unknown>, entry.toSyncRow));
    }
  }

  // For non-admin: add note_shares where actor is the note owner (not just recipient)
  if (!actorIsAdmin && !actorIsPending) {
    const ownedNoteRows = await db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.ownerUserId, actorId), isNull(notes.deletedAt)))
      .limit(50_000);
    const ownedNoteIdSet = new Set(ownedNoteRows.map((r) => String(r.id)));

    if (ownedNoteIdSet.size > 0) {
      const ownedArr = Array.from(ownedNoteIdSet);
      const shareRows = await db
        .select()
        .from(noteShares)
        .$dynamic()
        .where(and(gt(noteShares.lastServerSeq, effectiveSince), inArray(noteShares.noteId, ownedArr)))
        .orderBy(asc(noteShares.lastServerSeq))
        .limit(safeLimit);

      const existingIds = new Set(
        allChanges.filter((c) => c.table === SyncTableName.NoteShares).map((c) => c.row_id),
      );
      for (const row of shareRows) {
        const id = String((row as any).id ?? '');
        if (!existingIds.has(id)) {
          allChanges.push(
            pgRowToChange(SyncTableName.NoteShares, row as Record<string, unknown>, PG_SYNC_TABLES[SyncTableName.NoteShares]!.toSyncRow),
          );
        }
      }
    }
  }

  // ── 2. Query ledger_tx_index for non-sync tables ─────────
  // (e.g. release_registry)
  {
    const syncTableNames = Object.keys(PG_SYNC_TABLES);
    const ltiRows = await db
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
          sql`${ledgerTxIndex.tableName} NOT IN (${sql.join(
            syncTableNames.map((n) => sql`${n}`),
            sql`, `,
          )})`,
        ),
      )
      .orderBy(asc(ledgerTxIndex.serverSeq))
      .limit(safeLimit);

    for (const r of ltiRows) {
      allChanges.push({
        table: r.table as ChangeRow['table'],
        row_id: r.rowId,
        op: r.op as 'upsert' | 'delete',
        payload_json: r.payloadJson,
        server_seq: r.serverSeq,
      });
    }
  }

  // ── 3. Sort, paginate, respond ─────────────────────────────
  allChanges.sort((a, b) => a.server_seq - b.server_seq);

  const hasMore = allChanges.length > safeLimit;
  const pageChanges = allChanges.slice(0, safeLimit);
  const lastSeq = pageChanges.at(-1)?.server_seq ?? effectiveSince;

  return {
    sync_protocol_version: 2,
    sync_mode: 'incremental',
    server_cursor: lastSeq,
    server_last_seq: serverLastSeq,
    has_more: hasMore,
    changes: pageChanges,
  };
}
