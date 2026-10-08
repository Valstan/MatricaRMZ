import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { ENGINE_INVENTORY_STAGE } from '@matricarmz/shared';

const handlers = new Map<string, (...args: any[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: any[]) => unknown) => void handlers.set(ch, fn) },
}));

import { registerChecklistsIpc } from './checklists.js';
import { saveRepairChecklistForEngine } from '../../services/checklistService.js';

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

function makeCtx(sqlite: Database.Database, perms: Record<string, boolean> = { 'operations.edit': true }) {
  const db = drizzle(sqlite);
  return {
    sysDb: db,
    dataDb: () => db,
    mode: () => ({ mode: 'live' }) as const,
    mgr: { getApiBaseUrl: () => 'http://test' },
    logToFile: () => undefined,
    currentActor: async () => 'tester',
    currentViewer: async () => ({ login: 'tester', role: 'admin' }),
    currentPermissions: async () => perms,
  } as any;
}

async function seedLeaf(db: any) {
  const r = await saveRepairChecklistForEngine(db, {
    engineId: 'eng-1',
    stage: ENGINE_INVENTORY_STAGE,
    payload: {
      kind: 'repair_checklist',
      templateId: 'engine_inventory_default',
      templateVersion: 1,
      stage: ENGINE_INVENTORY_STAGE,
      engineEntityId: 'eng-1',
      filledBy: 'tester',
      filledAt: 1,
      answers: { defect_start_date: { kind: 'date', value: 1000 } },
    } as any,
    actor: 'tester',
  });
  expect(r.ok).toBe(true);
}

describe('checklists:engine:setAnswerDate — проводка «этап → акт» (09.10.2026)', () => {
  it('хендлер зарегистрирован и правит дату листа', async () => {
    const { sqlite, db } = makeDb();
    await seedLeaf(db);
    handlers.clear();
    registerChecklistsIpc(makeCtx(sqlite));
    const setDate = handlers.get('checklists:engine:setAnswerDate');
    expect(setDate, 'хендлер не зарегистрирован — панель зовёт пустоту').toBeDefined();
    const r = (await setDate!({}, { engineId: 'eng-1', stage: ENGINE_INVENTORY_STAGE, code: 'defect_start_date', atMs: 2000 })) as {
      ok: boolean;
    };
    expect(r.ok).toBe(true);
    const leafId = (sqlite.prepare(`SELECT id FROM operations WHERE operation_type = ? AND engine_entity_id = ?`).get(ENGINE_INVENTORY_STAGE, 'eng-1') as any).id;
    const meta = JSON.parse((sqlite.prepare(`SELECT meta_json FROM operations WHERE id = ?`).get(leafId) as any).meta_json);
    expect(meta.answers.defect_start_date).toEqual({ kind: 'date', value: 2000 });
  });

  it('без права operations.edit — отказ', async () => {
    const { sqlite } = makeDb();
    handlers.clear();
    registerChecklistsIpc(makeCtx(sqlite, {}));
    const setDate = handlers.get('checklists:engine:setAnswerDate')!;
    const r = (await setDate({}, { engineId: 'eng-1', stage: ENGINE_INVENTORY_STAGE, code: 'defect_start_date', atMs: 1 })) as {
      ok: boolean;
    };
    expect(r.ok).toBe(false);
  });
});
