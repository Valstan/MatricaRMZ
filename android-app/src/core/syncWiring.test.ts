// Гейт обвязки Ф1.4: НАСТОЯЩИЙ syncService Electron-клиента (alignSchemaWithServer —
// end-to-end путь fetchAuthed + сессия + executor-транзакция + remap) исполняется
// на android-фасаде БД. Сервер фейкуется подменой globalThis.fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  alignSchemaWithServer,
  resetSyncState,
} from '../../../electron-app/src/main/services/syncService.js';
import { authLogin, clearSession } from '../../../electron-app/src/main/services/authService.js';
import {
  SettingsKey,
  settingsGetString,
} from '../../../electron-app/src/main/services/settingsStore.js';

import { createBetterSqlite3AsyncAdapter, type BetterSqlite3AsyncAdapter } from '../db/testing/betterSqlite3Adapter.js';
import { createDrizzleAsync } from '../db/drizzleAsync.js';
import { migrateSqliteAsync } from '../db/migrate.js';
import { setAndroidPlatformHooks } from '../shims/platform.js';
import { wireSyncForAndroid } from './syncWiring.js';

const API = 'http://fake-api';
const FINGERPRINT = 'a'.repeat(64);
const user = { id: 'u-1', username: 'verify', fullName: 'Verify User' };

const schemaSnapshot = {
  ok: true,
  fingerprint: FINGERPRINT,
  entity_types: [
    { id: '11111111-1111-4111-8111-111111111111', code: 'engine', name: 'Двигатель', created_at: 1, updated_at: 1 },
  ],
  attribute_defs: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      entity_type_id: '11111111-1111-4111-8111-111111111111',
      code: 'stamp_number',
      name: 'Номер клейма',
      data_type: 'text',
      is_required: 0,
      sort_order: 1,
      created_at: 1,
      updated_at: 1,
    },
  ],
};

describe('android sync wiring: настоящий alignSchemaWithServer на async-фасаде', () => {
  let adapter: BetterSqlite3AsyncAdapter;
  let db: BetterSQLite3Database;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    adapter = createBetterSqlite3AsyncAdapter(':memory:');
    await migrateSqliteAsync(adapter);
    db = createDrizzleAsync(adapter) as unknown as BetterSQLite3Database;
    setAndroidPlatformHooks({ encryptionAvailable: () => true });
    wireSyncForAndroid({
      sqlite: adapter,
      db: createDrizzleAsync(adapter),
      resetLocalDatabaseFiles: async () => {},
    });

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith(`${API}/auth/login`)) {
        return Response.json({ ok: true, accessToken: 'at', refreshToken: 'rt', user, permissions: {} });
      }
      if (url.startsWith(`${API}/ledger/schema/snapshot`)) {
        return Response.json(schemaSnapshot);
      }
      if (url.startsWith(`${API}/logs`)) {
        return Response.json({ ok: true });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    await authLogin(db, { apiBaseUrl: API, username: 'verify', password: 'x' });
  });

  afterEach(async () => {
    await clearSession(db);
    await adapter.close();
    globalThis.fetch = realFetch;
  });

  it('align применяет серверные типы/атрибуты через executor-транзакцию и пишет fingerprint', async () => {
    const res = await alignSchemaWithServer(db, API);
    expect(res).toEqual({ ok: true, fingerprint: FINGERPRINT });

    const types = await adapter.all<{ id: string; code: string }>(`SELECT id, code FROM entity_types`);
    expect(types).toEqual([{ id: '11111111-1111-4111-8111-111111111111', code: 'engine' }]);
    const defs = await adapter.all<{ code: string }>(`SELECT code FROM attribute_defs`);
    expect(defs).toEqual([{ code: 'stamp_number' }]);
    expect(await settingsGetString(db, SettingsKey.SyncSchemaFingerprint)).toBe(FINGERPRINT);
  });

  it('align ремапит локальный id типа на серверный (remap-хелперы через executor)', async () => {
    await adapter.run(
      `INSERT INTO entity_types (id, code, name, created_at, updated_at, sync_status) VALUES (?, 'engine', 'Двигатель', 1, 1, 'pending')`,
      ['33333333-3333-4333-8333-333333333333'],
    );
    await adapter.run(
      `INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('e-1', ?, 1, 1)`,
      ['33333333-3333-4333-8333-333333333333'],
    );

    const res = await alignSchemaWithServer(db, API);
    expect(res.ok).toBe(true);

    const entity = await adapter.get<{ type_id: string }>(`SELECT type_id FROM entities WHERE id = 'e-1'`);
    expect(entity?.type_id).toBe('11111111-1111-4111-8111-111111111111');
    const types = await adapter.all<{ id: string }>(`SELECT id FROM entity_types`);
    expect(types).toEqual([{ id: '11111111-1111-4111-8111-111111111111' }]);
  });

  it('resetSyncState обнуляет курсоры через settingsStore на proxy-БД', async () => {
    await resetSyncState(db);
    const row = await adapter.get<{ value: string }>(`SELECT value FROM sync_state WHERE key = 'lastPulledServerSeq'`);
    expect(row?.value).toBe('0');
  });
});
