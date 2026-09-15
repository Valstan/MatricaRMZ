import { describe, expect, it, vi } from 'vitest';

// Занятый синк отвечал результатом ПРОШЛОГО прогона: на «синхронизируй и скажи, как прошло»
// приходило бодрое ok от работы, закончившейся раньше, чем вызывающий что-то изменил.
// Вызывающий верил и читал реплику, где его данных ещё нет (GOTCHAS M134 — дефектовка).

const state = vi.hoisted(() => ({
  runs: 0,
  release: [] as Array<() => void>,
}));

vi.mock('./syncService.js', () => ({
  runSync: vi.fn(async () => {
    state.runs += 1;
    const mine = state.runs;
    await new Promise<void>((resolve) => state.release.push(resolve));
    return { ok: true, pushed: mine, pulled: 0, serverCursor: mine };
  }),
}));

vi.mock('./engineReservationClient.js', () => ({ flushPendingEngineReservationReleases: vi.fn(async () => 0) }));
vi.mock('./settingsStore.js', () => ({ SettingsKey: { ApiBaseUrl: 'api' }, settingsGetString: vi.fn(async () => '') }));

const { SyncManager } = await import('./syncManager.js');

function make() {
  state.runs = 0;
  state.release = [];
  return new SyncManager({} as never, 'client-1', 'http://127.0.0.1:1');
}

/** Отпустить прогон, стартовавший `n`-м, и дать очереди провернуться. */
async function releaseRun(n: number) {
  for (let i = 0; i < 50 && state.release.length < n; i += 1) await Promise.resolve();
  state.release[n - 1]?.();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SyncManager.runOnce', () => {
  it('обращение во время чужого синка ждёт его и запускает свежий, а не отвечает старым результатом', async () => {
    const mgr = make();
    const first = mgr.runOnce();
    await releaseRun(0); // дать первому стартовать
    expect(state.runs).toBe(1);

    const second = mgr.runOnce();
    expect(state.runs, 'пока первый идёт, второй не стартует — параллельных синков нет').toBe(1);

    await releaseRun(1);
    expect(await first).toMatchObject({ ok: true, pushed: 1 });

    // releaseRun крутит микрозадачи, пока прогон не стартует: очередь проворачивается не
    // мгновенно, и проверять «уже стартовал» сразу после await — гонка в самом тесте.
    await releaseRun(2);
    expect(state.runs, 'после первого очередь запускает ВТОРОЙ прогон').toBe(2);
    expect(await second, 'ожидавший получил результат своего прогона, а не чужого').toMatchObject({ pushed: 2 });
  });

  it('очередь глубиной один: три обращения подряд дают один догоняющий прогон, а не три', async () => {
    const mgr = make();
    const first = mgr.runOnce();
    await releaseRun(0);

    const a = mgr.runOnce();
    const b = mgr.runOnce();
    const c = mgr.runOnce();

    await releaseRun(1);
    await first;
    await releaseRun(2);
    // Идентичность промисов не проверяем: runOnce — async-метод, он всегда оборачивает
    // очередь в новый промис. Проверяем то, ради чего очередь и заводилась, — число прогонов.
    expect(state.runs, 'всего два прогона: текущий и один догоняющий на всех ожидающих').toBe(2);
    for (const waiter of [a, b, c]) expect(await waiter, 'все ожидающие получили догоняющий прогон').toMatchObject({ pushed: 2 });
  });

  it('последовательные обращения идут своим чередом', async () => {
    const mgr = make();
    const first = mgr.runOnce();
    await releaseRun(1);
    expect(await first).toMatchObject({ pushed: 1 });

    const second = mgr.runOnce();
    await releaseRun(2);
    expect(await second).toMatchObject({ pushed: 2 });
    expect(state.runs).toBe(2);
  });
});
