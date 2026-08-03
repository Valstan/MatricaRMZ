// Гейт Ф2: НАСТОЯЩИЙ мост window.matrica — реальный preload Electron-клиента →
// in-process шина электрон-шима → реальные ipc/register/*-модули → портированные
// сервисы → SQLite (better-sqlite3-адаптер). Ничего из цепочки не замокано,
// кроме сервера (globalThis.fetch) и самой SQLite-платформы.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authLogin, clearSession } from '../../../electron-app/src/main/services/authService.js';

import { createBetterSqlite3AsyncAdapter, type BetterSqlite3AsyncAdapter } from '../db/testing/betterSqlite3Adapter.js';
import { setAndroidPlatformHooks } from '../shims/platform.js';
import { bootAndroidCore, type AndroidCore } from './boot.js';
import { installAndroidBridge } from './ipcWiring.js';

const API = 'http://fake-api';
const ENGINE_TYPE_ID = '11111111-1111-4111-8111-111111111111';
const ENGINE_NUMBER_DEF_ID = '22222222-2222-4222-8222-222222222222';
const user = { id: 'u-1', username: 'verify', fullName: 'Verify User', role: 'admin' };
const PERMS = {
  'engines.view': true,
  'engines.edit': true,
  'operations.view': true,
  'operations.edit': true,
  'masterdata.view': true,
  'employees.view': true,
};

// Нетипизированный доступ вместо MatricaApi из shared: тот тип отстаёт от
// реального preload (нет drafts и части checklists) — а мост в этом гейте и
// есть настоящий preload, форму методов диктует он.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matrica(): any {
  return (globalThis as { matrica?: unknown }).matrica;
}

describe('android bridge smoke (preload → шина → register → сервисы)', () => {
  const realFetch = globalThis.fetch;
  let adapter: BetterSqlite3AsyncAdapter;
  let core: AndroidCore;

  beforeEach(async () => {
    adapter = createBetterSqlite3AsyncAdapter(':memory:');
    setAndroidPlatformHooks({ encryptionAvailable: () => true, appVersion: () => '0.0.1-test' });

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith(`${API}/auth/login`)) {
        return Response.json({ ok: true, accessToken: 'at', refreshToken: 'rt', user, permissions: PERMS });
      }
      if (url.startsWith(`${API}/health`)) {
        return Response.json({ ok: true, version: '0.0.1-test' });
      }
      // Всё остальное (heartbeat, логи, resync) в этом гейте не участвует.
      return Response.json({ ok: true });
    }) as typeof fetch;

    core = await bootAndroidCore({
      sqlite: adapter,
      defaultApiBaseUrl: API,
      resetLocalDatabaseFiles: async () => {},
    });
    await installAndroidBridge(core);
    await authLogin(core.serviceDb, { apiBaseUrl: API, username: 'verify', password: 'x' });

    // Минимальный seed мастерданных (на живом клиенте приходит sync-ом):
    // тип «Двигатель» + атрибут engine_number.
    await adapter.run(
      `INSERT INTO entity_types (id, code, name, created_at, updated_at, sync_status) VALUES (?, 'engine', 'Двигатель', 1, 1, 'synced')`,
      [ENGINE_TYPE_ID],
    );
    await adapter.run(
      `INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at, sync_status)
       VALUES (?, ?, 'engine_number', 'Номер', 'text', 1, 1, 'synced')`,
      [ENGINE_NUMBER_DEF_ID, ENGINE_TYPE_ID],
    );
  });

  afterEach(async () => {
    await clearSession(core.serviceDb);
    await adapter.close();
    globalThis.fetch = realFetch;
  });

  it('auth.status идёт через настоящий preload и видит сессию', async () => {
    const s = (await matrica().auth.status()) as { loggedIn: boolean; user?: { username?: string } | null };
    expect(s.loggedIn).toBe(true);
    expect(s.user?.username).toBe('verify');
  });

  it('двигатель: create → setAttr → list/get, операции и аудит — весь путь до SQLite', async () => {
    // Deferred create: возвращает только {id}, строка в БД появляется первым setAttr.
    const created = (await matrica().engines.create()) as { id?: string };
    expect(created.id).toBeTruthy();
    const engineId = String(created.id);

    // setAttr возвращает void; успех = отсутствие исключения + строка в БД ниже.
    await matrica().engines.setAttr(engineId, 'engine_number', 'SM-777');

    const list = (await matrica().engines.list()) as Array<{ id: string }>;
    expect(list.some((r) => r.id === engineId)).toBe(true);

    const details = (await matrica().engines.get(engineId)) as {
      ok?: boolean;
      attrs?: Record<string, unknown>;
      attributes?: Array<{ code: string; value: unknown }>;
    };
    expect(JSON.stringify(details)).toContain('SM-777');

    await matrica().operations.add(engineId, 'repair', 'in_progress', 'смоук');
    const ops = (await matrica().operations.list(engineId)) as Array<{ operationType: string }>;
    expect(ops.length).toBeGreaterThan(0);

    const audit = (await matrica().audit.add({ action: 'bridge-smoke', entityId: engineId })) as { ok?: boolean };
    expect(audit && (audit.ok ?? true)).toBeTruthy();

    // Строка реально в базе (не в моке).
    const row = await adapter.get<{ c: number }>(`SELECT COUNT(*) AS c FROM entities WHERE id = ?`, [engineId]);
    expect(row?.c).toBe(1);
  });

  it('черновики карточек: save → get → clear', async () => {
    const saved = (await matrica().drafts.save({
      cardType: 'engine',
      cardId: 'e-1',
      payloadJson: JSON.stringify({ note: 'из цеха' }),
    })) as { ok: boolean };
    expect(saved.ok).toBe(true);

    const got = (await matrica().drafts.get({ cardType: 'engine', cardId: 'e-1' })) as {
      ok: boolean;
      draft?: { payloadJson?: string } | null;
    };
    expect(got.ok).toBe(true);
    expect(String(got.draft?.payloadJson ?? '')).toContain('из цеха');

    const cleared = (await matrica().drafts.clear({ cardType: 'engine', cardId: 'e-1' })) as { ok: boolean };
    expect(cleared.ok).toBe(true);
  });

  it('дефектовка: checklists.engineGet отвечает по пустому двигателю без падения', async () => {
    const created = (await matrica().engines.create()) as { id?: string };
    const res = (await matrica().checklists.engineGet({ engineId: String(created.id), stage: 'inventory' })) as {
      ok?: boolean;
      error?: string;
    };
    expect(res).toBeTruthy();
    expect(res.error ?? '').not.toContain('не реализовано');
  });

  it('незарегистрированный домен (файлы) отвечает мягким отказом, а не падением', async () => {
    const res = (await matrica().files.pick({})) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('недоступно на планшете');
  });

  it('server.health ходит фейк-сервером через настоящий authAndSync-модуль', async () => {
    const res = (await matrica().server.health()) as { ok: boolean };
    expect(res.ok).toBe(true);
  });
});
