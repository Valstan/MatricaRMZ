import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  ENGINE_INVENTORY_STAGE,
  engineInventoryLineId,
  inventoryLineKeys,
  inventoryRawRowsFromPayload,
  lineFromInventoryRow,
  normalizeEngineInventoryRow,
  type EngineInventoryLineRow,
} from '@matricarmz/shared';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getRepairChecklistForEngine, saveRepairChecklistForEngine } from './checklistService.js';
import { computeEngineInventoryFlags } from './engineService.js';
import { readInventoryRowsForOperations, withReplicaInventoryRows } from './engineInventoryLinesReplica.js';

// Сторож паритета E2.2 (план engine-inventory-lines-2026-09, G1): пока строки живут и в
// `meta_json`, и в строгой таблице, читатель обязан получать ОДИН и тот же список независимо
// от источника. Строки таблицы здесь выводятся из листа ровно так, как это делает сервер
// (`lineFromInventoryRow` + `inventoryLineKeys`), — то есть тест проверяет, что дорога
// «лист → таблица → реплика → читатель» не теряет и не искажает ни одного значения.

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE entities (id text PRIMARY KEY, type_id text NOT NULL, created_at integer NOT NULL,
      updated_at integer NOT NULL, last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
      status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE erp_engine_inventory_lines (
      id text PRIMARY KEY NOT NULL, operation_id text NOT NULL, engine_entity_id text NOT NULL,
      line_key text NOT NULL, sort_order integer NOT NULL, part_id text,
      brand_managed integer NOT NULL DEFAULT false, part_name text NOT NULL DEFAULT '',
      assembly_unit_number text NOT NULL DEFAULT '', part_number text NOT NULL DEFAULT '',
      stamped_number text NOT NULL DEFAULT '', bom_variant_group text,
      quantity integer NOT NULL DEFAULT 0, present integer NOT NULL DEFAULT false,
      actual_qty integer NOT NULL DEFAULT 0, repairable_qty integer NOT NULL DEFAULT 0,
      scrap_qty integer NOT NULL DEFAULT 0, replace_qty integer NOT NULL DEFAULT 0,
      replenishment_branch text, scrap_reason text NOT NULL DEFAULT '',
      in_completeness_act integer, in_defect_act integer, in_completeness_act_override integer,
      in_defect_act_override integer, has_own_number integer, has_own_number_override integer,
      selected integer NOT NULL DEFAULT false, photos_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  `);
  return { sqlite, db: drizzle(sqlite) as any };
}

const ENGINE = 'e1';
const OP = 'op1';

/** Лист той формы, что лежит в `operations.meta_json`: три строки с разными мета-ключами и мусором. */
function sheetPayload(rows: Array<Record<string, unknown>>) {
  return {
    kind: 'repair_checklist',
    templateId: 'engine_inventory_default',
    templateVersion: 1,
    stage: ENGINE_INVENTORY_STAGE,
    engineEntityId: ENGINE,
    filledBy: 'tester',
    filledAt: 1,
    answers: {
      engine_number: { kind: 'text', value: '41/26' },
      completeness_inspection_date: { kind: 'date', value: 1_700_000_000_000 },
      engine_inventory_items: { kind: 'table', rows },
    },
  };
}

const RAW_ROWS: Array<Record<string, unknown>> = [
  {
    part_name: 'Картер',
    assembly_unit_number: '240-1002',
    part_number: '240-1002015',
    quantity: 1,
    present: true,
    actual_qty: '1',
    repairable_qty: 0,
    scrap_qty: 1,
    replace_qty: 0,
    replenishment_branch: 'purchase',
    scrap_reason: 'трещина',
    stamped_number: 'A-17',
    in_defect_act: true,
    // «Свой номер»: значение комплекта марки + операторский override листа.
    has_own_number: true,
    has_own_number_override: true,
    __brand_source: 'engine_brand',
    __brand_part_id: 'part-crankcase',
    __selected: true,
  },
  {
    part_name: 'Поршень',
    assembly_unit_number: '',
    part_number: '240-1004021',
    quantity: 4,
    present: '1',
    actual_qty: 4,
    repairable_qty: 3,
    scrap_qty: 1,
    replace_qty: 1,
    replenishment_branch: null,
    scrap_reason: '',
    __part_id: 'part-piston',
    __photos: JSON.stringify([{ id: 'f1', name: 'p.jpg', size: 10, mime: 'image/jpeg', sha256: 'x' }]),
  },
  {
    part_name: 'Прокладка ручная',
    assembly_unit_number: '',
    part_number: '',
    quantity: 2,
    present: false,
    actual_qty: 0,
    repairable_qty: 0,
    scrap_qty: 0,
    replace_qty: 2,
    in_completeness_act_override: false,
    has_own_number: false,
  },
];

/** Строки таблицы из листа — как выводит сервер (E1, `engineInventoryLinesService`). */
function linesFromSheet(payload: unknown, ts = 100): EngineInventoryLineRow[] {
  const raws = inventoryRawRowsFromPayload(payload);
  const keys = inventoryLineKeys(raws);
  return raws.map((raw, i) =>
    lineFromInventoryRow(raw, {
      id: `line-${i}`,
      operationId: OP,
      engineEntityId: ENGINE,
      lineKey: keys[i]!,
      sortOrder: i,
      createdAt: ts,
      updatedAt: ts,
    }),
  );
}

function insertSheet(sqlite: Database.Database, payload: unknown, ts = 100) {
  sqlite
    .prepare(`INSERT INTO operations (id, engine_entity_id, operation_type, status, meta_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(OP, ENGINE, ENGINE_INVENTORY_STAGE, 'done', JSON.stringify(payload), ts, ts);
}

function insertLines(sqlite: Database.Database, lines: EngineInventoryLineRow[], deletedAt: number | null = null) {
  const stmt = sqlite.prepare(`INSERT INTO erp_engine_inventory_lines (
    id, operation_id, engine_entity_id, line_key, sort_order, part_id, brand_managed, part_name, assembly_unit_number,
    part_number, stamped_number, bom_variant_group, quantity, present, actual_qty, repairable_qty, scrap_qty, replace_qty,
    replenishment_branch, scrap_reason, in_completeness_act, in_defect_act, in_completeness_act_override,
    in_defect_act_override, has_own_number, has_own_number_override, selected, photos_json, created_at,
    updated_at, deleted_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const b = (v: boolean | null) => (v == null ? null : v ? 1 : 0);
  for (const l of lines) {
    stmt.run(
      l.id, l.operation_id, l.engine_entity_id, l.line_key, l.sort_order, l.part_id, b(l.brand_managed), l.part_name,
      l.assembly_unit_number, l.part_number, l.stamped_number, l.bom_variant_group, l.quantity, b(l.present), l.actual_qty,
      l.repairable_qty, l.scrap_qty, l.replace_qty, l.replenishment_branch, l.scrap_reason, b(l.in_completeness_act),
      b(l.in_defect_act), b(l.in_completeness_act_override), b(l.in_defect_act_override), b(l.has_own_number),
      b(l.has_own_number_override), b(l.selected), l.photos_json, l.created_at, l.updated_at, deletedAt,
    );
  }
}

/** То, что видит любой потребитель после нормализации: логические поля + мета-ключи. */
function comparable(raw: Record<string, unknown>) {
  const { row } = normalizeEngineInventoryRow(raw);
  const meta: Record<string, unknown> = {};
  for (const k of ['__brand_source', '__brand_part_id', '__part_id', '__selected']) if (raw[k] !== undefined) meta[k] = raw[k];
  meta.__photos_count = raw.__photos ? (JSON.parse(String(raw.__photos)) as unknown[]).length : 0;
  return { ...row, ...meta };
}

describe('E2.2 — строки списка из реплики строгой таблицы', () => {
  it('паритет: список из реплики == список из meta_json для того же листа (по всем полям и мета-ключам)', () => {
    const payload = sheetPayload(RAW_ROWS);
    const fromMeta = inventoryRawRowsFromPayload(payload).map(comparable);
    const { sqlite, db } = makeDb();
    insertSheet(sqlite, payload);
    insertLines(sqlite, linesFromSheet(payload));
    return getRepairChecklistForEngine(db, ENGINE, ENGINE_INVENTORY_STAGE).then((r) => {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const fromReplica = inventoryRawRowsFromPayload(r.payload).map(comparable);
      expect(fromReplica).toEqual(fromMeta);
      // Остальные ответы листа не тронуты.
      expect((r.payload as any).answers.engine_number.value).toBe('41/26');
    });
  });

  it('реплика пуста для листа → строки из meta_json (двигатели до бэкфилла, офлайн до первого pull)', async () => {
    const payload = sheetPayload(RAW_ROWS);
    const { sqlite, db } = makeDb();
    insertSheet(sqlite, payload);
    const r = await getRepairChecklistForEngine(db, ENGINE, ENGINE_INVENTORY_STAGE);
    expect(r.ok && inventoryRawRowsFromPayload(r.payload).length).toBe(3);
  });

  it('реплика знает лист → её строки ПОБЕЖДАЮТ meta_json (порядок по sort_order, тумстоуны не видны)', async () => {
    const payload = sheetPayload(RAW_ROWS);
    const { sqlite, db } = makeDb();
    // В meta_json — старый лист без строк (или с другими): читатель обязан взять таблицу.
    insertSheet(sqlite, sheetPayload([{ part_name: 'УСТАРЕВШАЯ', quantity: 9 }]));
    const lines = linesFromSheet(payload);
    // Перепутанный порядок вставки + одна погашенная строка.
    insertLines(sqlite, [lines[2]!, lines[0]!]);
    insertLines(sqlite, [lines[1]!], 200);
    const r = await getRepairChecklistForEngine(db, ENGINE, ENGINE_INVENTORY_STAGE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = inventoryRawRowsFromPayload(r.payload).map((x) => x.part_name);
    expect(names).toEqual(['Картер', 'Прокладка ручная']);
  });

  it('флаги двигателя считаются по строкам из реплики (картер в утиле, акт начат)', async () => {
    const payload = sheetPayload(RAW_ROWS);
    const { sqlite, db } = makeDb();
    insertSheet(sqlite, sheetPayload([]));
    insertLines(sqlite, linesFromSheet(payload));
    const rows = await readInventoryRowsForOperations(db, [{ id: OP, payload: sheetPayload([]) }]);
    const withRows = await withReplicaInventoryRows(db, OP, sheetPayload([]));
    expect(rows.get(OP)?.length).toBe(3);
    const flags = computeEngineInventoryFlags(withRows);
    expect(flags.crankcaseScrapped).toBe(true);
    expect(flags.actStarted).toBe(true);
    expect(flags.completenessInspectionAt).toBe(1_700_000_000_000);
  });

  it('другая стадия листа (акты) реплику не спрашивает и payload не меняет', async () => {
    const { sqlite, db } = makeDb();
    sqlite
      .prepare(`INSERT INTO operations (id, engine_entity_id, operation_type, status, meta_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run('op-act', ENGINE, 'completeness_act', 'done', JSON.stringify({ kind: 'repair_checklist', answers: { x: 1 } }), 1, 1);
    const r = await getRepairChecklistForEngine(db, ENGINE, 'completeness_act');
    expect(r.ok && (r.payload as any).answers).toEqual({ x: 1 });
  });
});

// ─── E2.3 (G2): запись строк с клиента ───────────────────────────────────────────────────

type LineRow = { id: string; line_key: string; part_name: string; scrap_qty: number; sync_status: string; deleted_at: number | null; sort_order: number };

function linesInDb(sqlite: Database.Database): LineRow[] {
  return sqlite
    .prepare(`SELECT id, line_key, part_name, scrap_qty, sync_status, deleted_at, sort_order FROM erp_engine_inventory_lines ORDER BY sort_order`)
    .all() as LineRow[];
}

function markLinesSynced(sqlite: Database.Database) {
  sqlite.prepare(`UPDATE erp_engine_inventory_lines SET sync_status = 'synced'`).run();
}

async function saveSheet(db: any, sqlite: Database.Database, rows: Array<Record<string, unknown>>, operationId?: string) {
  sqlite.prepare(`INSERT OR IGNORE INTO entities (id, type_id, created_at, updated_at) VALUES (?,?,?,?)`).run(ENGINE, 'et-engine', 1, 1);
  const r = await saveRepairChecklistForEngine(db, {
    engineId: ENGINE,
    stage: ENGINE_INVENTORY_STAGE,
    operationId: operationId ?? null,
    payload: sheetPayload(rows) as any,
    actor: 'tester',
  });
  expect(r.ok).toBe(true);
  if (!r.ok || !r.operationId) throw new Error('save failed');
  return r.operationId;
}

describe('E2.3 — сохранение листа пишет строки в реплику pending, по одной на изменение', () => {
  it('первое сохранение: все строки pending, id — тот же, что считает сервер, meta_json по-прежнему несёт rows', async () => {
    const { sqlite, db } = makeDb();
    const opId = await saveSheet(db, sqlite, RAW_ROWS);
    const lines = linesInDb(sqlite);
    expect(lines.map((l) => l.part_name)).toEqual(['Картер', 'Поршень', 'Прокладка ручная']);
    expect(lines.every((l) => l.sync_status === 'pending' && l.deleted_at == null)).toBe(true);
    const keys = inventoryLineKeys(RAW_ROWS);
    expect(lines.map((l) => l.id)).toEqual(keys.map((k) => engineInventoryLineId(opId, k)));
    const meta = JSON.parse(sqlite.prepare(`SELECT meta_json FROM operations WHERE id = ?`).get(opId)!['meta_json' as never] as string);
    expect(inventoryRawRowsFromPayload(meta).length).toBe(3);
  });

  it('одна изменённая ячейка → ровно одна pending-строка, остальные остаются synced', async () => {
    const { sqlite, db } = makeDb();
    const opId = await saveSheet(db, sqlite, RAW_ROWS);
    markLinesSynced(sqlite);
    const changed = RAW_ROWS.map((r, i) => (i === 1 ? { ...r, scrap_qty: 2 } : r));
    await saveSheet(db, sqlite, changed, opId);
    const lines = linesInDb(sqlite);
    expect(lines.filter((l) => l.sync_status === 'pending').map((l) => l.part_name)).toEqual(['Поршень']);
    expect(lines.find((l) => l.part_name === 'Поршень')?.scrap_qty).toBe(2);
    expect(lines.filter((l) => l.sync_status === 'synced').length).toBe(2);
  });

  it('удалённая строка гасится pending-тумстоуном, а вернувшаяся оживает под прежним id', async () => {
    const { sqlite, db } = makeDb();
    const opId = await saveSheet(db, sqlite, RAW_ROWS);
    markLinesSynced(sqlite);
    const pistonId = linesInDb(sqlite).find((l) => l.part_name === 'Поршень')!.id;
    await saveSheet(db, sqlite, [RAW_ROWS[0]!, RAW_ROWS[2]!], opId);
    let piston = linesInDb(sqlite).find((l) => l.id === pistonId)!;
    expect(piston.deleted_at).not.toBeNull();
    expect(piston.sync_status).toBe('pending');
    // Читатель тумстоун не видит.
    const r = await getRepairChecklistForEngine(db, ENGINE, ENGINE_INVENTORY_STAGE);
    expect(r.ok && inventoryRawRowsFromPayload(r.payload).map((x) => x.part_name)).toEqual(['Картер', 'Прокладка ручная']);
    markLinesSynced(sqlite);
    await saveSheet(db, sqlite, RAW_ROWS, opId);
    piston = linesInDb(sqlite).find((l) => l.id === pistonId)!;
    expect(piston.deleted_at).toBeNull();
    expect(piston.sync_status).toBe('pending');
    expect(linesInDb(sqlite).length).toBe(3);
  });

  it('повторное сохранение без изменений не трогает ни одной строки', async () => {
    const { sqlite, db } = makeDb();
    const opId = await saveSheet(db, sqlite, RAW_ROWS);
    markLinesSynced(sqlite);
    await saveSheet(db, sqlite, RAW_ROWS, opId);
    expect(linesInDb(sqlite).every((l) => l.sync_status === 'synced')).toBe(true);
  });
});

describe('E2.3 — push-обвязка знает таблицу строк (сторож по исходнику syncService)', () => {
  const sync = readFileSync(fileURLToPath(new URL('./syncService.ts', import.meta.url)), 'utf8');
  const recovery = readFileSync(fileURLToPath(new URL('./sync/errorRecovery.ts', import.meta.url)), 'utf8');
  it('секция push, лимит пачки, подтверждение synced и recovery — все четыре', () => {
    expect(sync).toContain('await add(SyncTableName.ErpEngineInventoryLines, valid)');
    expect(sync).toMatch(/\[SyncTableName\.ErpEngineInventoryLines\]: \d+,/);
    expect(sync).toContain("await db.update(erpEngineInventoryLines).set({ syncStatus: 'synced' })");
    expect(sync).toContain('recoverErroredRows(erpEngineInventoryLines, erpEngineInventoryLineRowSchema, SyncTableName.ErpEngineInventoryLines)');
    expect(recovery).toContain('[SyncTableName.ErpEngineInventoryLines]: erpEngineInventoryLines,');
  });
});
