import { LedgerTableName } from '@matricarmz/ledger';
import { SyncTableName } from '@matricarmz/shared';
import { pool } from '../../database/db.js';
import { logError, logInfo } from '../../utils/logger.js';

const DEFAULT_SCHEMA = 'public';

function guardMode() {
  const raw = String(process.env.MATRICA_SYNC_GUARD ?? 'warn').toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'strict' || raw === 'hard') return 'strict';
  return 'warn';
}

function handleMismatch(message: string, tables: string[]) {
  const mode = guardMode();
  logError(message, { tables, mode }, { critical: true });
  if (mode === 'strict') {
    throw new Error(message);
  }
}

export async function ensureSyncSchemaGuard() {
  const mode = guardMode();
  if (mode === 'off') {
    logInfo('sync schema guard disabled via MATRICA_SYNC_GUARD', {}, { critical: true });
    return;
  }

  const syncTables = new Set(Object.values(SyncTableName));
  const ledgerTables = new Set(Object.values(LedgerTableName));

  const notInLedger = Array.from(syncTables).filter((t) => !ledgerTables.has(t));
  if (notInLedger.length > 0) {
    handleMismatch(`sync tables missing in LedgerTableName: ${notInLedger.join(', ')}`, notInLedger);
  }

  const res = await pool.query(
    `select distinct table_name
     from information_schema.columns
     where table_schema = $1 and column_name = any($2::text[])`,
    [DEFAULT_SCHEMA, ['sync_status', 'last_server_seq']],
  );
  const dbTables = new Set(res.rows.map((r) => String(r.table_name)));

  const missingInSyncList = Array.from(dbTables).filter((t) => !syncTables.has(t));
  if (missingInSyncList.length > 0) {
    handleMismatch(`db tables with sync columns are not in SyncTableName: ${missingInSyncList.join(', ')}`, missingInSyncList);
  }

  logInfo('sync schema guard ok', { tables: Array.from(syncTables).length, mode }, { critical: true });
}
