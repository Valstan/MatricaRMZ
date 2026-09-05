import { hashTxPayload, LedgerTableName, type LedgerSignedTx, type LedgerTxPayload } from '@matricarmz/ledger';
import { SyncTableRegistry, type SyncTableName } from '@matricarmz/shared';
import { sql } from 'drizzle-orm';

import { db } from '../database/db.js';
import { ledgerTxIndex, releaseRegistry } from '../database/schema.js';
import { PG_SYNC_TABLES } from '../services/sync/pgSyncTables.js';

/**
 * Журнал изменений в PostgreSQL (план docs/plans/ledger-journal-in-pg-2026-09.md).
 *
 * До 2026-09 здесь была цепочка блоков на диске: подпись, шифрование строк, проекция
 * state.json, чекпоинты. Клиенты её не читали (снапшот и инкремент идут из PG), а в пути
 * записи она стоила переписывания всей проекции на каждый блок (M79, M105) и гонок
 * писателей (M104). Решение владельца 05.09.2026: истина — PG, история — журнал в PG.
 *
 * Имена функций сохранены (signAndAppend*, getLedgerLastSeq, queryState) — это фасад,
 * через который пишут все сервисы и скрипты; семантика:
 *  - номер (seq) выдаёт SEQUENCE ledger_seq под advisory-lock одной константы на оба
 *    инстанса: порядок номеров = порядок записи, как давал файловый замок цепочки;
 *  - строка журнала несёт открытый текст payload СО штампом last_server_seq и актора;
 *  - `applied` = число записанных транзакций, `blockHeight` = 0 (поле оставлено в ответах
 *    ради формы контракта /ledger/tx/submit).
 */

// Один ключ на всю базу: писатели журнала сериализуются, как раньше замком .ledger.lock.
const LEDGER_LOCK_KEY = 7_311_2026;

export type LedgerAppendResult = { applied: number; lastSeq: number; blockHeight: number; signed: LedgerSignedTx[] };

function payloadRow(tx: LedgerSignedTx): Record<string, unknown> {
  if (tx.row) return { ...tx.row, last_server_seq: tx.seq };
  return {
    id: tx.row_id,
    deleted_at: tx.type === 'delete' ? tx.ts : null,
    updated_at: tx.ts,
    last_server_seq: tx.seq,
  };
}

function rowIdOf(tx: LedgerTxPayload): string {
  return String((tx.row as Record<string, unknown> | undefined)?.id ?? tx.row_id ?? '');
}

