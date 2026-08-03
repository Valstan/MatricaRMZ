// Гейты Ф1.5: идентичность клиента (clientId: БД → sidecar → генерация,
// переживает пересоздание реплики) и heartbeat настоящего clientAdminService
// поверх шимов (URL-параметры + персист настроек из ответа).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { applyRemoteClientSettings } from '../../../electron-app/src/main/services/clientAdminService.js';
import { authLogin, clearSession } from '../../../electron-app/src/main/services/authService.js';
import {
  SettingsKey,
  settingsGetBoolean,
  settingsGetString,
} from '../../../electron-app/src/main/services/settingsStore.js';

import { createBetterSqlite3AsyncAdapter, type BetterSqlite3AsyncAdapter } from '../db/testing/betterSqlite3Adapter.js';
import { createDrizzleAsync } from '../db/drizzleAsync.js';
import { migrateSqliteAsync } from '../db/migrate.js';
import { setAndroidPlatformHooks } from '../shims/platform.js';
import { ensureClientId } from './clientId.js';

const API = 'http://fake-api';
const user = { id: 'u-1', username: 'verify', fullName: 'Verify User' };

async function freshDb(): Promise<{ adapter: BetterSqlite3AsyncAdapter; db: BetterSQLite3Database }> {
  const adapter = createBetterSqlite3AsyncAdapter(':memory:');
  await migrateSqliteAsync(adapter);
  return { adapter, db: createDrizzleAsync(adapter) as unknown as BetterSQLite3Database };
}

function memKv() {
  const mem = new Map<string, string>();
  return { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => void mem.set(k, v) };
}

describe('android clientId', () => {
  it('генерация <host>-<uuid>, персист в БД и sidecar, идемпотентность', async () => {
    const { adapter, db } = await freshDb();
    const kv = memKv();
    const id = await ensureClientId(db, kv);
    expect(id).toMatch(/^[\w.-]{1,64}-[0-9a-f-]{36}$/i);
    expect(await ensureClientId(db, kv)).toBe(id);
    expect(await settingsGetString(db, SettingsKey.ClientId)).toBe(id);
    expect(kv.get('matricarmz.clientId')).toBe(id);
    await adapter.close();
  });

  it('пересоздание реплики: id восстанавливается из sidecar, а не рождается заново', async () => {
    const kv = memKv();
    const first = await freshDb();
    const id = await ensureClientId(first.db, kv);
    await first.adapter.close();

    const second = await freshDb(); // «self-heal» — свежая БД, sidecar жив
    expect(await ensureClientId(second.db, kv)).toBe(id);
    expect(await settingsGetString(second.db, SettingsKey.ClientId)).toBe(id);
    await second.adapter.close();
  });
});

describe('heartbeat настоящего clientAdminService поверх шимов', () => {
  const realFetch = globalThis.fetch;
  let adapter: BetterSqlite3AsyncAdapter;
  let db: BetterSQLite3Database;

  beforeEach(async () => {
    ({ adapter, db } = await freshDb());
    setAndroidPlatformHooks({ encryptionAvailable: () => true, deviceName: () => 'digma-odyssey' });
  });

  afterEach(async () => {
    await clearSession(db);
    await adapter.close();
    globalThis.fetch = realFetch;
  });

  it('heartbeat шлёт clientId/version/hostname/username с токеном и применяет настройки', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith(`${API}/auth/login`)) {
        return Response.json({ ok: true, accessToken: 'at', refreshToken: 'rt', user, permissions: {} });
      }
      if (url.startsWith(`${API}/client/settings`)) {
        expect((init?.headers as Record<string, string>)?.['Authorization'] ?? '').toBe('Bearer at');
        return Response.json({
          ok: true,
          settings: { updatesEnabled: false, loggingEnabled: true, loggingMode: 'dev', syncRequestId: null },
        });
      }
      if (url.startsWith(`${API}/logs`)) return Response.json({ ok: true });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await authLogin(db, { apiBaseUrl: API, username: 'verify', password: 'x' });
    const settings = await applyRemoteClientSettings({
      db,
      apiBaseUrl: API,
      clientId: 'android-test-id',
      version: '0.0.1-android',
    });

    const hb = seen.find((u) => u.includes('/client/settings?'));
    expect(hb).toBeTruthy();
    const q = new URL(hb!).searchParams;
    expect(q.get('clientId')).toBe('android-test-id');
    expect(q.get('version')).toBe('0.0.1-android');
    expect(q.get('username')).toBe('verify');
    expect(q.get('hostname')).toBeTruthy();
    expect(q.get('platform')).toBeTruthy();

    expect(settings).toMatchObject({ updatesEnabled: false, loggingEnabled: true, loggingMode: 'dev' });
    expect(await settingsGetBoolean(db, SettingsKey.UpdatesEnabled, true)).toBe(false);
  });
});
