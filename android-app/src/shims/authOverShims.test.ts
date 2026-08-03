// Гейт Ф1.3: НАСТОЯЩИЙ authService Electron-клиента (не копия) работает поверх
// android-шимов ('electron' → shims/electron.ts через androidShims-плагин) и
// async-БД (sqlite-proxy). Сервер фейкуется подменой globalThis.fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  authLogin,
  authLogout,
  authRefresh,
  authStatus,
  clearSession,
  getSession,
} from '../../../electron-app/src/main/services/authService.js';

import { createBetterSqlite3AsyncAdapter, type BetterSqlite3AsyncAdapter } from '../db/testing/betterSqlite3Adapter.js';
import { createDrizzleAsync } from '../db/drizzleAsync.js';
import { migrateSqliteAsync } from '../db/migrate.js';
import { setAndroidPlatformHooks } from './platform.js';

const API = 'http://fake-api';

const user = { id: 'u-1', username: 'verify', fullName: 'Verify User' };

function fakeFetchImpl(routes: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const route = Object.keys(routes).find((r) => url.startsWith(`${API}${r}`));
    if (!route) return new Response('not found', { status: 404 });
    const { status, body } = routes[route]!(init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('electron authService поверх android-шимов', () => {
  let adapter: BetterSqlite3AsyncAdapter;
  let db: BetterSQLite3Database;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    adapter = createBetterSqlite3AsyncAdapter(':memory:');
    await migrateSqliteAsync(adapter);
    db = createDrizzleAsync(adapter) as unknown as BetterSQLite3Database;
    setAndroidPlatformHooks({ encryptionAvailable: () => true });
  });

  afterEach(async () => {
    await clearSession(db); // memorySession — модульное состояние, сбрасываем
    await adapter.close();
    globalThis.fetch = realFetch;
  });

  it('login → сессия в sync_state (hex внутри шифруемой БД), status=loggedIn', async () => {
    globalThis.fetch = fakeFetchImpl({
      '/auth/login': () => ({
        status: 200,
        body: { ok: true, accessToken: 'at-1', refreshToken: 'rt-1', user, permissions: { 'engines.view': true } },
      }),
      '/logs/client-settings': () => ({ status: 200, body: { ok: true } }),
      '/logs': () => ({ status: 200, body: { ok: true } }),
    }) as typeof fetch;

    const r = await authLogin(db, { apiBaseUrl: API, username: 'verify', password: 'verify123' });
    expect(r.ok).toBe(true);

    const status = await authStatus(db);
    expect(status.loggedIn).toBe(true);
    expect(status.user?.username).toBe('verify');

    const row = await adapter.get<{ value: string }>(`SELECT value FROM sync_state WHERE key = 'auth.session'`);
    expect(row?.value).toBeTruthy();
    const stored = JSON.parse(row!.value) as { enc: boolean; data: string };
    expect(stored.enc).toBe(true);
    expect(/^[0-9a-f]+$/.test(stored.data)).toBe(true); // hex, не плейнтекст-JSON

    // Round-trip: getSession расшифровывает то, что persistSession записал.
    // (memorySession обнуляется при enc-персисте — чтение идёт из БД.)
    const session = await getSession(db);
    expect(session?.accessToken).toBe('at-1');
  });

  it('fail-closed: без Keystore сессия только в памяти, в БД пусто', async () => {
    setAndroidPlatformHooks({ encryptionAvailable: () => false });
    globalThis.fetch = fakeFetchImpl({
      '/auth/login': () => ({
        status: 200,
        body: { ok: true, accessToken: 'at-2', refreshToken: 'rt-2', user, permissions: {} },
      }),
      '/logs/client-settings': () => ({ status: 200, body: { ok: true } }),
      '/logs': () => ({ status: 200, body: { ok: true } }),
    }) as typeof fetch;

    const r = await authLogin(db, { apiBaseUrl: API, username: 'verify', password: 'verify123' });
    expect(r.ok).toBe(true);
    expect((await authStatus(db)).loggedIn).toBe(true);
    const row = await adapter.get<{ value: string }>(`SELECT value FROM sync_state WHERE key = 'auth.session'`);
    expect(row?.value ?? '').toBe('');
  });

  it('refresh обновляет токены; 401 на refresh чистит сессию', async () => {
    globalThis.fetch = fakeFetchImpl({
      '/auth/login': () => ({
        status: 200,
        body: { ok: true, accessToken: 'at-old', refreshToken: 'rt-old', user, permissions: {} },
      }),
      '/auth/refresh': () => ({
        status: 200,
        body: { ok: true, accessToken: 'at-new', refreshToken: 'rt-new', user },
      }),
      '/logs/client-settings': () => ({ status: 200, body: { ok: true } }),
      '/logs': () => ({ status: 200, body: { ok: true } }),
    }) as typeof fetch;

    await authLogin(db, { apiBaseUrl: API, username: 'verify', password: 'verify123' });
    const refreshed = await authRefresh(db, { apiBaseUrl: API, refreshToken: 'rt-old' });
    expect(refreshed.ok).toBe(true);
    expect((await getSession(db))?.accessToken).toBe('at-new');

    globalThis.fetch = fakeFetchImpl({
      '/auth/refresh': () => ({ status: 401, body: { ok: false } }),
    }) as typeof fetch;
    const rejected = await authRefresh(db, { apiBaseUrl: API, refreshToken: 'rt-new' });
    expect(rejected.ok).toBe(false);
    expect((await authStatus(db)).loggedIn).toBe(false);
  });

  it('logout чистит сессию даже при недоступном сервере', async () => {
    globalThis.fetch = fakeFetchImpl({
      '/auth/login': () => ({
        status: 200,
        body: { ok: true, accessToken: 'at-3', refreshToken: 'rt-3', user, permissions: {} },
      }),
      '/logs/client-settings': () => ({ status: 200, body: { ok: true } }),
      '/logs': () => ({ status: 200, body: { ok: true } }),
    }) as typeof fetch;
    await authLogin(db, { apiBaseUrl: API, username: 'verify', password: 'verify123' });

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const r = await authLogout(db, { apiBaseUrl: API });
    expect(r.ok).toBe(true);
    expect((await authStatus(db)).loggedIn).toBe(false);
  });
});
