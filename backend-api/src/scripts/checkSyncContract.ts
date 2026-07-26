import { LedgerTableName } from '@matricarmz/ledger';
import { SyncTableName, syncRowSchemaByTable } from '@matricarmz/shared';

import { assertSyncMapCoverage } from '../services/sync/syncChangeService.js';
import { checkReplicaStrictness } from './checkReplicaStrictness.js';

process.env.MATRICA_SYNC_GUARD = 'strict';

async function checkSyncContract() {
  const syncTables = Object.values(SyncTableName);
  const ledgerTables = new Set(Object.values(LedgerTableName));

  const missingLedger = syncTables.filter((t) => !ledgerTables.has(t));
  if (missingLedger.length > 0) {
    throw new Error(`SyncTableName не найдено в LedgerTableName: ${missingLedger.join(', ')}`);
  }

  const missingSchemas = syncTables.filter((t) => !syncRowSchemaByTable[t]);
  if (missingSchemas.length > 0) {
    throw new Error(`В syncRowSchemaByTable отсутствуют записи: ${missingSchemas.join(', ')}`);
  }

  assertSyncMapCoverage();

  const strictness = await checkReplicaStrictness();
  if (strictness.length > 0) {
    throw new Error(`клиентская реплика строже сервера (#086):\n- ${strictness.join('\n- ')}`);
  }
}

try {
  await checkSyncContract();
  console.log('проверка синхронизации контрактов выполнена');
} catch (e) {
  console.error(String(e));
  process.exit(1);
}
