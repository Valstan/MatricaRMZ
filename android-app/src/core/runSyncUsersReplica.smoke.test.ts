// B3/R3 — доезд реплики аккаунтов через НАСТОЯЩИЙ runSync Electron-клиента.
//
// Зачем именно так. Конвейер applyPulledChanges состоит из пяти шагов (ключ в
// groups, case в switch, dedup, upsert-блок, порядок), и пропуск ЛЮБОГО из них
// не даёт ошибки — строки просто исчезают. Живое доказательство лежит в самом
// syncService: erpEngineInstances не упомянут там ни разу, хотя сервер их
// отдаёт. Поэтому проверка — исполнением всего пути, а не чтением кода.
//
// Второй сценарий здесь дороже первого. Передача логина (снять у А, выдать Б)
// штатна, и если новый владелец приедет раньше тумбстоуна прежнего, клиентский
// апсерт упрётся в частичный users_login_live_uq, applyPulledChanges бросит
// исключение, курсор не сдвинется — машина перестанет синхронизироваться СОВСЕМ,
// повторяя ту же страницу вечно. Порядок задаёт серверный публикатор; здесь
// проверяется, что клиент этот порядок отрабатывает.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { runSync } from '../../../electron-app/src/main/services/syncService.js';
import { authLogin, clearSession } from '../../../electron-app/src/main/services/authService.js';
import { SettingsKey, settingsGetNumber } from '../../../electron-app/src/main/services/settingsStore.js';

import { createBetterSqlite3AsyncAdapter, type BetterSqlite3AsyncAdapter } from '../db/testing/betterSqlite3Adapter.js';
import { createDrizzleAsync } from '../db/drizzleAsync.js';
import { migrateSqliteAsync } from '../db/migrate.js';
import { setAndroidPlatformHooks } from '../shims/platform.js';
import { wireSyncForAndroid } from './syncWiring.js';

const API = 'http://fake-api';
const FINGERPRINT = 'c'.repeat(64);
const user = { id: 'u-1', username: 'verify', fullName: 'Verify User' };

const TYPE_ID = '11111111-1111-4111-8111-111111111111';
const DONOR_ID = '22222222-2222-4222-8222-222222222222';
const HEIR_ID = '33333333-3333-4333-8333-333333333333';
const SECTION_ROW_ID = '66666666-6666-4666-8666-666666666666';

/** Строка users в форме sync-DTO (snake_case), как её отдаёт сервер. */
function userRow(over: Record<string, unknown>) {
  return {
    id: DONOR_ID,
    login: 'oper1',
    system_role: 'master',
    access_enabled: true,
    delete_requested_at: null,
    delete_requested_by: null,
    created_at: 10,
    updated_at: 10,
    deleted_at: null,
    ...over,
  };
}

function change(table: string, rowId: string, seq: number, payload: Record<string, unknown>) {
  return {
    table,
    row_id: rowId,
    op: payload['deleted_at'] ? 'delete' : 'upsert',
    server_seq: seq,
    // Настоящий сервер кладёт seq и В САМУ СТРОКУ (writeSyncChanges штампует его
    // до записи), а клиент читает его именно оттуда — не из конверта изменения.
    payload_json: JSON.stringify({ ...payload, last_server_seq: seq }),
  };
}

