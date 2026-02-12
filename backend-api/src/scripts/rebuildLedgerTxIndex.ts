import 'dotenv/config';
import { sql } from 'drizzle-orm';

import { db } from '../database/db.js';
import { getLedgerLastSeq } from '../ledger/ledgerService.js';
import { rebuildLedgerTxIndexFromLedger } from '../services/sync/ledgerTxIndexService.js';

async function main() {
  const before = await db.execute(sql`select coalesce(max(server_seq), 0) as max_seq, count(*) as row_count from ledger_tx_index`);
  const beforeMax = Number((before.rows?.[0] as any)?.max_seq ?? 0);
  const beforeCount = Number((before.rows?.[0] as any)?.row_count ?? 0);
  const ledgerBefore = getLedgerLastSeq();
  console.log(
    JSON.stringify(
      {
        phase: 'before',
        ledgerLastSeq: ledgerBefore,
        indexMaxSeq: beforeMax,
        indexRowCount: beforeCount,
      },
      null,
      2,
    ),
  );

  const result = await rebuildLedgerTxIndexFromLedger();

  const after = await db.execute(sql`select coalesce(max(server_seq), 0) as max_seq, count(*) as row_count from ledger_tx_index`);
  const afterMax = Number((after.rows?.[0] as any)?.max_seq ?? 0);
  const afterCount = Number((after.rows?.[0] as any)?.row_count ?? 0);
  const ledgerAfter = getLedgerLastSeq();
  const ok = afterMax === ledgerAfter;
  console.log(
    JSON.stringify(
      {
        phase: 'after',
        ok,
        rebuild: result,
        ledgerLastSeq: ledgerAfter,
        indexMaxSeq: afterMax,
        indexRowCount: afterCount,
      },
      null,
      2,
    ),
  );
  if (!ok) {
    throw new Error(`ledger_tx_index is not aligned with ledger: indexMax=${afterMax}, ledgerLastSeq=${ledgerAfter}`);
  }
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
