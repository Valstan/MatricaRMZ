import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: any[]) => unknown) => void handlers.set(ch, fn) },
}));

const httpCalls: Array<{ url: string; method?: string; body?: unknown }> = [];
let getResponse: { ok: boolean; status: number; json?: unknown; text?: string } = {
  ok: false,
  status: 404,
  json: { ok: false, error: 'not found' },
};
let postResponse: { ok: boolean; status: number; json?: unknown; text?: string } = {
  ok: true,
  status: 200,
  json: { ok: true, row: {} },
};

vi.mock('../../services/httpClient.js', () => ({
  httpAuthed: async (_db: unknown, _base: string, url: string, opts?: { method?: string; body?: string }) => {
    httpCalls.push({ url, method: opts?.method ?? 'GET', body: opts?.body ? JSON.parse(opts.body) : undefined });
    return url.includes('/patch') || (opts?.method === 'POST' && !url.includes('/counterparties/'))
      ? postResponse
      : getResponse;
  },
}));

import { registerContractsIpc } from './contracts.js';

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
    currentPermissions: async () => ({ 'masterdata.view': true, 'masterdata.edit': true }),
  } as any;
}

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE erp_counterparties (id text PRIMARY KEY NOT NULL, name text NOT NULL,
      short_name text, inn text, kpp text, address text, email text, phone text,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  `);
  return { sqlite };
}

describe('contracts:counterparty IPC', () => {
  it('get отдаёт строку реплики в snake_case', async () => {
    const { sqlite } = makeDb();
    sqlite.prepare(`INSERT INTO erp_counterparties (id,name,created_at,updated_at) VALUES (?,?,?,?)`)
      .run('cp-1', 'OOO Test', 1, 2);
    registerContractsIpc(makeCtx(sqlite));
    const get = handlers.get('contracts:counterparty:get')!;
    const r = (await get({}, 'cp-1')) as { ok: boolean; row?: { name: string; updated_at: number } | null };
    expect(r.ok).toBe(true);
    expect(r.row?.name).toBe('OOO Test');
    expect(r.row?.updated_at).toBe(2);
  });

  it('get без строки — row null (EAV-фолбэк решает renderer)', async () => {
    const { sqlite } = makeDb();
    registerContractsIpc(makeCtx(sqlite));
    const get = handlers.get('contracts:counterparty:get')!;
    const r = (await get({}, 'missing')) as { ok: boolean; row?: null };
    expect(r.ok).toBe(true);
    expect(r.row).toBeNull();
  });

  it('save существующего идёт в patch и делает write-through', async () => {
    const { sqlite } = makeDb();
    registerContractsIpc(makeCtx(sqlite));
    httpCalls.length = 0;
    getResponse = { ok: true, status: 200, json: { ok: true, row: { id: 'cp-1' } } };
    postResponse = {
      ok: true,
      status: 200,
      json: { ok: true, row: { id: 'cp-1', name: 'New', short_name: null, inn: null, kpp: null, address: null, phone: null, email: null, created_at: 1, updated_at: 5 } },
    };
    const save = handlers.get('contracts:counterparty:save')!;
    const r = (await save({}, { id: 'cp-1', fields: { name: 'New' } })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(httpCalls.some((c) => c.url.includes('/patch'))).toBe(true);
    const local = sqlite.prepare(`SELECT name AS n, sync_status AS s FROM erp_counterparties WHERE id='cp-1'`).get() as any;
    expect(local.n).toBe('New');
    expect(local.s).toBe('synced');
  });

  it('save нового идёт в create', async () => {
    const { sqlite } = makeDb();
    registerContractsIpc(makeCtx(sqlite));
    httpCalls.length = 0;
    getResponse = { ok: false, status: 404, json: { ok: false } };
    postResponse = {
      ok: true,
      status: 200,
      json: { ok: true, row: { id: 'cp-9', name: 'Created', short_name: null, inn: null, kpp: null, address: null, phone: null, email: null, created_at: 1, updated_at: 6 } },
    };
    const save = handlers.get('contracts:counterparty:save')!;
    const r = (await save({}, { id: 'cp-9', fields: { name: 'Created' } })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(httpCalls.some((c) => c.url === '/counterparties')).toBe(true);
    const local = sqlite.prepare(`SELECT count(*) AS c FROM erp_counterparties WHERE id='cp-9'`).get() as any;
    expect(local.c).toBe(1);
  });

  it('create находит существующего по точному имени', async () => {
    const { sqlite } = makeDb();
    sqlite.prepare(`INSERT INTO erp_counterparties (id,name,created_at,updated_at) VALUES (?,?,?,?)`)
      .run('cp-1', 'OOO Test', 1, 2);
    registerContractsIpc(makeCtx(sqlite));
    httpCalls.length = 0;
    const create = handlers.get('contracts:counterparty:create')!;
    const r = (await create({}, { fields: { name: '  OOO TEST ' } })) as { ok: boolean; existing?: boolean; row?: { id: string } };
    expect(r.ok).toBe(true);
    expect(r.existing).toBe(true);
    expect(r.row?.id).toBe('cp-1');
    expect(httpCalls.length).toBe(0);
  });
});
