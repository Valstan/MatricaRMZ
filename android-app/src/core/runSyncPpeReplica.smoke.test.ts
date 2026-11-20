// Сквозной гейт инцидента 20.11.2026: две открытые карточки СИЗ у одного
// сотрудника (спецодежда и мыло) роняли pull у ВСЕГО парка.
//
// Что было. В `ppe_issue_cards` вошёл вид карточки (`kind`, миграция 0131), но
// клиент не вез это поле в реплику — insert брал дефолт колонки ('workwear').
// Карточка по мылу вставала в реплику как ещё одна карточка по спецодежде и била
// частичный уникальный индекс открытой карточки:
// `UNIQUE constraint failed: ppe_issue_cards.employee_id, ppe_issue_cards.kind` —
// падал весь батч pull, синхронизация вставала у каждого клиента.
//
// Почему здесь, а не в electron-тестах. Это НАСТОЯЩИЙ runSync клиента целиком:
// сервер фейкуется подменой globalThis.fetch, реплика — настоящая БД клиента,
// применение строк — настоящий applyPulledChanges. Сторож `pullColumnCoverage`
// проверяет, что клиент вообще берёт `kind` из payload; этот тест проверяет, что
// законная серверная пара карточек в реплику встаёт и pull не падает.
// Сценарий тот же на планшете и на десктопе: код синхронизации у них общий.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { runSync } from '../../../electron-app/src/main/services/syncService.js';
import { authLogin, clearSession } from '../../../electron-app/src/main/services/authService.js';

import { createBetterSqlite3AsyncAdapter, type BetterSqlite3AsyncAdapter } from '../db/testing/betterSqlite3Adapter.js';
import { createDrizzleAsync } from '../db/drizzleAsync.js';
import { migrateSqliteAsync } from '../db/migrate.js';
import { setAndroidPlatformHooks } from '../shims/platform.js';
import { wireSyncForAndroid } from './syncWiring.js';

const API = 'http://fake-api';
const FINGERPRINT = 'b'.repeat(64);
const user = { id: 'u-1', username: 'verify', fullName: 'Verify User' };

const EMPLOYEE_ID = '66666666-6666-4666-8666-666666666666';
const CARD_WORKWEAR = '77777777-7777-4777-8777-777777777777';
const CARD_SOAP = '88888888-8888-4888-8888-888888888888';

/** Строка карточки в том виде, в котором её отдаёт сервер (pull-контракт). */
function cardRow(id: string, kind: 'workwear' | 'soap', seq: number) {
  return {
    id,
    employee_id: EMPLOYEE_ID,
    kind,
    opened_at: 1000 + seq,
    closed_at: null,
    created_at: 1000 + seq,
    updated_at: 1000 + seq,
    last_server_seq: seq,
    deleted_at: null,
  };
}

describe('реплика карточек СИЗ: две открытые карточки у одного сотрудника', () => {
  const realFetch = globalThis.fetch;
  let adapter: BetterSqlite3AsyncAdapter;
  let db: BetterSQLite3Database;

  beforeEach(async () => {
    adapter = createBetterSqlite3AsyncAdapter(':memory:');
    await migrateSqliteAsync(adapter);
    db = createDrizzleAsync(adapter) as unknown as BetterSQLite3Database;
    setAndroidPlatformHooks({ encryptionAvailable: () => true });
    wireSyncForAndroid({ sqlite: adapter, db: createDrizzleAsync(adapter), resetLocalDatabaseFiles: async () => {} });

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
          entity_types: [],
          attribute_defs: [],
        });
      }
      if (url.startsWith(`${API}/ledger/tx/submit`)) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return Response.json({ ok: true, applied: (body.txs as unknown[]).length });
      }
      if (url.startsWith(`${API}/ledger/state/snapshot`)) {
        const table = new URL(url).searchParams.get('table');
        // У сотрудника открыты ДВЕ карточки — по спецодежде и по мылу. Сервер
        // такую пару законно отдаёт: у него индекс по (employee_id, kind).
        const rows = table === 'ppe_issue_cards'
          ? [cardRow(CARD_WORKWEAR, 'workwear', 41), cardRow(CARD_SOAP, 'soap', 42)]
          : [];
        return Response.json({ ok: true, table, rows, has_more: false, next_cursor_id: null, server_last_seq: 42 });
      }
      if (url.startsWith(`${API}/ledger/state/changes`)) {
        const since = Number(new URL(url).searchParams.get('since') ?? 0);
        if (since >= 42) {
          return Response.json({ server_cursor: since, server_last_seq: since, has_more: false, changes: [] });
        }
        return Response.json({ server_cursor: 42, server_last_seq: 42, has_more: false, changes: [] });
      }
      if (url.startsWith(`${API}/logs`) || url.startsWith(`${API}/diagnostics`)) {
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

  it('pull не падает, а обе карточки встают в реплику со своим видом', async () => {
    const result = await runSync(db, 'ppe-replica-smoke', API);

    // Без вида карточки этот шаг падал UNIQUE-конфликтом и тянул за собой весь
    // батч: синхронизация вставала у каждого клиента.
    expect(result.error ?? null).toBeNull();
    expect(result.ok).toBe(true);

    const rows = await adapter.all<{ id: string; kind: string }>(
      `SELECT id, kind FROM ppe_issue_cards WHERE employee_id = ? ORDER BY id`,
      [EMPLOYEE_ID],
    );
    expect(rows).toEqual([
      { id: CARD_WORKWEAR, kind: 'workwear' },
      { id: CARD_SOAP, kind: 'soap' },
    ]);
  });
});
