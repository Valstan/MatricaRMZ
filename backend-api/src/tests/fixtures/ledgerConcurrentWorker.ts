// Standalone worker for the cross-process LedgerStore race test. Spawned via
// `node --import tsx <this> <dir> <count> <tag>`. Appends `count` blocks, each
// carrying one upsert with a tag-unique row id, into the shared ledger dir.
// Not a *.test.ts file, so vitest does not pick it up as a suite.
import { LedgerStore, type LedgerSignedTx } from '@matricarmz/ledger';

const [dir, countRaw, tag] = process.argv.slice(2);
if (!dir || !countRaw || !tag) {
  throw new Error('usage: ledgerConcurrentWorker <dir> <count> <tag>');
}
const count = Number(countRaw);

const store = new LedgerStore(dir);

for (let i = 0; i < count; i += 1) {
  const ts = Date.now();
  const rowId = `${tag}-${i}`;
  const tx: LedgerSignedTx = {
    type: 'upsert',
    table: 'entities',
    row: { id: rowId },
    row_id: rowId,
    actor: { userId: 'sys', username: 'sys', role: 'sys' },
    ts,
    seq: 0,
    tx_id: `${tag}-${i}-${ts}-${process.pid}`,
    signature: '',
    public_key: '',
  };
  store.appendBlock([tx]);
}
