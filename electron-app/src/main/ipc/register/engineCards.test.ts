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
    currentPermissions: async () => ({ 'engines.view': true }),
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
