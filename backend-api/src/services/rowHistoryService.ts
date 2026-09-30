import { and, asc, eq } from 'drizzle-orm';

import { db } from '../database/db.js';
import { ledgerTxIndex } from '../database/schema.js';

// H1: история правок одного объекта из журнала (`ledger_tx_index`). Каждая запись журнала
// несёт полный payload строки на момент версии + актора + штамп, поэтому история — это
// выборка по (table_name, row_id) по возрастанию seq. Интерфейс (показ) — блок H2;
// здесь только механизм чтения.

export type RowHistoryVersion = {
  seq: number;
  op: string;
  ts: number;
  actor_user_id: string | null;
  actor_username: string | null;
  /** Ключи верхнего уровня, изменившиеся относительно предыдущей версии (первая — все ключи). */
  changed_keys: string[];
  row: unknown;
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Ключи, чьё JSON-значение различается. Порядок — по второй версии, стабилен. */
export function versionChangedKeys(prev: unknown, next: unknown): string[] {
  if (!prev || typeof prev !== 'object' || !next || typeof next !== 'object') return [];
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(n)) {
    if (JSON.stringify(p[k]) !== JSON.stringify(n[k])) out.push(k);
  }
  return out;
}

export async function listRowHistory(
  tableName: string,
  rowId: string,
  limit: number,
): Promise<RowHistoryVersion[]> {
  const rows = (await db
    .select()
    .from(ledgerTxIndex)
    .where(and(eq(ledgerTxIndex.tableName, tableName), eq(ledgerTxIndex.rowId, rowId as any)))
    .orderBy(asc(ledgerTxIndex.serverSeq))
    .limit(Math.max(1, Math.min(200, Math.trunc(limit) || 50)))) as any[];
  let prev: unknown = null;
  return rows.map((r) => {
    const row = safeParse(String(r.payloadJson ?? 'null'));
    const changed = prev === null ? (row && typeof row === 'object' ? Object.keys(row) : []) : versionChangedKeys(prev, row);
    prev = row;
    return {
      seq: Number(r.serverSeq ?? 0),
      op: String(r.op ?? ''),
      ts: Number(r.createdAt ?? 0),
      actor_user_id: r.actorUserId == null ? null : String(r.actorUserId),
      actor_username: r.actorUsername == null ? null : String(r.actorUsername),
      changed_keys: changed,
      row,
    };
  });
}
