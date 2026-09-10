import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ENGINE_INVENTORY_STAGE, type RepairChecklistPayload } from '@matricarmz/shared';

import { saveRepairChecklistForEngine } from './checklistService.js';

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
