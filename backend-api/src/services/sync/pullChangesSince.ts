/**
 * pullChangesSince -- incremental pull from PostgreSQL (sync tables) + ledgerTxIndex (non-sync).
 *
 * For all SyncTable names the query goes directly against the canonical PG table
 * using `last_server_seq > since`.  This avoids phantom UUIDs that exist in the
 * journal (ledger_tx_index) but not in PG.
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
  erpEngineInstances,
  erpEngineInventoryLines,
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  ledgerTxIndex,
  notes,
  noteShares,
  cardDrafts,
  aiChatRequests,
  operations,
  userPresence,
  users,
  userSectionAccess,
} from '../../database/schema.js';
import { getLedgerLastSeq } from '../../ledger/ledgerService.js';
import { PRIVACY_TABLES, privacyFilterForTable, getSharedNoteIds } from './syncPrivacy.js';
import { isPullTableAllowedForRole } from './pullReadFilter.js';

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
  [SyncTableName.CardDrafts]: { drizzle: cardDrafts, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.CardDrafts, r) },
  [SyncTableName.AiChatRequests]: { drizzle: aiChatRequests, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.AiChatRequests, r) },
  [SyncTableName.ErpNomenclature]: { drizzle: erpNomenclature, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpNomenclature, r) },
  [SyncTableName.ErpEngineAssemblyBom]: {
    drizzle: erpEngineAssemblyBom,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineAssemblyBom, r),
  },
  [SyncTableName.ErpEngineAssemblyBomLines]: {
    drizzle: erpEngineAssemblyBomLines,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineAssemblyBomLines, r),
  },
  [SyncTableName.ErpEngineAssemblyBomBrandLinks]: {
    drizzle: erpEngineAssemblyBomBrandLinks,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineAssemblyBomBrandLinks, r),
  },
  [SyncTableName.ErpEngineInstances]: {
    drizzle: erpEngineInstances,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineInstances, r),
  },
  [SyncTableName.ErpEngineInventoryLines]: {
    drizzle: erpEngineInventoryLines,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineInventoryLines, r),
  },
  // B3/R3. Видимость решена ЯВНО, а не унаследована: обе таблицы раздаются всем
  // ролям целиком и в PRIVACY_TABLES не входят. Это паритет с сегодняшним днём —
  // login / system_role / access_enabled / section_access уже сейчас уезжают на
  // каждую машину парка через attribute_values (они намеренно не в
  // HR_SENSITIVE_CODES, см. шапку pullReadFilter.ts). Сузить нельзя и по делу:
  // офлайн-гейт разделов обязан работать на КАЖДОЙ машине, а не только у админов,
  // и ему нужна политика целиком, а не своя строка.
  [SyncTableName.Users]: { drizzle: users, toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.Users, r) },
  [SyncTableName.UserSectionAccess]: {
    drizzle: userSectionAccess,
    toSyncRow: (r: any) => SyncTableRegistry.toSyncRow(SyncTableName.UserSectionAccess, r),
  },
};

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

/**
 * Куда двигать курсор клиента после страницы изменений.
 *
 * Пустая страница означает «выше курсора нет НИ ОДНОЙ видимой этому клиенту строки»:
 * приватность режет чужие строки в SQL, до LIMIT, поэтому ноль строк в ответе — это
 * ноль строк во всём диапазоне, а не «не поместилось». Если в таком случае оставить
 * курсор на месте, клиент встаёт намертво: каждый следующий pull перечитывает то же
 * невидимое окно, возвращает ноль, и всё, что придёт на сервер позже, до реплики уже
 * не доедет (лечилось только resetLocalDb).
 *
 * Прыгаем при этом на `serverLastSeq` — последний номер журнала (ledger_seq). С 2026-09
 * это единственный счётчик: дрейфа «индекс ушёл вперёд ledger'а» (GOTCHAS «seq drift»)
 * больше не бывает. Счётчик снят ДО запросов к таблицам, поэтому строку, записанную во
 * время сканирования, прыжок не проскочит — у неё seq больше.
 */
export function nextPullCursor(
  pageChanges: ReadonlyArray<Pick<ChangeRow, 'server_seq'>>,
  effectiveSince: number,
  serverLastSeq: number,
): number {
  const last = pageChanges.at(-1)?.server_seq;
  if (last != null) return last;
  return Math.max(effectiveSince, serverLastSeq);
}

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

// ── Main function ────────────────────────────────────────────────────

export async function pullChangesSince(
  since: number,
  actor: { id: string; role: string; username?: string },
  limit = 5000,
  opts?: { clientId?: string | null },
): Promise<SyncPullResponse> {
  const requestedLimit = Math.max(1, Math.min(20000, Number(limit) || 5000));

  // Журнал в PG — единственный источник номеров (ledger_seq + ledger_tx_index).
  const serverLastSeq = await getLedgerLastSeq();

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
    // Admin-only pull tables (audit_log) are never synced to non-admins. (H1-B)
    if (!isPullTableAllowedForRole(tableName, actorRole)) continue;
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

    // Work orders are NOT filtered at the sync boundary: every client holds the full
    // database and hides restricted orders at display time (see shared workOrderAccess).

    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

    const baseQuery = db
      .select()
      .from(pgTable)
      .orderBy('lastServerSeq' in pgTable ? asc(pgTable.lastServerSeq) : asc(pgTable.id));
    const filteredQuery = where ? baseQuery.where(where) : baseQuery;
    const rows = await filteredQuery.limit(safeLimit);

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
  const lastSeq = nextPullCursor(pageChanges, effectiveSince, serverLastSeq);

  return {
    sync_protocol_version: 2,
    sync_mode: 'incremental',
    server_cursor: lastSeq,
    server_last_seq: serverLastSeq,
    has_more: hasMore,
    changes: pageChanges,
  };
}
