import { sql } from 'drizzle-orm';

import { db } from '../../database/db.js';
import { ledgerTxIndex } from '../../database/schema.js';
import { getLedgerLastSeq, listChangesSince } from '../../ledger/ledgerService.js';

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractCreatedAt(payloadJson: string, fallback: number) {
  try {
    const parsed = JSON.parse(String(payloadJson ?? '')) as Record<string, unknown>;
    const updatedAt = toNumber(parsed?.updated_at);
    const createdAt = toNumber(parsed?.created_at);
    return updatedAt ?? createdAt ?? fallback;
  } catch {
    return fallback;
  }
}

export async function appendLedgerTxIndexFromLedger(startSeq: number, maxRows = 50_000) {
  const safeMaxRows = Math.max(1_000, Math.min(500_000, Number(maxRows) || 50_000));
  const pageSize = Math.max(1_000, Math.min(20_000, Number(process.env.MATRICA_SYNC_INDEX_PAGE_SIZE ?? 5_000)));
  let since = Math.max(0, Number(startSeq) || 0);
  let inserted = 0;
  let loops = 0;
  const startedAt = Date.now();
  while (inserted < safeMaxRows && loops < 10_000) {
    loops += 1;
    const pageLimit = Math.min(pageSize, safeMaxRows - inserted);
    const page = listChangesSince(since, pageLimit);
    if (!page.changes.length) break;
    const now = Date.now();
    const rows = page.changes.map((ch) => ({
      serverSeq: Number(ch.server_seq),
      tableName: String(ch.table),
      rowId: ch.row_id as any,
      op: ch.op,
      payloadJson: String(ch.payload_json ?? '{}'),
      createdAt: extractCreatedAt(String(ch.payload_json ?? '{}'), now),
    }));
    await db.insert(ledgerTxIndex).values(rows as any).onConflictDoNothing();
    inserted += rows.length;
    if (!page.hasMore || page.lastSeq <= since) {
      since = Math.max(since, page.lastSeq);
      break;
    }
    since = page.lastSeq;
  }
  return { inserted, lastSeq: since, elapsedMs: Date.now() - startedAt };
}

export async function rebuildLedgerTxIndexFromLedger() {
  const startedAt = Date.now();
  await db.execute(sql`delete from ledger_tx_index`);
  const ledgerLastSeq = getLedgerLastSeq();
  const result = await appendLedgerTxIndexFromLedger(0, Math.max(50_000, ledgerLastSeq + 10_000));
  return {
    ...result,
    ledgerLastSeq,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function ensureLedgerTxIndexUpToDate(maxCatchupRows = 20_000) {
  const indexRow = await db.execute(sql`select coalesce(max(server_seq), 0) as max_seq from ledger_tx_index`);
  const indexLastSeq = Number((indexRow.rows?.[0] as any)?.max_seq ?? 0);
  const ledgerLastSeq = getLedgerLastSeq();
  if (ledgerLastSeq <= indexLastSeq) {
    return { ok: true as const, indexLastSeq, ledgerLastSeq, inserted: 0 };
  }
  const appended = await appendLedgerTxIndexFromLedger(indexLastSeq, maxCatchupRows);
  return {
    ok: true as const,
    indexLastSeq,
    ledgerLastSeq,
    inserted: appended.inserted,
    lastSeq: appended.lastSeq,
    elapsedMs: appended.elapsedMs,
  };
}
