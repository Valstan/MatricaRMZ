// Worker for the cross-process seq-allocation test. Spawned via
// `node --import tsx <this> <dir> <count> <tag>`. Each iteration goes through the
// real signAndAppend path (sign with this worker's keypair + append) so seq is
// allocated under the store lock — proving two processes never emit duplicate seqs.
import { LedgerStore, generateLedgerKeyPair, type LedgerTxPayload } from '@matricarmz/ledger';

const [dir, countRaw, tag] = process.argv.slice(2);
if (!dir || !countRaw || !tag) {
  throw new Error('usage: ledgerSeqWorker <dir> <count> <tag>');
}
const count = Number(countRaw);

const store = new LedgerStore(dir);
const keys = generateLedgerKeyPair();

for (let i = 0; i < count; i += 1) {
  const rowId = `${tag}-${i}`;
  const payload: LedgerTxPayload = {
    type: 'upsert',
    table: 'entities',
    row: { id: rowId },
    row_id: rowId,
    actor: { userId: 'sys', username: 'sys', role: 'sys' },
    ts: Date.now(),
  };
  store.signAndAppend([payload], keys.privateKeyPem, keys.publicKeyPem);
}
