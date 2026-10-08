import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ENGINE_INVENTORY_STAGE, DEFAULT_REPAIR_STAGE_TEMPLATES, type RepairChecklistPayload } from '@matricarmz/shared';

import { hasDefectActData, saveRepairChecklistForEngine, setChecklistAnswerDate } from './checklistService.js';
import { deleteRepairStageRow, saveRepairStageRow } from './repairStageService.js';

// Лист деталей новой карточки двигателя (10.09.2026). Карточка получает id двигателя без строки
// в базе, а панель сама сохраняет автозаполненный лист — дважды подряд. Итог: у двигателя два
// листа, а на сервер лист уезжал раньше двигателя и ложился в карантин с «критичной» тревогой.
function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE entity_types (id text PRIMARY KEY, code text NOT NULL, name text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE entities (id text PRIMARY KEY, type_id text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
      status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE erp_engine_inventory_lines (id text PRIMARY KEY NOT NULL, operation_id text NOT NULL,
      engine_entity_id text NOT NULL, line_key text NOT NULL, sort_order integer NOT NULL, part_id text,
      brand_managed integer NOT NULL DEFAULT false, part_name text NOT NULL DEFAULT '',
      assembly_unit_number text NOT NULL DEFAULT '', part_number text NOT NULL DEFAULT '',
      stamped_number text NOT NULL DEFAULT '', bom_variant_group text, quantity integer NOT NULL DEFAULT 0,
      present integer NOT NULL DEFAULT false, actual_qty integer NOT NULL DEFAULT 0,
      repairable_qty integer NOT NULL DEFAULT 0, scrap_qty integer NOT NULL DEFAULT 0,
      replace_qty integer NOT NULL DEFAULT 0, replenishment_branch text, scrap_reason text NOT NULL DEFAULT '',
      in_completeness_act integer, in_defect_act integer, in_completeness_act_override integer,
      in_defect_act_override integer, has_own_number integer, has_own_number_override integer,
      selected integer NOT NULL DEFAULT false, photos_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced');
  `);
  sqlite.prepare(`INSERT INTO entity_types (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)`).run('et-engine', 'engine', 'Двигатель', 1, 1);
  return { sqlite, db: drizzle(sqlite) as any };
}

function payload(engineId: string, engineNumber = ''): RepairChecklistPayload {
  return {
    kind: 'repair_checklist',
    templateId: 'engine_inventory_default',
    templateVersion: 1,
    stage: ENGINE_INVENTORY_STAGE,
    engineEntityId: engineId,
    filledBy: 'tester',
    filledAt: 1,
    answers: { engine_number: { kind: 'text', value: engineNumber } },
  } as RepairChecklistPayload;
}

function count(sqlite: Database.Database, table: string): number {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function save(db: any, engineId: string, opts: { auto?: boolean; operationId?: string | null; engineNumber?: string } = {}) {
  return saveRepairChecklistForEngine(db, {
    engineId,
    stage: ENGINE_INVENTORY_STAGE,
    payload: payload(engineId, opts.engineNumber),
    actor: 'tester',
    ...(opts.operationId !== undefined ? { operationId: opts.operationId } : {}),
    ...(opts.auto ? { auto: true } : {}),
  });
}

describe('saveRepairChecklistForEngine: лист новой карточки двигателя', () => {
  it('автозаполнение не пишет лист, пока двигатель не сохранён', async () => {
    const { sqlite, db } = makeDb();
    const r = await save(db, 'eng-new', { auto: true });
    expect(r).toEqual({ ok: true, operationId: null, deferred: true });
    expect(count(sqlite, 'operations')).toBe(0);
    expect(count(sqlite, 'entities')).toBe(0);
  });

  it('правка оператора сначала сохраняет двигатель, и лист не уходит сиротой', async () => {
    const { sqlite, db } = makeDb();
    const r = await save(db, 'eng-new');
    expect(r.ok && r.operationId).toBeTruthy();
    const engine = sqlite.prepare(`SELECT type_id, sync_status FROM entities WHERE id = ?`).get('eng-new') as any;
    expect(engine).toEqual({ type_id: 'et-engine', sync_status: 'pending' });
    const op = sqlite.prepare(`SELECT engine_entity_id FROM operations`).get() as any;
    expect(op.engine_entity_id).toBe('eng-new');
  });

  it('два сохранения без номера листа дают один лист, а не два', async () => {
    const { sqlite, db } = makeDb();
    sqlite.prepare(`INSERT INTO entities (id,type_id,created_at,updated_at) VALUES (?,?,?,?)`).run('eng-1', 'et-engine', 1, 1);
    const first = await save(db, 'eng-1', { auto: true, operationId: null });
    const second = await save(db, 'eng-1', { auto: true, operationId: null, engineNumber: '41' });
    expect(first.ok && second.ok).toBe(true);
    expect(count(sqlite, 'operations')).toBe(1);
    expect((second as any).operationId).toBe((first as any).operationId);
    const meta = JSON.parse((sqlite.prepare(`SELECT meta_json FROM operations`).get() as any).meta_json);
    expect(meta.answers.engine_number.value).toBe('41');
  });
});

describe('двусторонняя связь акта и этапа (09.10.2026)', () => {
  // Карточка двигателя заводится «сейчас» (ensureEngineRow) — дата этапа раньше дня
  // заведения упирается в субординацию (card_created), поэтому даты тестов — сегодня.
  const NOW = Date.now();

  function defectAnswers() {
    return {
      engine_inventory_items: { rows: [{ part_name: 'Вал', quantity: 2, scrap_qty: 1 }] },
      defect_start_date: { kind: 'date', value: NOW },
    };
  }

  async function saveLeaf(db: any, engineId: string, answers: Record<string, unknown>) {
    const base = payload(engineId);
    (base as any).answers = answers;
    return saveRepairChecklistForEngine(db, { engineId, stage: ENGINE_INVENTORY_STAGE, payload: base, actor: 'tester' });
  }

  async function leafDate(db: any, engineId: string): Promise<unknown> {
    const { getRepairChecklistForEngine } = await import('./checklistService.js');
    const leaf = await getRepairChecklistForEngine(db, engineId, ENGINE_INVENTORY_STAGE);
    if (!leaf.ok || !leaf.payload) throw new Error('листа нет');
    return (leaf.payload.answers as any)?.defect_start_date;
  }

  it('hasDefectActData видит вердикты листа', async () => {
    const { db } = makeDb();
    await saveLeaf(db, 'eng-1', defectAnswers());
    expect(await hasDefectActData(db, 'eng-1')).toBe(true);
  });

  it('голая приёмка — не дефектный след', async () => {
    const { db } = makeDb();
    await saveLeaf(db, 'eng-1', { engine_inventory_items: { rows: [{ scrap_qty: 0, replace_qty: 0 }] } });
    expect(await hasDefectActData(db, 'eng-1')).toBe(false);
  });

  it('setChecklistAnswerDate правит дату в листе', async () => {
    const { db } = makeDb();
    await saveLeaf(db, 'eng-1', defectAnswers());
    const r = await setChecklistAnswerDate(db, { engineId: 'eng-1', stage: ENGINE_INVENTORY_STAGE, code: 'defect_start_date', atMs: NOW + 1000 });
    expect(r).toEqual({ ok: true });
    expect(await leafDate(db, 'eng-1')).toEqual({ kind: 'date', value: NOW + 1000 });
  });

  it('setChecklistAnswerDate без листа — отказ', async () => {
    const { db } = makeDb();
    const r = await setChecklistAnswerDate(db, { engineId: 'eng-1', stage: ENGINE_INVENTORY_STAGE, code: 'defect_start_date', atMs: 2000 });
    expect(r.ok).toBe(false);
  });

  it('снос disassembly_defect при живом акте — отказ', async () => {
    const { db } = makeDb();
    await saveLeaf(db, 'eng-1', defectAnswers());
    const s = await saveRepairStageRow(
      db,
      { id: 'st-1', engineId: 'eng-1', code: 'disassembly_defect', atMs: NOW },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(s.ok, `save: ${JSON.stringify(s)}`).toBe(true);
    const r = await deleteRepairStageRow(db, 'st-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('акту');
  });

  it('без акта строка дефектовки сносится свободно', async () => {
    const { db } = makeDb();
    const s = await saveRepairStageRow(
      db,
      { id: 'st-1', engineId: 'eng-1', code: 'disassembly_defect', atMs: 1000 },
      'tester',
      DEFAULT_REPAIR_STAGE_TEMPLATES,
    );
    expect(s.ok).toBe(true);
    expect((await deleteRepairStageRow(db, 'st-1')).ok).toBe(true);
  });
});
