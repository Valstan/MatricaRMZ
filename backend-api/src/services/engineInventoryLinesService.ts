import { eq, inArray } from 'drizzle-orm';

import {
  ENGINE_INVENTORY_STAGE,
  SyncTableName,
  SyncTableRegistry,
  diffInventoryLines,
  engineInventoryLineId,
  inventoryLineKeys,
  inventoryRawRowsFromPayload,
  inventoryRowsLocation,
  lineFromInventoryRow,
  type EngineInventoryLineRow,
} from '@matricarmz/shared';

import { db } from '../database/db.js';
import { erpEngineInventoryLines } from '../database/schema.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from './sync/syncWriteService.js';

/**
 * Вывод строк `erp_engine_inventory_lines` из листа `operations(engine_inventory)`.
 *
 * E3 плана engine-inventory-lines-2026-09: клиенты шлют строки только таблицей, а в
 * `meta_json` лежит пустой список с маркером `rowsIn` — такие листы вывод пропускает.
 * Из JSON выводятся только непомеченные листы (старые сборки, web-admin, импорты):
 * после каждой записи листа (push с клиента, web-admin, скрипты — все идут через
 * writeSyncChanges) лист сверяется с таблицей по `line_key`, и в ledger уходят ТОЛЬКО
 * изменившиеся строки. Тот же код гоняет разовый бэкфилл (`engine-inventory:backfill-lines`).
 *
 * Чистая половина — `planEngineInventoryLines` (под тестом), запись — `deriveEngineInventoryLines`.
 */

// id строки — `engineInventoryLineId` из shared (с 21.09 одна функция на сервер и клиент:
// клиент пишет строки сам, E2.3). Реэкспорт — ради прежних импортов и теста.
export { engineInventoryLineId };

export type InventoryOperationRow = {
  id: string;
  engine_entity_id: string;
  operation_type: string;
  meta_json: string | null;
  deleted_at?: number | null;
};

export type LinesPlan = {
  operationId: string;
  inputs: SyncWriteInput[];
  insert: number;
  update: number;
  tombstone: number;
  unchanged: number;
  /** Лист не engine_inventory или без таблицы строк — строк не выводим, но и не гасим. */
  skipped: boolean;
  /**
   * E3: лист помечен «строки в таблице» — вывод из JSON пропущен, источник строк только
   * прямой push таблицы. Пустой `rows` у помеченного листа — норма, а не «список стёрли».
   */
  skippedMarked: boolean;
  /**
   * E3-сторож отставших сборок: пустой `rows` без маркера при живых строках в таблице —
   * слепой клиент сохранил увиденный пустым список. Строки не гасим, ждём прямого push.
   * Осознанно пустой список новый клиент выражает тумстоунами строк, а не пустым JSON.
   */
  skippedEmptyGuard: boolean;
};

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Помеченный лист с НЕпустым списком в JSON — писал слепой писатель (старый клиент,
 * сохранивший маркер, или web-admin): строкам таблицы неоткуда взяться, кроме этого
 * JSON, поэтому вывод разрешён. E3-клиент пустые списки шлёт всегда, непустые — никогда.
 */
function hasNonEmptyRows(payload: Record<string, unknown>): boolean {
  const answers = payload.answers as Record<string, unknown> | undefined;
  const table = answers?.engine_inventory_items as { rows?: unknown } | undefined;
  return !!table && Array.isArray(table.rows) && table.rows.length > 0;
}

/**
 * План записи для одного листа. Удалённый лист гасит все свои живые строки; лист без
 * секции строк (payload не repair_checklist, нет таблицы) пропускается — пустой список
 * от поломанного payload не должен стереть 130 строк. E3 добавляет два пропуска:
 * помеченный лист (строки едут таблицей) и пустой JSON при живых строках (слепой клиент).
 */
export function planEngineInventoryLines(
  op: InventoryOperationRow,
  existing: ReadonlyArray<EngineInventoryLineRow>,
  ts: number,
): LinesPlan {
  const empty: LinesPlan = { operationId: op.id, inputs: [], insert: 0, update: 0, tombstone: 0, unchanged: 0, skipped: false, skippedMarked: false, skippedEmptyGuard: false };
  if (op.operation_type !== ENGINE_INVENTORY_STAGE) return { ...empty, skipped: true };

  let desired: EngineInventoryLineRow[];
  if (op.deleted_at) {
    desired = [];
  } else {
    const payload = safeParse(op.meta_json) as Record<string, unknown> | null;
    if (!payload || payload.kind !== 'repair_checklist') return { ...empty, skipped: true };
    if (inventoryRowsLocation(payload) === 'table' && !hasNonEmptyRows(payload)) {
      return { ...empty, skippedMarked: true };
    }
    const table = (payload.answers as Record<string, unknown> | undefined)?.engine_inventory_items as { rows?: unknown } | undefined;
    if (!table || !Array.isArray(table.rows)) return { ...empty, skipped: true };
    if (table.rows.length === 0 && existing.some((l) => l.deleted_at == null)) {
      return { ...empty, skippedEmptyGuard: true };
    }
    const raw = inventoryRawRowsFromPayload(payload);
    const keys = inventoryLineKeys(raw);
    desired = raw.map((row, i) =>
      lineFromInventoryRow(row, {
        id: engineInventoryLineId(op.id, keys[i]!),
        operationId: op.id,
        engineEntityId: op.engine_entity_id,
        lineKey: keys[i]!,
        sortOrder: i,
        createdAt: ts,
        updatedAt: ts,
      }),
    );
  }

  const diff = diffInventoryLines(existing, desired, ts);
  const toInput = (row: EngineInventoryLineRow): SyncWriteInput => ({
    type: row.deleted_at ? 'delete' : 'upsert',
    table: SyncTableName.ErpEngineInventoryLines,
    row: { ...row, sync_status: 'synced' },
    row_id: row.id,
  });
  return {
    operationId: op.id,
    inputs: [...diff.insert, ...diff.update, ...diff.tombstone].map(toInput),
    insert: diff.insert.length,
    update: diff.update.length,
    tombstone: diff.tombstone.length,
    unchanged: diff.unchanged,
    skipped: false,
    skippedMarked: false,
    skippedEmptyGuard: false,
  };
}

