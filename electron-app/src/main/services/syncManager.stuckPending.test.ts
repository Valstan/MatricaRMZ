/**
 * Локальный сторож — единственное место на клиенте, которое живёт **между**
 * прогонами синка. Если очередь застряла, а цикл синка висит (или упал),
 * сервер должен всё равно узнать про очередь: иначе класс невидим и
 * автолечение (`diagnosticsAutohealService`) не сработает.
 *
 * Инцидент 25.11.2026: android-парк не прислал ни одного снимка
 * `scope='client'` — тревога доходила только потому, что оператор жал кнопку.
 */
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stuck: { count: 0, oldestPendingAt: null as number | null, byTable: [] as any[] },
  snapshots: 0,
}));

vi.mock('./syncService.js', () => ({
  countPendingLocalChanges: vi.fn(async () => 0),
  countPendingLocalChangesByTable: vi.fn(async () => []),
  countStuckPendingLocalChanges: vi.fn(async () => state.stuck),
  hasActiveSession: vi.fn(async () => true),
  readLastPulledServerSeq: vi.fn(async () => 0),
  runSync: vi.fn(async () => ({ ok: true, pushed: 0, pulled: 0, serverCursor: 0 })),
  sendDiagnosticsSnapshotNow: vi.fn(async () => {
    state.snapshots += 1;
  }),
  waitForServerChanges: vi.fn(async () => ({ ok: true, unsupported: false, status: null, error: null })),
}));

vi.mock('./engineReservationClient.js', () => ({ flushPendingEngineReservationReleases: vi.fn(async () => 0) }));
vi.mock('./settingsStore.js', () => ({ SettingsKey: { ApiBaseUrl: 'api' }, settingsGetString: vi.fn(async () => '') }));
vi.mock('./logService.js', () => ({ logPerfWarn: vi.fn() }));

const { SyncManager } = await import('./syncManager.js');

function make() {
  state.snapshots = 0;
  return new SyncManager({} as never, 'client-1', 'http://127.0.0.1:1');
}

async function probeStuck(mgr: unknown) {
  await (mgr as any).refreshStuckPending();
}

/** Промисы сторожа fire-and-forget — дожидаемся, пока микротаски разбегутся. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SyncManager: застрявшая очередь видна серверу', () => {
  it('при застрявшей очереди снимок диагностики уходит на сервер', async () => {
    state.stuck = { count: 5, oldestPendingAt: 1, byTable: [] };
    const mgr = make();
    await probeStuck(mgr);
    expect(state.snapshots).toBe(1);
  });

  it('проба и снимок идут даже во время прогона синка — иначе на висящем pull их нет', async () => {
    // Инцидент 25.11.2026: pull на планшете шёл и 38 минут, а снимок уходил только
    // после него — сервер не видел очередь всё это время.
    state.stuck = { count: 5, oldestPendingAt: 1, byTable: [] };
    const mgr = make();
    (mgr as any).inFlight = true;
    await (mgr as any).localWatchTick();
    await flush();
    expect(state.snapshots).toBe(1);
  });

  it('при пустой очереди снимок не шлём — лишний трафик ни к чему', async () => {
    state.stuck = { count: 0, oldestPendingAt: null, byTable: [] };
    const mgr = make();
    await probeStuck(mgr);
    expect(state.snapshots).toBe(0);
  });
});
