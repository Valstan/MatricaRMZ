// Общая обвязка смоук-гейтов моста: реплика на better-sqlite3-адаптере, ядро,
// НАСТОЯЩИЙ мост (preload + register-модули), логин против фейкового сервера.
// Замокан только сервер (globalThis.fetch) и SQLite-платформа — вся цепочка
// preload → шина → register → портированные сервисы работает по-настоящему.
import { vi } from 'vitest';

import type { MatricaApi } from '@matricarmz/shared';

import { authLogin, clearSession } from '../../../../electron-app/src/main/services/authService.js';

import {
  createBetterSqlite3AsyncAdapter,
  type BetterSqlite3AsyncAdapter,
} from '../../db/testing/betterSqlite3Adapter.js';
import { setAndroidPlatformHooks } from '../../shims/platform.js';
import { bootAndroidCore, type AndroidCore } from '../boot.js';
import { installAndroidBridge } from '../ipcWiring.js';

export const API = 'http://fake-api';
export const ENGINE_TYPE_ID = '11111111-1111-4111-8111-111111111111';
export const ENGINE_NUMBER_DEF_ID = '22222222-2222-4222-8222-222222222222';

const USER = { id: 'u-1', username: 'verify', fullName: 'Verify User', role: 'admin' };

/** Права цехового мастера: рамка Ф2 (двигатели/дефектовка) + Ф3 (наряды, склад). */
export const PERMS: Record<string, boolean> = {
  'engines.view': true,
  'engines.edit': true,
  'operations.view': true,
  'operations.edit': true,
  'masterdata.view': true,
  'employees.view': true,
  'work_orders.view': true,
  'work_orders.create': true,
  'work_orders.edit': true,
  'erp.documents.view': true,
  'erp.documents.edit': true,
  'erp.documents.post': true,
};

export type BridgeHarness = {
  adapter: BetterSqlite3AsyncAdapter;
  core: AndroidCore;
  /** Мост здесь — настоящий preload, и его форму описывает контракт MatricaApi
   *  (сверен с preload 2026-08-03: drafts/maintenance/access/tools и хвосты). */
  matrica: () => MatricaApi;
  /** Ответы фейкового сервера сверх базовых (login/health) — по префиксу URL. */
  dispose: () => Promise<void>;
};

export type HarnessOptions = {
  /** Доп. маршруты фейкового сервера: вернуть Response или null «не мой URL». */
  routes?: (url: string, init?: RequestInit) => Response | null;
  /** Сервер недоступен (кроме логина) — для проверки офлайн-путей. */
  offlineAfterLogin?: boolean;
};

export async function startBridgeHarness(opts: HarnessOptions = {}): Promise<BridgeHarness> {
  const realFetch = globalThis.fetch;
  const adapter = createBetterSqlite3AsyncAdapter(':memory:');
  setAndroidPlatformHooks({ encryptionAvailable: () => true, appVersion: () => '0.0.1-test' });

  let loggedIn = false;
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${API}/auth/login`)) {
      loggedIn = true;
      return Response.json({ ok: true, accessToken: 'at', refreshToken: 'rt', user: USER, permissions: PERMS });
    }
    const extra = opts.routes?.(url, init);
    if (extra) return extra;
    if (opts.offlineAfterLogin && loggedIn) throw new Error('offline');
    if (url.startsWith(`${API}/health`)) return Response.json({ ok: true, version: '0.0.1-test' });
    return Response.json({ ok: true });
  }) as typeof fetch;

  const core = await bootAndroidCore({
    sqlite: adapter,
    defaultApiBaseUrl: API,
    resetLocalDatabaseFiles: async () => {},
  });
  await installAndroidBridge(core);
  await authLogin(core.serviceDb, { apiBaseUrl: API, username: 'verify', password: 'x' });

  // Минимальный seed мастерданных (на живом клиенте приходит sync-ом).
  await adapter.run(
    `INSERT INTO entity_types (id, code, name, created_at, updated_at, sync_status) VALUES (?, 'engine', 'Двигатель', 1, 1, 'synced')`,
    [ENGINE_TYPE_ID],
  );
  await adapter.run(
    `INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at, sync_status)
     VALUES (?, ?, 'engine_number', 'Номер', 'text', 1, 1, 'synced')`,
    [ENGINE_NUMBER_DEF_ID, ENGINE_TYPE_ID],
  );

  return {
    adapter,
    core,
    matrica: (): MatricaApi => (globalThis as unknown as { matrica: MatricaApi }).matrica,
    dispose: async () => {
      await clearSession(core.serviceDb);
      await adapter.close();
      globalThis.fetch = realFetch;
    },
  };
}
