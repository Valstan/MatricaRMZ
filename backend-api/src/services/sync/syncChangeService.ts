import { LedgerTableName, type LedgerSignedTx, type LedgerTxPayload } from '@matricarmz/ledger';
import { SyncTableName } from '@matricarmz/shared';
import { inArray, sql } from 'drizzle-orm';

import { db } from '../../database/db.js';
import {
  attributeDefs,
  attributeValues,
  auditLog,
  changeLog,
  chatMessages,
  chatReads,
  entities,
  entityTypes,
  noteShares,
  notes,
  operations,
  userPresence,
} from '../../database/schema.js';
import { signAndAppendDetailed } from '../../ledger/ledgerService.js';

type SyncActor = { id: string; username: string; role?: string };

export type SyncChange = {
  tableName: SyncTableName;
  rowId: string;
  op: 'upsert' | 'delete';
  payload: Record<string, unknown>;
  ts?: number;
};

export type SyncChangeJson = {
  tableName: SyncTableName;
  rowId: string;
  op: 'upsert' | 'delete';
  payloadJson: string;
};

const TABLE_MAP: Record<SyncTableName, LedgerTableName> = {
  [SyncTableName.EntityTypes]: LedgerTableName.EntityTypes,
  [SyncTableName.Entities]: LedgerTableName.Entities,
  [SyncTableName.AttributeDefs]: LedgerTableName.AttributeDefs,
  [SyncTableName.AttributeValues]: LedgerTableName.AttributeValues,
  [SyncTableName.Operations]: LedgerTableName.Operations,
  [SyncTableName.AuditLog]: LedgerTableName.AuditLog,
  [SyncTableName.ChatMessages]: LedgerTableName.ChatMessages,
  [SyncTableName.ChatReads]: LedgerTableName.ChatReads,
  [SyncTableName.UserPresence]: LedgerTableName.UserPresence,
  [SyncTableName.Notes]: LedgerTableName.Notes,
  [SyncTableName.NoteShares]: LedgerTableName.NoteShares,
};

const SYNC_TABLES: Record<SyncTableName, any> = {
  [SyncTableName.EntityTypes]: entityTypes,
  [SyncTableName.Entities]: entities,
  [SyncTableName.AttributeDefs]: attributeDefs,
  [SyncTableName.AttributeValues]: attributeValues,
  [SyncTableName.Operations]: operations,
  [SyncTableName.AuditLog]: auditLog,
  [SyncTableName.ChatMessages]: chatMessages,
  [SyncTableName.ChatReads]: chatReads,
  [SyncTableName.UserPresence]: userPresence,
  [SyncTableName.Notes]: notes,
  [SyncTableName.NoteShares]: noteShares,
};

function guardMode() {
  const raw = String(process.env.MATRICA_SYNC_GUARD ?? 'warn').toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'strict' || raw === 'hard') return 'strict';
  return 'warn';
}

export function assertSyncMapCoverage() {
  const mode = guardMode();
  if (mode === 'off') return;
  const syncValues = Object.values(SyncTableName);
  const missingTableMap = syncValues.filter((t) => !TABLE_MAP[t as SyncTableName]);
  const missingSyncTables = syncValues.filter((t) => !SYNC_TABLES[t as SyncTableName]);
  const problems = [...missingTableMap, ...missingSyncTables];
  if (problems.length === 0) return;
  const msg = `syncChangeService missing mappings for: ${problems.join(', ')}`;
  // eslint-disable-next-line no-console
  console.error(msg);
  if (mode === 'strict') throw new Error(msg);
}

assertSyncMapCoverage();

function payloadTs(payload: Record<string, unknown>, fallback: number) {
  const value = Number((payload as any)?.updated_at ?? (payload as any)?.created_at ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

export async function recordSyncChanges(actor: SyncActor, changes: SyncChange[]) {
  if (!changes.length) return;
  const now = Date.now();
  const rows = changes.map((ch) => ({
    tableName: ch.tableName,
    rowId: ch.rowId as any,
    op: ch.op,
    payloadJson: JSON.stringify(ch.payload),
    createdAt: ch.ts ?? now,
  }));
  await db.insert(changeLog).values(rows);

  const payloads: LedgerTxPayload[] = changes.map((ch) => ({
    type: ch.op === 'delete' ? 'delete' : 'upsert',
    table: TABLE_MAP[ch.tableName],
    row: ch.payload,
    row_id: ch.rowId,
    actor: { userId: actor.id, username: actor.username, role: actor.role ?? 'user' },
    ts: payloadTs(ch.payload, ch.ts ?? now),
  }));
  const ledgerResult = signAndAppendDetailed(payloads);
  await applyLedgerSeqToRows(changes, ledgerResult.signed);
}

export function appendLedgerChanges(actor: SyncActor, changes: SyncChangeJson[]) {
  if (!changes.length) return { applied: 0, lastSeq: 0, blockHeight: 0 };
  const now = Date.now();
  const payloads: LedgerTxPayload[] = [];

  for (const ch of changes) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ch.payloadJson) as Record<string, unknown>;
    } catch {
      continue;
    }
    payloads.push({
      type: ch.op === 'delete' ? 'delete' : 'upsert',
      table: TABLE_MAP[ch.tableName],
      row: payload,
      row_id: ch.rowId,
      actor: { userId: actor.id, username: actor.username, role: actor.role ?? 'user' },
      ts: payloadTs(payload, now),
    });
  }

  if (payloads.length === 0) return { applied: 0, lastSeq: 0, blockHeight: 0 };
  return signAndAppendDetailed(payloads);
}

function buildLedgerSeqMap(signed: LedgerSignedTx[]) {
  const map = new Map<string, number>();
  for (const tx of signed) {
    const rowId = String((tx.row as any)?.id ?? tx.row_id ?? '');
    if (!rowId) continue;
    const key = `${String(tx.table)}:${rowId}`;
    const prev = map.get(key) ?? 0;
    const next = Number(tx.seq ?? 0);
    if (next > prev) map.set(key, next);
  }
  return map;
}

async function applyLedgerSeqToRows(changes: SyncChange[], signed: LedgerSignedTx[]) {
  if (!changes.length || signed.length === 0) return;
  const seqByKey = buildLedgerSeqMap(signed);
  const byTable = new Map<SyncTableName, Array<{ rowId: string; serverSeq: number }>>();

  for (const ch of changes) {
    const key = `${String(TABLE_MAP[ch.tableName])}:${String(ch.rowId)}`;
    const serverSeq = seqByKey.get(key);
    if (!serverSeq) continue;
    const list = byTable.get(ch.tableName) ?? [];
    list.push({ rowId: String(ch.rowId), serverSeq });
    byTable.set(ch.tableName, list);
  }

  for (const [tableName, pairs] of byTable.entries()) {
    if (pairs.length === 0) continue;
    const table = SYNC_TABLES[tableName];
    if (!table?.id || !table?.lastServerSeq) continue;
    const ids = pairs.map((p) => p.rowId);
    const cases = sql.join(
      pairs.map((p) => sql`when ${table.id} = ${p.rowId} then ${Number(p.serverSeq)}::bigint`),
      sql.raw(' '),
    );
    const caseExpr = sql`case ${cases} end`;
    await db.update(table).set({ lastServerSeq: caseExpr }).where(inArray(table.id, ids as any));
  }
}
