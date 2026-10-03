import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: any[]) => unknown) => void handlers.set(ch, fn) },
}));

import { registerEngineCardsIpc } from './engineCards.js';

const here = dirname(fileURLToPath(import.meta.url));

function makeCtx(sqlite: Database.Database) {
  const db = drizzle(sqlite);
  return {
    sysDb: db,
    dataDb: () => db,
    mode: () => ({ mode: 'live' }) as const,
    mgr: { getApiBaseUrl: () => 'http://test' },
    logToFile: () => undefined,
    currentActor: async () => 'tester',
    currentViewer: async () => ({ login: 'tester', role: 'admin' }),
    currentPermissions: async () => ({ 'engines.view': true, 'engines.edit': true }),
  } as any;
}

// Гоняем НАСТОЯЩИЙ SQL миграции 0032 (а не переписанный руками DDL): опечатка
// в файле обязана ронять тест, а не уезжать на машины парка.
function makeDb() {
  const sqlite = new Database(':memory:');
  const sql = readFileSync(join(here, '../../../../drizzle/0032_erp_engine_cards_replica.sql'), 'utf8');
  sqlite.exec(sql);
  return { sqlite };
}

describe('engines:card:get (E3a)', () => {
  it('отдаёт строку реплики в snake_case', async () => {
    const { sqlite } = makeDb();
    sqlite
      .prepare(
        `INSERT INTO erp_engine_cards (id, engine_number, engine_internal_number_year, status_repaired, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run('e-1', 'A-1', 2026, 1, 10, 20);
    registerEngineCardsIpc(makeCtx(sqlite));
    const get = handlers.get('engines:card:get')!;
    const r = (await get({}, 'e-1')) as { ok: boolean; row?: Record<string, unknown> | null };
    expect(r.ok).toBe(true);
    expect(r.row).toMatchObject({
      id: 'e-1',
      engine_number: 'A-1',
      engine_internal_number_year: 2026,
      status_repaired: true,
      status_rework_sent: false,
    });
    sqlite.close();
  });

  it('без строки — row null (EAV-фолбэк решает renderer)', async () => {
    const { sqlite } = makeDb();
    registerEngineCardsIpc(makeCtx(sqlite));
    const get = handlers.get('engines:card:get')!;
    const r = (await get({}, 'missing')) as { ok: boolean; row?: null };
    expect(r.ok).toBe(true);
    expect(r.row).toBeNull();
    sqlite.close();
  });

  it('мягко удалённая строка — row null', async () => {
    const { sqlite } = makeDb();
    sqlite
      .prepare(`INSERT INTO erp_engine_cards (id, deleted_at, created_at, updated_at) VALUES (?,?,?,?)`)
      .run('e-del', 30, 10, 20);
    registerEngineCardsIpc(makeCtx(sqlite));
    const get = handlers.get('engines:card:get')!;
    const r = (await get({}, 'e-del')) as { ok: boolean; row?: null };
    expect(r.ok).toBe(true);
    expect(r.row).toBeNull();
    sqlite.close();
  });
});

describe('engines:card:save (E3b)', () => {
  function makeEavDb() {
    const { sqlite } = makeDb();
    sqlite.exec(`
      CREATE TABLE entity_types (id text PRIMARY KEY NOT NULL, code text NOT NULL, name text NOT NULL,
        created_at integer NOT NULL, updated_at integer NOT NULL,
        last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
      CREATE TABLE entities (id text PRIMARY KEY NOT NULL, type_id text NOT NULL,
        created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
      CREATE TABLE attribute_defs (id text PRIMARY KEY NOT NULL, entity_type_id text NOT NULL, code text NOT NULL,
        name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0, sort_order integer NOT NULL DEFAULT 0,
        meta_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
        last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
      CREATE TABLE attribute_values (id text PRIMARY KEY NOT NULL, entity_id text NOT NULL, attribute_def_id text NOT NULL,
        value_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
        last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
      INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ('t-engine', 'engine', 'Engine', 1, 1);
      INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('e-1', 't-engine', 1, 1), ('e-2', 't-engine', 1, 1);
      INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at)
        VALUES ('d-num', 't-engine', 'engine_number', 'N', 'text', 1, 1),
               ('d-inum', 't-engine', 'engine_internal_number', 'N', 'text', 1, 1),
               ('d-year', 't-engine', 'engine_internal_number_year', 'N', 'number', 1, 1),
               ('d-flag', 't-engine', 'repeat_arrival_flag', 'N', 'boolean', 1, 1);
      INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
        VALUES ('v-1', 'e-2', 'd-num', '"DUP-1"', 1, 1),
               ('v-2', 'e-2', 'd-inum', '"41"', 1, 1),
               ('v-3', 'e-2', 'd-year', '2026', 1, 1);
    `);
    return { sqlite };
  }

  it('неизвестный код — громкий отказ', async () => {
    const { sqlite } = makeEavDb();
    registerEngineCardsIpc(makeCtx(sqlite));
    const save = handlers.get('engines:card:save')!;
    const r = (await save({}, { id: 'e-1', fields: { hacker: 1 } })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('hacker');
    sqlite.close();
  });

  it('дубль номера блокируется клиентским гейтом', async () => {
    const { sqlite } = makeEavDb();
    registerEngineCardsIpc(makeCtx(sqlite));
    const save = handlers.get('engines:card:save')!;
    const r = (await save({}, { id: 'e-1', fields: { engine_number: 'dup-1' } })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('уже существует');
    sqlite.close();
  });

  it('флаг обхода из того же сейва снимает запрет', async () => {
    const { sqlite } = makeEavDb();
    registerEngineCardsIpc(makeCtx(sqlite));
    const save = handlers.get('engines:card:save')!;
    const r = (await save({}, { id: 'e-1', fields: { engine_number: 'DUP-1', repeat_arrival_flag: true } })) as {
      ok: boolean;
      changed?: boolean;
    };
    expect(r.ok).toBe(true);
    const row = sqlite.prepare(`SELECT engine_number AS n, sync_status AS s FROM erp_engine_cards WHERE id='e-1'`).get() as any;
    expect(row.n).toBe('DUP-1');
    expect(row.s).toBe('pending');
    sqlite.close();
  });

  it('дубль пары клейма блокируется', async () => {
    const { sqlite } = makeEavDb();
    registerEngineCardsIpc(makeCtx(sqlite));
    const save = handlers.get('engines:card:save')!;
    const r = (await save({}, { id: 'e-1', fields: { engine_internal_number: '041', engine_internal_number_year: 2026 } })) as {
      ok: boolean;
    };
    expect(r.ok).toBe(false);
    sqlite.close();
  });

  it('сейв материализует сущность (deferred-create) и пишет реплику', async () => {
    const { sqlite } = makeEavDb();
    registerEngineCardsIpc(makeCtx(sqlite));
    const save = handlers.get('engines:card:save')!;
    const r = (await save({}, { id: 'e-3', fields: { engine_number: 'NEW-9' } })) as { ok: boolean; changed?: boolean };
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    const ent = sqlite.prepare(`SELECT id FROM entities WHERE id='e-3'`).get();
    expect(ent).toBeTruthy();
    sqlite.close();
  });
});
