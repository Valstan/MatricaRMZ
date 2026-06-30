import { LedgerTableName } from '@matricarmz/ledger';
import { SyncTableName, syncRowSchemaByTable } from '@matricarmz/shared';

import { assertSyncMapCoverage } from '../services/sync/syncChangeService.js';

process.env.MATRICA_SYNC_GUARD = 'strict';

function checkSyncContract() {
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
}

try {
  checkSyncContract();
  console.log('проверка синхронизации контрактов выполнена');
} catch (e) {
  console.error(String(e));
  process.exit(1);
}