export async function signAndAppendDetailed(payloads: LedgerTxPayload[]): Promise<LedgerAppendResult> {
  if (payloads.length === 0) return { applied: 0, lastSeq: await getLedgerLastSeq(), blockHeight: 0, signed: [] };
  for (const p of payloads) {
    if (!rowIdOf(p)) throw new Error(`ledger_tx_without_row_id: ${String(p.table)}`);
  }
  const now = Date.now();
  const signed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`);
    const seqRes = await tx.execute(sql`select nextval('ledger_seq')::bigint as seq from generate_series(1, ${payloads.length})`);
    const seqs = (seqRes.rows as Array<{ seq: unknown }>).map((r) => Number(r.seq));
    if (seqs.length !== payloads.length || seqs.some((n) => !Number.isFinite(n) || n <= 0)) {
      throw new Error('ledger_seq_allocation_failed');
    }
    const out: LedgerSignedTx[] = payloads.map((p, i) => ({ ...p, seq: seqs[i]!, tx_id: hashTxPayload(p) }));
    await tx.insert(ledgerTxIndex).values(
      out.map((t) => ({
        serverSeq: t.seq,
        tableName: String(t.table),
        rowId: rowIdOf(t) as any,
        op: t.type === 'delete' ? 'delete' : 'upsert',
        payloadJson: JSON.stringify(payloadRow(t)),
        createdAt: Number.isFinite(Number(t.ts)) && Number(t.ts) > 0 ? Number(t.ts) : now,
        actorUserId: t.actor?.userId ?? null,
        actorUsername: t.actor?.username ?? null,
      })),
    );
    return out;
  });
  return { applied: signed.length, lastSeq: signed.at(-1)?.seq ?? 0, blockHeight: 0, signed };
}

export async function signAndAppend(payloads: LedgerTxPayload[]): Promise<{ applied: number; lastSeq: number; blockHeight: number }> {
  const r = await signAndAppendDetailed(payloads);
  return { applied: r.applied, lastSeq: r.lastSeq, blockHeight: r.blockHeight };
}

/** Последний выданный номер журнала. Берётся и из последовательности, и из таблицы:
 * откатившаяся транзакция оставляет дыру в номерах, но не может понизить максимум. */
export async function getLedgerLastSeq(): Promise<number> {
  const r = await db.execute(
    sql`select greatest((select last_value from ledger_seq), (select coalesce(max(server_seq), 0) from ledger_tx_index))::bigint as seq`,
  );
  return Number((r.rows?.[0] as { seq?: unknown } | undefined)?.seq ?? 0) || 0;
}

function releaseRegistryRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(r.id),
    version: r.version,
    notes: r.notes ?? null,
    sha256: r.sha256 ?? null,
    file_name: r.fileName ?? null,
    size: r.size == null ? null : Number(r.size),
    payload_json: r.payloadJson ?? null,
    created_at: Number(r.createdAt),
    created_by_user_id: r.createdByUserId ?? null,
    created_by_username: r.createdByUsername ?? null,
    updated_at: Number(r.updatedAt),
    deleted_at: r.deletedAt == null ? null : Number(r.deletedAt),
  };
}

async function loadTableRows(table: LedgerTableName): Promise<Array<Record<string, unknown>>> {
  if (table === LedgerTableName.ReleaseRegistry) {
    const rows = await db.select().from(releaseRegistry);
    return (rows as Array<Record<string, unknown>>).map(releaseRegistryRow);
  }
  const entry = PG_SYNC_TABLES[table as string];
  if (!entry) return [];
  const rows = await db.select().from(entry.drizzle);
  return (rows as Array<Record<string, unknown>>).map((r) => entry.toSyncRow(r));
}

export type QueryStateOptions = {
  id?: string;
  filter?: Record<string, string>;
  orFilter?: Array<Record<string, string>>;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  includeDeleted?: boolean;
  dateField?: string;
  dateFrom?: number;
  dateTo?: number;
  likeField?: string;
  like?: string;
  regexField?: string;
  regex?: string;
  regexFlags?: string;
  cursorValue?: string | number;
  cursorId?: string;
};

/**
 * Чтение таблицы в DTO-форме синка с фильтрами/сортировкой/курсором — прежний контракт
 * /ledger/state/query и диагностики, теперь поверх PG (sync-таблицы — той же картой, что
 * снапшот; release_registry — своя таблица; прочие имена журнала данных не имеют).
 */
export async function queryState(table: LedgerTableName, opts: QueryStateOptions): Promise<Array<Record<string, unknown>>> {
  const list = await loadTableRows(table);
  if (opts.id) return list.filter((row) => String(row.id ?? '') === String(opts.id));
  let filtered = list;
  if (opts.filter) {
    filtered = filtered.filter((row) => Object.entries(opts.filter ?? {}).every(([k, v]) => String(row[k] ?? '') === String(v)));
  }
  if (opts.orFilter && opts.orFilter.length > 0) {
    const clauses = opts.orFilter.filter((c) => c && Object.keys(c).length > 0);
    if (clauses.length > 0) {
      filtered = filtered.filter((row) => clauses.some((clause) => Object.entries(clause).every(([k, v]) => String(row[k] ?? '') === String(v))));
    }
  }
  if (opts.like && opts.likeField) {
    const needle = String(opts.like).toLowerCase();
    const field = String(opts.likeField);
    filtered = filtered.filter((row) => String(row[field] ?? '').toLowerCase().includes(needle));
  }
  if (opts.regex && opts.regexField) {
    try {
      const field = String(opts.regexField);
      const re = new RegExp(String(opts.regex), opts.regexFlags ? String(opts.regexFlags) : 'i');
      filtered = filtered.filter((row) => re.test(String(row[field] ?? '')));
    } catch {
      // невалидный regex — как и раньше, фильтр не применяется
    }
  }
  if (opts.dateFrom != null || opts.dateTo != null) {
    const field = opts.dateField ?? 'created_at';
    const from = opts.dateFrom != null ? Number(opts.dateFrom) : null;
    const to = opts.dateTo != null ? Number(opts.dateTo) : null;
    filtered = filtered.filter((row) => {
      const value = Number(row[field]);
      if (!Number.isFinite(value)) return false;
      if (from != null && value < from) return false;
      if (to != null && value > to) return false;
      return true;
    });
  }
  if (!opts.includeDeleted) filtered = filtered.filter((row) => row.deleted_at == null);
  if (opts.sortBy) {
    const dir = opts.sortDir === 'asc' ? 1 : -1;
    const keyName = opts.sortBy;
    filtered = [...filtered].sort((a, b) => {
      const av = a[keyName] as string | number | null | undefined;
      const bv = b[keyName] as string | number | null | undefined;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }
  if (opts.cursorValue != null && opts.sortBy) {
    const dir = opts.sortDir === 'asc' ? 1 : -1;
    const cursorVal = opts.cursorValue;
    const cursorId = opts.cursorId ? String(opts.cursorId) : null;
    const keyName = opts.sortBy;
    filtered = filtered.filter((row) => {
      const value = row[keyName] as string | number | null | undefined;
      const rowId = String(row.id ?? '');
      if (value == null) return false;
      if (value === cursorVal) return cursorId ? (dir === 1 ? rowId > cursorId : rowId < cursorId) : false;
      return dir === 1 ? value > cursorVal : value < cursorVal;
    });
  }
  const offset = Math.max(0, Number(opts.offset ?? 0));
  const limit = Math.max(1, Math.min(20000, Number(opts.limit ?? 5000)));
  return filtered.slice(offset, offset + limit);
}

/** Имя sync-таблицы → имя журнала (одно и то же значение; оставлено ради читаемости вызовов). */
export function ledgerTableOf(table: SyncTableName): LedgerTableName {
  return SyncTableRegistry.toLedgerName(table) as LedgerTableName;
}