export async function readExistingLines(operationIds: string[]): Promise<Map<string, EngineInventoryLineRow[]>> {
  const out = new Map<string, EngineInventoryLineRow[]>();
  if (operationIds.length === 0) return out;
  const rows = await db
    .select()
    .from(erpEngineInventoryLines)
    .where(inArray(erpEngineInventoryLines.operationId, operationIds as any));
  for (const r of rows as any[]) {
    const dto = SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineInventoryLines, r) as EngineInventoryLineRow;
    const arr = out.get(dto.operation_id) ?? [];
    arr.push(dto);
    out.set(dto.operation_id, arr);
  }
  return out;
}

export type DeriveResult = { operations: number; insert: number; update: number; tombstone: number; unchanged: number; skipped: number; skippedMarked: number; skippedEmptyGuard: number };

/**
 * G4: выбор выжившего среди дублей листов одного двигателя. Живым считается лист,
 * который показывает клиент — самый свежий по `updated_at` (`getRepairChecklistForEngine`
 * берёт первый по `updated_at desc`); остальные — кандидаты на мягкое удаление.
 * Ничья по штампу решается детерминированно по id (клиентский порядок при равенстве
 * не определён, но второй такой лист — уже баг, а не выбор).
 */
export type SheetDedupeHead = {
  id: string;
  engine_entity_id: string;
  created_at: number;
  updated_at: number;
  /** Строк в JSON листа (сколько спрячется при удалении, если их нет в таблице). */
  json_rows: number;
  /** Живых строк таблицы у листа (удаление листа гасит и их — через вывод). */
  live_lines: number;
};

export type SheetDedupePlan = { engine_entity_id: string; keep_id: string; delete_ids: string[] };

export function pickSheetDedupeSurvivors(heads: ReadonlyArray<SheetDedupeHead>): SheetDedupePlan[] {
  const byEngine = new Map<string, SheetDedupeHead[]>();
  for (const h of heads) {
    const arr = byEngine.get(h.engine_entity_id) ?? [];
    arr.push(h);
    byEngine.set(h.engine_entity_id, arr);
  }
  const out: SheetDedupePlan[] = [];
  for (const [engineId, group] of byEngine) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    out.push({ engine_entity_id: engineId, keep_id: sorted[0]!.id, delete_ids: sorted.slice(1).map((s) => s.id) });
  }
  return out;
}

/**
 * Вывести строки для набора листов и записать разницу через writeSyncChanges (ledger →
 * index → PG, как любая серверная запись). Пачка на один вызов ограничена, чтобы блок
 * ledger'а не раздувался: один лист — до 659 строк, бэкфилл — сотни тысяч.
 */
export async function deriveEngineInventoryLines(
  ops: InventoryOperationRow[],
  actor: SyncWriteActor,
  opts: { batchRows?: number; dryRun?: boolean; ts?: number } = {},
): Promise<DeriveResult> {
  const result: DeriveResult = { operations: 0, insert: 0, update: 0, tombstone: 0, unchanged: 0, skipped: 0, skippedMarked: 0, skippedEmptyGuard: 0 };
  const inventoryOps = ops.filter((o) => o.operation_type === ENGINE_INVENTORY_STAGE);
  if (inventoryOps.length === 0) return result;
  const ts = opts.ts ?? Date.now();
  const batchRows = Math.max(1, opts.batchRows ?? 1000);
  const existing = await readExistingLines(inventoryOps.map((o) => o.id));

  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (!opts.dryRun) await writeSyncChanges(pending, actor, { allowSyncConflicts: true });
    pending = [];
  };
  for (const op of inventoryOps) {
    const plan = planEngineInventoryLines(op, existing.get(op.id) ?? [], ts);
    if (plan.skipped || plan.skippedMarked || plan.skippedEmptyGuard) {
      result.skipped += 1;
      if (plan.skippedMarked) result.skippedMarked += 1;
      if (plan.skippedEmptyGuard) result.skippedEmptyGuard += 1;
      continue;
    }
    result.operations += 1;
    result.insert += plan.insert;
    result.update += plan.update;
    result.tombstone += plan.tombstone;
    result.unchanged += plan.unchanged;
    for (const input of plan.inputs) {
      pending.push(input);
      if (pending.length >= batchRows) await flush();
    }
  }
  await flush();
  return result;
}

export async function listLiveInventoryLinesForEngine(engineEntityId: string): Promise<EngineInventoryLineRow[]> {
  const rows = await db
    .select()
    .from(erpEngineInventoryLines)
    .where(eq(erpEngineInventoryLines.engineEntityId, engineEntityId as any));
  return (rows as any[])
    .map((r) => SyncTableRegistry.toSyncRow(SyncTableName.ErpEngineInventoryLines, r) as EngineInventoryLineRow)
    .filter((l) => l.deleted_at == null);
}
