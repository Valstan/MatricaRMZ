/**
 * Причина отказа не должна теряться (инцидент 26.11.2026, машина PC20).
 *
 * Офлайн-ошибку `lastError` обнуляет: машина не в сети — это не поломка, и красный
 * статус в интерфейсе не нужен. Но в отчёте администратору строка «Ошибка синка» не
 * должна молчать: без причины тревога бесполезна (в том инциденте её не было вовсе —
 * администратор получил «последний успешный синк: не было» и ни одного слова о том,
 * что строки на сервере уже есть).
 *
 * Второе правило того же инцидента: «последний успешный синк» должен переживать
 * перезапуск программы ⇒ время успешного прогона пишется в базу, а не живёт в памяти.
 */
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  result: { ok: true, pushed: 0, pulled: 0, serverCursor: 0 } as any,
  setNumber: [] as Array<[string, number]>,
}));

vi.mock('./syncService.js', () => ({
  countPendingLocalChanges: vi.fn(async () => 0),
  countPendingLocalChangesByTable: vi.fn(async () => []),
  countStuckPendingLocalChanges: vi.fn(async () => ({ count: 0, oldestPendingAt: null, byTable: [] })),
  hasActiveSession: vi.fn(async () => true),
  readLastPulledServerSeq: vi.fn(async () => 0),
  runSync: vi.fn(async () => state.result),
  sendDiagnosticsSnapshotNow: vi.fn(async () => {}),
  waitForServerChanges: vi.fn(async () => ({ ok: true, unsupported: false, status: null, error: null })),
}));

vi.mock('./engineReservationClient.js', () => ({ flushPendingEngineReservationReleases: vi.fn(async () => 0) }));
vi.mock('./settingsStore.js', () => ({
  SettingsKey: { ApiBaseUrl: 'api', LastSuccessfulSyncAt: 'sync.lastSuccessfulSyncAt' },
  settingsGetString: vi.fn(async () => ''),
  settingsSetNumber: vi.fn(async (_db: unknown, key: string, value: number) => {
    state.setNumber.push([key, value]);
  }),
}));
vi.mock('./logService.js', () => ({ logPerfWarn: vi.fn() }));

const { SyncManager } = await import('./syncManager.js');

function make() {
  state.setNumber = [];
  return new SyncManager({} as never, 'client-1', 'http://127.0.0.1:1');
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('причина отказа в отчёте администратору', () => {
  it('офлайн-ошибка не поломка — lastError пуст, но причина остаётся', async () => {
    state.result = {
      ok: false,
      pushed: 0,
      pulled: 0,
      serverCursor: 0,
      error: 'нужна сеть: сервер не отвечает',
    };
    const mgr = make();
    await mgr.runOnce();
    const status = mgr.getStatus();
    expect(status.lastError, 'офлайн — не поломка, статус остаётся спокойным').toBeNull();
    expect(status.lastFailureReason, 'причина отказа в отчёте остаётся').toContain('нужна сеть');
  });

  it('ошибка не офлайн-класса попадает и в lastError, и в причину', async () => {
    state.result = {
      ok: false,
      pushed: 0,
      pulled: 0,
      serverCursor: 0,
      error: 'sync_invalid_row: attribute_values',
    };
    const mgr = make();
    await mgr.runOnce();
    const status = mgr.getStatus();
    expect(status.lastError).toContain('sync_invalid_row');
    expect(status.lastFailureReason).toContain('sync_invalid_row');
  });

  it('время последнего успешного прогона сохраняется в базе — переживает перезапуск', async () => {
    state.result = { ok: true, pushed: 1, pulled: 2, serverCursor: 5 };
    const mgr = make();
    await mgr.runOnce();
    await flush();
    expect(state.setNumber.some(([key]) => key === 'sync.lastSuccessfulSyncAt')).toBe(true);
    expect(mgr.getStatus().lastSyncAt).toBeGreaterThan(0);
  });

  it('после успеха причина отказа сбрасывается', async () => {
    state.result = { ok: false, pushed: 0, pulled: 0, serverCursor: 0, error: 'нужна сеть: молчит' };
    const mgr = make();
    await mgr.runOnce();
    expect(mgr.getStatus().lastFailureReason).toContain('нужна сеть');
    state.result = { ok: true, pushed: 0, pulled: 0, serverCursor: 0 };
    await mgr.runOnce();
    expect(mgr.getStatus().lastFailureReason).toBeNull();
  });
});
