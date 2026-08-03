// Гейт Ф1.6: НАСТОЯЩИЙ runSync Electron-клиента целиком на android-фасаде —
// schema-совместимость (baseline), align, deep-repair, push pending-строки в
// /ledger/tx/submit, инкрементальный pull из /ledger/state/changes, применение
// изменений и курсор. Сервер фейкуется подменой globalThis.fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { runSync } from '../../../electron-app/src/main/services/syncService.js';
import { authLogin, clearSession } from '../../../electron-app/src/main/services/authService.js';
import {
  SettingsKey,
  settingsGetNumber,
} from '../../../electron-app/src/main/services/settingsStore.js';

import { createBetterSqlite3AsyncAdapter, type BetterSqlite3AsyncAdapter } from '../db/testing/betterSqlite3Adapter.js';
import { createDrizzleAsync } from '../db/drizzleAsync.js';
import { migrateSqliteAsync } from '../db/migrate.js';
import { setAndroidPlatformHooks } from '../shims/platform.js';
import { wireSyncForAndroid } from './syncWiring.js';

const API = 'http://fake-api';
const FINGERPRINT = 'b'.repeat(64);
const user = { id: 'u-1', username: 'verify', fullName: 'Verify User' };

const TYPE_ID = '11111111-1111-4111-8111-111111111111';
const LOCAL_ENTITY_ID = '44444444-4444-4444-8444-444444444444';
const SERVER_ENTITY_ID = '55555555-5555-4555-8555-555555555555';

describe('android runSync smoke (полный проход push+pull на async-фасаде)', () => {
  const realFetch = globalThis.fetch;
  let adapter: BetterSqlite3AsyncAdapter;
  let db: BetterSQLite3Database;
  let pushBodies: Array<Record<string, unknown>>;

  beforeEach(async () => {
    adapter = createBetterSqlite3AsyncAdapter(':memory:');
    await migrateSqliteAsync(adapter);
    db = createDrizzleAsync(adapter) as unknown as BetterSQLite3Database;
    setAndroidPlatformHooks({ encryptionAvailable: () => true });
    wireSyncForAndroid({ sqlite: adapter, db: createDrizzleAsync(adapter), resetLocalDatabaseFiles: async () => {} });
    pushBodies = [];

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`${API}/auth/login`)) {
        return Response.json({ ok: true, accessToken: 'at', refreshToken: 'rt', user, permissions: {} });
      }
      if (url.startsWith(`${API}/diagnostics/sync-schema`)) {
        return Response.json({ ok: true, schema: { generatedAt: 1, tables: {} } });
      }
      if (url.startsWith(`${API}/ledger/schema/snapshot`)) {
        return Response.json({
          ok: true,
          fingerprint: FINGERPRINT,
          entity_types: [{ id: TYPE_ID, code: 'engine', name: 'Двигатель', created_at: 1, updated_at: 1 }],
          attribute_defs: [],
        });
      }
      if (url.startsWith(`${API}/ledger/tx/submit`)) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        pushBodies.push(body);
        return Response.json({ ok: true, applied: (body.txs as unknown[]).length });
      }
      if (url.startsWith(`${API}/ledger/state/snapshot`)) {
        // Холодный старт (cursor=0): постраничный state-snapshot по таблицам.
        const table = new URL(url).searchParams.get('table');
        const rows =
          table === 'entities'
            ? [{ id: SERVER_ENTITY_ID, type_id: TYPE_ID, created_at: 5, updated_at: 5, deleted_at: null }]
            : table === 'entity_types'
              ? [{ id: TYPE_ID, code: 'engine', name: 'Двигатель', created_at: 1, updated_at: 1, deleted_at: null }]
              : [];
        return Response.json({ ok: true, table, rows, has_more: false, next_cursor_id: null, server_last_seq: 42 });
      }
      if (url.startsWith(`${API}/ledger/state/changes`)) {
        const since = Number(new URL(url).searchParams.get('since') ?? 0);
        if (since >= 42) {
          return Response.json({ server_cursor: since, server_last_seq: since, has_more: false, changes: [] });
        }
        return Response.json({
          server_cursor: 42,
          server_last_seq: 42,
          has_more: false,
          changes: [
            {
              table: 'entities',
              row_id: SERVER_ENTITY_ID,
              op: 'upsert',
              server_seq: 42,
              payload_json: JSON.stringify({
                id: SERVER_ENTITY_ID,
                type_id: TYPE_ID,
                created_at: 5,
                updated_at: 5,
                deleted_at: null,
              }),
            },
          ],
        });
      }
      if (url.startsWith(`${API}/logs`) || url.startsWith(`${API}/diagnostics`)) {
        return Response.json({ ok: true });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    await authLogin(db, { apiBaseUrl: API, username: 'verify', password: 'x' });
    // Локальная pending-правка, которую должен унести push.
    await adapter.run(
      `INSERT INTO entity_types (id, code, name, created_at, updated_at, sync_status) VALUES (?, 'engine', 'Двигатель', 1, 1, 'synced')`,
      [TYPE_ID],
    );
    await adapter.run(
      `INSERT INTO entities (id, type_id, created_at, updated_at, sync_status) VALUES (?, ?, 2, 2, 'pending')`,
      [LOCAL_ENTITY_ID, TYPE_ID],
    );
  });

  afterEach(async () => {
    await clearSession(db);
    await adapter.close();
    globalThis.fetch = realFetch;
  });

  it('инкрементальный проход: push уносит pending, pull применяет серверную строку, курсор сохранён', async () => {
    const result = await runSync(db, 'android-smoke-client', API);

    expect(result.error ?? null).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.pushed).toBeGreaterThan(0);
    expect(result.pulled).toBeGreaterThanOrEqual(1);
    expect(result.serverCursor).toBe(42);

    // Push реально нёс нашу строку.
    const txs = pushBodies.flatMap((b) => (b.txs as Array<Record<string, unknown>>) ?? []);
    expect(JSON.stringify(txs)).toContain(LOCAL_ENTITY_ID);

    // Локальная строка помечена synced.
    const local = await adapter.get<{ sync_status: string }>(`SELECT sync_status FROM entities WHERE id = ?`, [
      LOCAL_ENTITY_ID,
    ]);
    expect(local?.sync_status).toBe('synced');

    // Серверная строка применена.
    const pulled = await adapter.get<{ type_id: string }>(`SELECT type_id FROM entities WHERE id = ?`, [
      SERVER_ENTITY_ID,
    ]);
    expect(pulled?.type_id).toBe(TYPE_ID);

    // Курсор.
    expect(await settingsGetNumber(db, SettingsKey.LastPulledServerSeq, -1)).toBe(42);

    // Повторный прогон — идемпотентен, ничего не пушится и не тянется.
    // Повторный прогон идемпотентен: клиент может перечитать хвост с
    // перекрытием курсора (повторный upsert той же строки — не дубль),
    // pending заново не рождается, курсор стабилен.
    const second = await runSync(db, 'android-smoke-client', API);
    expect(second.ok).toBe(true);
    expect(second.pushed).toBe(0);
    expect(second.serverCursor).toBe(42);
    const entityCount = await adapter.get<{ c: number }>(`SELECT COUNT(*) AS c FROM entities`);
    expect(entityCount?.c).toBe(2); // локальная + серверная, без дублей
    const entityStill = await adapter.get<{ sync_status: string }>(`SELECT sync_status FROM entities WHERE id = ?`, [
      LOCAL_ENTITY_ID,
    ]);
    expect(entityStill?.sync_status).toBe('synced');
  });
});
