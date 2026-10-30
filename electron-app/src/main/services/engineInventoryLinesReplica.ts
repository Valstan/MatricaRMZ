import { and, count, eq, gt, inArray, isNull, max, sql } from 'drizzle-orm';
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
 * E3 (план engine-inventory-lines-2026-09): `meta_json` листа несёт пустой список с
 * маркером `rowsIn`, те же строки — только здесь. Потребитель, читающий `meta_json`
 * мимо этого модуля, увидит пустой список. Fallback на `meta_json` остаётся честным и
 * после E3: у помеченного листа в JSON пусто (и это правда — строки в таблице), у
 * непомеченного JSON по-прежнему источник.
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
    // Реплика недоступна (битый файл и т.п.) — читатель листа не должен из-за этого
    // падать: fallback на meta_json честен и после E3 (у помеченного листа там пусто,
    // у непомеченного — строки).
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

/** Строка, нужная флагам акта: имя детали и три отметки. Больше из 30 колонок реплики
 * флагам не нужно (замер 29.10.2026: `select *` по всем листам — 2.1 с, эти пять колонок — 1.0 с). */
export type InventoryFlagRow = {
  partName: unknown;
  present: unknown;
  scrapQty: unknown;
  replaceQty: unknown;
};

function flagRowsFromPayload(payload: unknown): InventoryFlagRow[] {
  return inventoryRawRowsFromPayload(payload).map((r) => ({
    partName: r.part_name,
    present: r.present,
    scrapQty: r.scrap_qty,
    replaceQty: r.replace_qty,
  }));
}

/**
 * Строки, по которым считаются флаги акта: из реплики, если она знает лист, иначе из payload.
 * Тот же выбор источника, что у `readInventoryRowsForOperations`: разница в том, что из реплики
 * флаги приходят не построчно, а уже сведёнными по акту.
 *
 * Три флага акта — это три вопроса: «есть ли хоть одна деталь на месте», «есть ли хоть один
 * вердикт (утиль/замена)», «ушёл ли в утиль именно картер». Два первых — булевы, их считает
 * SQLite по покрывающему индексу `(operation_id, deleted_at, present, scrap_qty, replace_qty)`:
 * замер 30.10.2026 на копии боевой базы (382 тыс. строк) — 1.0 с на чтение пяти колонок
 * построчно против 0.06–0.08 с на агрегат. Имя детали нужно только третьему вопросу, и только
 * у строк с утилём (во всей базе таких 198 из 382 тыс.): их достаёт тот же индекс плюс чтение
 * строки — 0.02 с на те же акты. Отдельный частичный индекс под них пробовали: план его не
 * выбирает, выигрыша нет. Сравнение с «картер» остаётся в JS — SQLite без ICU не складывает
 * регистр кириллицы, а `instr(part_name, 'артер')` поймал бы «стартер» как картер.
 *
 * Наружу отдаётся та же форма строк, что и в payload, — синтезированные по акту строки
 * (`present: 1` / `scrapQty: 1`) плюс имена утильных деталей. Так правила флагов остаются
 * одной реализацией на два источника (`flagsFromInventoryRows`), а не двумя.
 */