describe('B3/R3: реплика аккаунтов доезжает через настоящий runSync', () => {
  const realFetch = globalThis.fetch;
  let adapter: BetterSqlite3AsyncAdapter;
  let db: BetterSQLite3Database;
  // Две независимые поверхности доставки, у каждой своя PG-карта на сервере, и
  // они уже расходились в этом проекте (erp_engine_instances молча терялась при
  // холодной пересборке). Поэтому в тестах ниже задействованы обе.
  let snapshotRows: Record<string, Array<Record<string, unknown>>> = {};
  let changes: Array<Record<string, unknown>> = [];
  let serverLastSeq = 100;

  beforeEach(async () => {
    adapter = createBetterSqlite3AsyncAdapter(':memory:');
    await migrateSqliteAsync(adapter);
    db = createDrizzleAsync(adapter) as unknown as BetterSQLite3Database;
    setAndroidPlatformHooks({ encryptionAvailable: () => true });
    wireSyncForAndroid({ sqlite: adapter, db: createDrizzleAsync(adapter), resetLocalDatabaseFiles: async () => {} });

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
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
        return Response.json({ ok: true, applied: 0 });
      }
      if (url.startsWith(`${API}/ledger/state/snapshot`)) {
        const table = String(new URL(url).searchParams.get('table') ?? '');
        return Response.json({
          ok: true,
          table,
          rows: snapshotRows[table] ?? [],
          has_more: false,
          next_cursor_id: null,
          server_last_seq: serverLastSeq,
        });
      }
      if (url.startsWith(`${API}/ledger/state/changes`)) {
        const since = Number(new URL(url).searchParams.get('since') ?? 0);
        if (since >= serverLastSeq) {
          return Response.json({ server_cursor: since, server_last_seq: since, has_more: false, changes: [] });
        }
        return Response.json({ server_cursor: serverLastSeq, server_last_seq: serverLastSeq, has_more: false, changes });
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

  const SECTION_ROW = {
    id: SECTION_ROW_ID,
    user_id: DONOR_ID,
    section_id: 'work_orders',
    level: 'editor',
    created_at: 10,
    updated_at: 10,
    deleted_at: null,
    last_server_seq: 91,
  };

  /** Догоняет клиента до курсора, чтобы следующий прогон пошёл ИНКРЕМЕНТАЛЬНО. */
  async function primeCursor() {
    const first = await runSync(db, 'users-replica-smoke', API);
    expect(first.ok).toBe(true);
  }

  it('ХОЛОДНЫЙ старт: аккаунт и его доступ приезжают снапшотом', async () => {
    // Это путь свежей установки. Здесь работает вторая PG-карта сервера
    // (routes/ledger.ts): её пропуск не давал бы ошибки — реплика просто
    // осталась бы пустой, и офлайн-гейт увидел бы «никого нет».
    snapshotRows = {
      users: [{ ...userRow({}), last_server_seq: 90 }],
      user_section_access: [SECTION_ROW],
    };

    const result = await runSync(db, 'users-replica-smoke', API);
    expect(result.error ?? null).toBeNull();
    expect(result.ok).toBe(true);

    const u = await adapter.get<{ login: string; system_role: string; access_enabled: number; last_server_seq: number }>(
      `SELECT login, system_role, access_enabled, last_server_seq FROM users WHERE id = ?`,
      [DONOR_ID],
    );
    expect(u?.login).toBe('oper1');
    expect(u?.system_role).toBe('master');
    // Сервер отдаёт boolean, SQLite хранит 0/1 — если бы приведение потерялось,
    // строка 'false' стала бы истиной, и доступ открылся бы отключённому аккаунту.
    expect(u?.access_enabled).toBe(1);
    // На холодном снапшоте клиент штампует строкам seq САМОГО СНАПШОТА, а не
    // тот, что лежал в строке: снапшот — срез на момент server_last_seq.
    expect(Number(u?.last_server_seq)).toBe(100);

    const s = await adapter.get<{ level: string; user_id: string }>(
      `SELECT level, user_id FROM user_section_access WHERE id = ?`,
      [SECTION_ROW_ID],
    );
    expect(s?.level).toBe('editor');
    expect(s?.user_id).toBe(DONOR_ID);

    expect(await settingsGetNumber(db, SettingsKey.LastPulledServerSeq, -1)).toBe(100);
  });

  it('ИНКРЕМЕНТАЛЬНЫЙ доезд: изменение аккаунта приходит страницей изменений', async () => {
    // Это путь работающей машины и главная цель R3: без seq у строки зеркала
    // эта страница не привезла бы её НИКОГДА, а холодный снапшот при этом
    // продолжал бы создавать впечатление рабочего синка.
    await primeCursor();

    serverLastSeq = 200;
    changes = [change('users', DONOR_ID, 190, userRow({ system_role: 'viewer', updated_at: 50 }))];

    const result = await runSync(db, 'users-replica-smoke', API);
    expect(result.error ?? null).toBeNull();
    expect(result.ok).toBe(true);

    const u = await adapter.get<{ system_role: string; last_server_seq: number }>(
      `SELECT system_role, last_server_seq FROM users WHERE id = ?`,
      [DONOR_ID],
    );
    expect(u?.system_role).toBe('viewer');
    expect(Number(u?.last_server_seq)).toBe(190);
    expect(await settingsGetNumber(db, SettingsKey.LastPulledServerSeq, -1)).toBe(200);
  });

  it('выключённый доступ приезжает как 0, а не как истина', async () => {
    snapshotRows = { users: [{ ...userRow({ access_enabled: false }), last_server_seq: 90 }] };
    const result = await runSync(db, 'users-replica-smoke', API);
    expect(result.ok).toBe(true);
    const u = await adapter.get<{ access_enabled: number }>(`SELECT access_enabled FROM users WHERE id = ?`, [DONOR_ID]);
    expect(u?.access_enabled).toBe(0);
  });

  it('передача логина: тумбстоун и новый владелец в одной странице не роняют синк', async () => {
    await primeCursor();
    serverLastSeq = 200;
    // Порядок именно такой, какой обязан выдать публикатор: сначала погашение
    // прежнего владельца, потом выдача логина новому. Если клиент это применит
    // неверно, он упрётся в частичный unique логина и встанет навсегда.
    changes = [
      change('users', DONOR_ID, 190, userRow({ deleted_at: 200, updated_at: 200, access_enabled: false })),
      change('users', HEIR_ID, 191, userRow({ id: HEIR_ID, login: 'oper1', updated_at: 201 })),
    ];

    const result = await runSync(db, 'users-replica-smoke', API);
    expect(result.error ?? null).toBeNull();
    expect(result.ok).toBe(true);

    const live = await adapter.all<{ id: string }>(`SELECT id FROM users WHERE deleted_at IS NULL`);
    expect(live.map((r) => r.id)).toEqual([HEIR_ID]);

    const donor = await adapter.get<{ deleted_at: number | null }>(`SELECT deleted_at FROM users WHERE id = ?`, [
      DONOR_ID,
    ]);
    expect(donor?.deleted_at).toBe(200);

    // Курсор сдвинулся — значит исключения не было и машина продолжит синк.
    expect(await settingsGetNumber(db, SettingsKey.LastPulledServerSeq, -1)).toBe(200);
  });
});
