import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  diffInventoryLines,
  engineInventoryLineId,
  type EngineInventoryLineRow,
  inventoryLineKeys,
  inventoryRawRowsFromPayload,
  inventoryRowsFromLines,
  lineFromInventoryRow,
  SyncTableName,
  SyncTableRegistry,
} from '@matricarmz/shared';

import { erpEngineInventoryLines } from '../database/schema.js';
import { collectChunked } from '../utils/sqlChunks.js';

/**
 * Строки списка деталей из реплики `erp_engine_inventory_lines` (E2.2, план
 * engine-inventory-lines-2026-09). Единственная точка, где читатели листа решают, откуда
 * брать строки: из строгой таблицы, если у листа там есть хоть одна живая строка, иначе —
 * из `answers.engine_inventory_items.rows` в `meta_json` (двигатели, которых бэкфилл не
 * коснулся, и офлайн-клиенты до первого pull).
 *
 * До E3 `meta_json` листа продолжает нести те же строки, что и таблица (серверный вывод
 * строк из листа + клиент пишет оба), поэтому оба источника обязаны давать один результат —
 * это держит сторож паритета `engineInventoryLinesReplica.guard.test.ts`. После E3 строки
 * живут только здесь, и потребитель, читающий `meta_json` мимо этого модуля, увидит пустой
 * список.
 */

let warned = false;
function warnOnce(message: string) {
  if (warned) return;
  warned = true;
  console.warn(`[engineInventoryLinesReplica] ${message}`);
}

/** Живые строки таблицы по листам, в порядке `sort_order`. Ключ — `operation_id`. */
export async function readInventoryLinesByOperations(
  db: BetterSQLite3Database,
  operationIds: readonly string[],
): Promise<Map<string, EngineInventoryLineRow[]>> {
  const out = new Map<string, EngineInventoryLineRow[]>();
  const ids = [...new Set(operationIds.map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  let rows: unknown[];
  try {
    rows = await collectChunked(ids, (chunk) =>
      db
        .select()
        .from(erpEngineInventoryLines)
        .where(and(inArray(erpEngineInventoryLines.operationId, chunk), isNull(erpEngineInventoryLines.deletedAt))),
    );
  } catch (e) {
    // Реплика недоступна (таблицы ещё нет на старой базе, битый файл) — читатель листа не
    // должен из-за этого падать: до E3 строки есть и в meta_json, fallback честный. После E3
    // это место обязано стать ошибкой, а не тишиной.
    warnOnce(`engine inventory lines replica unavailable, falling back to meta_json: ${String(e)}`);
    return out;
  }
  for (const r of rows as Array<Record<string, unknown>>) {
    const line = SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineInventoryLines, r) as unknown as EngineInventoryLineRow;
    const arr = out.get(line.operation_id) ?? [];
    arr.push(line);
    out.set(line.operation_id, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.sort_order - b.sort_order);
  return out;
}

/**
 * Raw-строки списка для каждого листа: из реплики, если она знает лист, иначе из payload.
 * `payload` — разобранный `meta_json` (может быть null/мусор — тогда fallback даёт `[]`).
 */
export async function readInventoryRowsForOperations(
  db: BetterSQLite3Database,
  ops: ReadonlyArray<{ id: string; payload: unknown }>,
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const lines = await readInventoryLinesByOperations(
    db,
    ops.map((o) => o.id),
  );
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const op of ops) {
    const fromReplica = lines.get(op.id);
    out.set(op.id, fromReplica && fromReplica.length > 0 ? inventoryRowsFromLines(fromReplica) : inventoryRawRowsFromPayload(op.payload));
  }
  return out;
}

/** Payload листа, чьи `answers.engine_inventory_items.rows` заменены строками из реплики
 * (если реплика знает лист). Остальные ответы листа не трогаются. */
export async function withReplicaInventoryRows<T>(db: BetterSQLite3Database, operationId: string, payload: T): Promise<T> {
  const lines = (await readInventoryLinesByOperations(db, [operationId])).get(operationId);
  if (!lines || lines.length === 0) return payload;
  return payloadWithInventoryRows(payload, inventoryRowsFromLines(lines));
}

export type InventoryLinesWriteResult = { insert: number; update: number; tombstone: number; unchanged: number };

/**
 * E2.3: строки листа — в реплику с `sync_status='pending'`, чтобы штатный push отвёз их
 * таблицей. Сверка с существующими строками — по `line_key` (`diffInventoryLines`): меняется
 * одна строка → одна pending-строка → одна транзакция в журнале, а не 130. Id строки —
 * `engineInventoryLineId` из shared, тот же, что считает сервер, выводя строки из `meta_json`:
 * иначе один лист породил бы два набора строк. Погашенные строки читаются тоже — вернувшаяся
 * строка оживает под прежним id.
 */
export async function writeInventoryLinesForSheet(
  db: BetterSQLite3Database,
  args: { operationId: string; engineId: string; payload: unknown; ts: number },
): Promise<InventoryLinesWriteResult> {
  const raw = inventoryRawRowsFromPayload(args.payload);
  const keys = inventoryLineKeys(raw);
  const desired = raw.map((row, i) =>
    lineFromInventoryRow(row, {
      id: engineInventoryLineId(args.operationId, keys[i]!),
      operationId: args.operationId,
      engineEntityId: args.engineId,
      lineKey: keys[i]!,
      sortOrder: i,
      createdAt: args.ts,
      updatedAt: args.ts,
    }),
  );
  const existingRows = await db
    .select()
    .from(erpEngineInventoryLines)
    .where(eq(erpEngineInventoryLines.operationId, args.operationId));
  const existing = (existingRows as Array<Record<string, unknown>>).map(
    (r) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineInventoryLines, r) as unknown as EngineInventoryLineRow,
  );
  const diff = diffInventoryLines(existing, desired, args.ts);

  const toDb = (line: EngineInventoryLineRow) =>
    SyncTableRegistry.toDbRow(SyncTableName.ErpEngineInventoryLines, { ...line, sync_status: 'pending' });
  if (diff.insert.length > 0) {
    await db.insert(erpEngineInventoryLines).values(diff.insert.map((l) => toDb(l) as any));
  }
  for (const line of [...diff.update, ...diff.tombstone]) {
    const { id: _id, createdAt: _c, lastServerSeq: _s, ...set } = toDb(line) as Record<string, unknown>;
    await db.update(erpEngineInventoryLines).set(set as any).where(eq(erpEngineInventoryLines.id, line.id));
  }
  return { insert: diff.insert.length, update: diff.update.length, tombstone: diff.tombstone.length, unchanged: diff.unchanged };
}

export function payloadWithInventoryRows<T>(payload: T, rows: Array<Record<string, unknown>>): T {
  if (!payload || typeof payload !== 'object') return payload;
  const p = payload as Record<string, unknown>;
  const answers = p.answers && typeof p.answers === 'object' ? (p.answers as Record<string, unknown>) : {};
  const table = answers.engine_inventory_items && typeof answers.engine_inventory_items === 'object'
    ? (answers.engine_inventory_items as Record<string, unknown>)
    : { kind: 'table' };
  return { ...p, answers: { ...answers, engine_inventory_items: { ...table, kind: 'table', rows } } } as T;
}
