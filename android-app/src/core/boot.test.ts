// Гейт Ф1.7: полный холодный старт android-ядра одним вызовом — миграции,
// обвязка, clientId, SyncManager.runOnce (настоящий runSync через менеджер,
// как это будет на планшете). Сервер фейкуется как в runSync.smoke.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authLogin, clearSession } from '../../../electron-app/src/main/services/authService.js';

import { createBetterSqlite3AsyncAdapter, type BetterSqlite3AsyncAdapter } from '../db/testing/betterSqlite3Adapter.js';
import { setAndroidPlatformHooks } from '../shims/platform.js';
import { bootAndroidCore, type AndroidCore } from './boot.js';

const API = 'http://fake-api';
const FINGERPRINT = 'c'.repeat(64);
const user = { id: 'u-1', username: 'verify', fullName: 'Verify User' };
const TYPE_ID = '11111111-1111-4111-8111-111111111111';

describe('android boot: холодный старт ядра', () => {
  const realFetch = globalThis.fetch;
  let adapter: BetterSqlite3AsyncAdapter;
  let core: AndroidCore;

  beforeEach(async () => {
    adapter = createBetterSqlite3AsyncAdapter(':memory:');
    setAndroidPlatformHooks({
      encryptionAvailable: () => true,
      appVersion: () => '0.0.1-android-test',
      deviceName: () => 'digma-odyssey',
    });

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith(`${API}/auth/login`)) {
        return Response.json({ ok: true, accessToken: 'at', refreshToken: 'rt', user, permissions: {} });
      }
      if (url.startsWith(`${API}/diagnostics/sync-schema`)) {
        return Response.json({ ok: true, schema: { generatedAt: 1, tables: {} } });
      }
      if (url.startsWith(`${API}/ledger/schema/snapshot`)) {
        return Response.json({ ok: true, fingerprint: FINGERPRINT, entity_types: [], attribute_defs: [] });
      }
      if (url.startsWith(`${API}/ledger/tx/submit`)) {
        return Response.json({ ok: true, applied: 0 });
      }
      if (url.startsWith(`${API}/ledger/state/snapshot`)) {
        const table = new URL(url).searchParams.get('table');
        const rows =
          table === 'entity_types'
            ? [{ id: TYPE_ID, code: 'engine', name: 'Двигатель', created_at: 1, updated_at: 1, deleted_at: null }]
            : [];
        return Response.json({ ok: true, table, rows, has_more: false, next_cursor_id: null, server_last_seq: 7 });
      }
      if (url.startsWith(`${API}/ledger/state/changes`)) {
        return Response.json({ server_cursor: 7, server_last_seq: 7, has_more: false, changes: [] });
      }
      if (url.startsWith(`${API}/logs`) || url.startsWith(`${API}/diagnostics`)) {
        return Response.json({ ok: true });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    await clearSession(core.serviceDb).catch(() => {});
    await adapter.close();
    globalThis.fetch = realFetch;
  });

  it('boot мигрирует БД, даёт clientId и рабочий SyncManager.runOnce', async () => {
    core = await bootAndroidCore({
      sqlite: adapter,
      defaultApiBaseUrl: API,
      resetLocalDatabaseFiles: async () => {},
    });

    expect(core.clientId).toMatch(/^[\w.-]{1,64}-[0-9a-f-]{36}$/i);
    expect(core.apiBaseUrl).toBe(API);
    // apiBaseUrl персистнулся — следующий boot возьмёт его из БД.
    const row = await adapter.get<{ value: string }>(`SELECT value FROM sync_state WHERE key = 'apiBaseUrl'`);
    expect(row?.value).toBe(API);
    expect(core.syncManager.getStatus().state).toBe('idle');

    await authLogin(core.serviceDb, { apiBaseUrl: API, username: 'verify', password: 'x' });
    const result = await core.syncManager.runOnce();
    expect(result.ok).toBe(true);

    const pulledType = await adapter.get<{ code: string }>(`SELECT code FROM entity_types WHERE id = ?`, [TYPE_ID]);
    expect(pulledType?.code).toBe('engine');
    const status = core.syncManager.getStatus();
    expect(status.state).toBe('idle');
    expect(status.lastSyncAt).toBeTruthy();
  });

  it('без логина SyncManager честно отказывает (auth required), не падая', async () => {
    core = await bootAndroidCore({
      sqlite: adapter,
      defaultApiBaseUrl: API,
      resetLocalDatabaseFiles: async () => {},
    });
    const result = await core.syncManager.runOnce();
    expect(result.ok).toBe(false);
    expect(String(result.error ?? '')).toContain('auth required');
  });
});