export async function readInventoryFlagRowsForOperations(
  db: BetterSQLite3Database,
  ops: ReadonlyArray<{ id: string; payload: unknown }>,
  opts?: { onPhase?: (phase: string) => void },
): Promise<Map<string, InventoryFlagRow[]>> {
  const fromReplica = new Map<string, InventoryFlagRow[]>();
  const ids = [...new Set(ops.map((o) => String(o.id ?? '').trim()).filter(Boolean))];
  if (ids.length > 0) {
    let actRows: Array<{ operationId: unknown; act: unknown; defect: unknown }> = [];
    let crankRows: Array<{ operationId: unknown; partName: unknown }> = [];
    try {
      actRows = (await collectChunked(ids, (chunk) =>
        db
          .select({
            operationId: erpEngineInventoryLines.operationId,
            act: sql<number>`max(case when ${erpEngineInventoryLines.present} <> 0 then 1 else 0 end)`,
            defect: sql<number>`max(case when ${erpEngineInventoryLines.scrapQty} > 0 or ${erpEngineInventoryLines.replaceQty} > 0 then 1 else 0 end)`,
          })
          .from(erpEngineInventoryLines)
          .where(and(inArray(erpEngineInventoryLines.operationId, chunk), isNull(erpEngineInventoryLines.deletedAt)))
          .groupBy(erpEngineInventoryLines.operationId),
      )) as Array<{ operationId: unknown; act: unknown; defect: unknown }>;
      opts?.onPhase?.('agg');
      crankRows = (await collectChunked(ids, (chunk) =>
        db
          .select({
            operationId: erpEngineInventoryLines.operationId,
            partName: erpEngineInventoryLines.partName,
          })
          .from(erpEngineInventoryLines)
          .where(
            and(
              inArray(erpEngineInventoryLines.operationId, chunk),
              isNull(erpEngineInventoryLines.deletedAt),
              gt(erpEngineInventoryLines.scrapQty, 0),
            ),
          ),
      )) as Array<{ operationId: unknown; partName: unknown }>;
      opts?.onPhase?.('crank');
    } catch (e) {
      warnOnce(`engine inventory lines replica unavailable, falling back to meta_json: ${String(e)}`);
      actRows = [];
      crankRows = [];
    }
    for (const r of actRows) {
      const opId = String(r.operationId ?? '');
      const arr = fromReplica.get(opId) ?? [];
      arr.push({
        partName: undefined,
        present: Number(r.act ?? 0) !== 0 ? 1 : 0,
        scrapQty: Number(r.defect ?? 0) !== 0 ? 1 : 0,
        replaceQty: 0,
      });
      fromReplica.set(opId, arr);
    }
    for (const r of crankRows) {
      const opId = String(r.operationId ?? '');
      const arr = fromReplica.get(opId) ?? [];
      arr.push({ partName: r.partName, present: 0, scrapQty: 1, replaceQty: 0 });
      fromReplica.set(opId, arr);
    }
  }
  const out = new Map<string, InventoryFlagRow[]>();
  for (const op of ops) {
    const replica = fromReplica.get(op.id);
    out.set(op.id, replica && replica.length > 0 ? replica : flagRowsFromPayload(op.payload));
  }
  return out;
}

export type InventoryLinesWriteResult = { insert: number; update: number; tombstone: number; unchanged: number };

/**
 * Лёгкая версия строк по листам: число живых строк + max(updated_at). E3: строки таблицы
 * меняются, не трогая `operations.updated_at` (push строк и push листа — разные пачки),
 * поэтому кэш, ключующийся только штампом листа, после E3 врал бы. Пустая карта при
 * недоступной реплике — вызывающий считает строки неизменными (как fallback выше).
 */
export async function readInventoryLinesVersions(
  db: BetterSQLite3Database,
  operationIds: readonly string[],
): Promise<Map<string, { count: number; maxUpdatedAt: number }>> {
  const out = new Map<string, { count: number; maxUpdatedAt: number }>();
  const ids = [...new Set(operationIds.map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  let rows: Array<{ opId: unknown; n: unknown; m: unknown }>;
  try {
    rows = (await collectChunked(ids, (chunk) =>
      db
        .select({ opId: erpEngineInventoryLines.operationId, n: count(), m: max(erpEngineInventoryLines.updatedAt) })
        .from(erpEngineInventoryLines)
        .where(and(inArray(erpEngineInventoryLines.operationId, chunk), isNull(erpEngineInventoryLines.deletedAt)))
        .groupBy(erpEngineInventoryLines.operationId),
    )) as Array<{ opId: unknown; n: unknown; m: unknown }>;
  } catch (e) {
    warnOnce(`engine inventory lines versions unavailable: ${String(e)}`);
    return out;
  }
  for (const r of rows) {
    out.set(String(r.opId ?? ''), { count: Number(r.n ?? 0), maxUpdatedAt: Number(r.m ?? 0) });
  }
  return out;
}

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
