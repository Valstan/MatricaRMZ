import { LedgerTableName } from '@matricarmz/ledger';
import { SyncTableName } from '@matricarmz/shared';
import { pool } from '../../database/db.js';
import { logError, logInfo } from '../../utils/logger.js';

const DEFAULT_SCHEMA = 'public';

/**
 * Таблицы, которые НАМЕРЕННО несут колонки транспорта синка (`sync_status`,
 * `last_server_seq`), но в sync-контракт ещё не входят.
 *
 * Колонки заводятся вместе с таблицей (B3/R1, миграция 0086), потому что
 * добавить их позже на живой таблице дороже, чем сразу; вход в контракт —
 * отдельный шаг R3 с правкой реестра, DTO, ledger-enum и ОБЕИХ клиентских
 * цепочек миграций. Без этого списка сторож писал ERROR на каждом старте
 * бэкенда о состоянии, которое запланировано, — а сторож, который регулярно
 * кричит на ожидаемое, перестают читать. Ровно так гейт становится
 * декоративным.
 *
 * Список обязан оставаться узким и временным: как только таблица войдёт в
 * SyncTableName, запись отсюда надо убрать — за этим следит проверка ниже.
 */
export const SYNC_COLUMNS_PENDING_CONTRACT: Readonly<Record<string, string>> = {
  users: 'B3/R3 — аккаунты входят в контракт вместе с user_section_access',
  user_section_access: 'B3/R3 — вместе с users',
};

function guardMode() {
  const raw = String(process.env.MATRICA_SYNC_GUARD ?? 'warn').toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'strict' || raw === 'hard') return 'strict';
  return 'warn';
}

function handleMismatch(message: string, tables: string[]) {
  const mode = guardMode();
  logError(message, { tables, mode });
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

  const syncTables = new Set<string>(Object.values(SyncTableName) as string[]);
  const ledgerTables = new Set<string>(Object.values(LedgerTableName) as string[]);

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

  // Протухшая запись списка ожидания: таблица уже в контракте, а её всё ещё
  // числят «войдёт позже». Молчаливое исключение из сторожа — худший вид дыры.
  const staleWaivers = Object.keys(SYNC_COLUMNS_PENDING_CONTRACT).filter((t) => syncTables.has(t));
  if (staleWaivers.length > 0) {
    handleMismatch(
      `таблицы уже в SyncTableName, но числятся ожидающими контракта — убрать из SYNC_COLUMNS_PENDING_CONTRACT: ${staleWaivers.join(', ')}`,
      staleWaivers,
    );
  }

  const pending = Array.from(dbTables).filter((t) => t in SYNC_COLUMNS_PENDING_CONTRACT);
  const missingInSyncList = Array.from(dbTables).filter((t) => !syncTables.has(t) && !(t in SYNC_COLUMNS_PENDING_CONTRACT));
  if (missingInSyncList.length > 0) {
    handleMismatch(`db tables with sync columns are not in SyncTableName: ${missingInSyncList.join(', ')}`, missingInSyncList);
  }
  if (pending.length > 0) {
    // Info, а не error: состояние запланировано и описано. Но видимым остаётся —
    // иначе список ожидания превратится в свалку, о которой все забыли.
    logInfo('sync-колонки заведены заранее, контракт по плану позже', {
      tables: pending.map((t) => `${t}: ${SYNC_COLUMNS_PENDING_CONTRACT[t]}`),
    });
  }

  logInfo('sync schema guard ok', { tables: Array.from(syncTables).length, mode }, { critical: true });
}
