import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Прокси — единственное место, которое знает, что движок синка живёт в другом
// процессе. Проверяются не внутренности, а обещания, на которых держатся вызывающие:
//   • `runOnce` отвечает результатом прогона, а не зависает, если процесс упал;
//   • упавший процесс поднимается сам (иначе автосинк тихо умирает до перезапуска
//     приложения — оператор этого не заметит);
//   • `releaseDatabase` закрывает соединение и НЕ поднимает процесс обратно, иначе
//     файл базы удалить нельзя (reset-флоу «Пересоздать базу»).
const session = vi.hoisted(() => ({
  read: vi.fn(async () => ({
    accessToken: 'at',
    canRefresh: true,
    userId: 'u1',
    username: 'oper',
  })),
  refresh: vi.fn(async () => ({ ok: true as const, accessToken: 'at2' })),
  clear: vi.fn(async () => {}),
}));

vi.mock('./syncSession.js', () => ({
  readSyncSession: session.read,
  refreshSyncSession: session.refresh,
  clearSyncSession: session.clear,
}));

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

import { setSyncHost, resetSyncHost } from './syncHost.js';
import { SyncProxy } from './syncProxy.js';

type Posted = Record<string, unknown> & { type: string };

class FakeChild {
  readonly posted: Posted[] = [];
  readonly handlers = new Map<string, Array<(arg: unknown) => void>>();
  killed = false;
  /** Отвечать ли на `init` готовностью — как настоящий воркер. */
  answerInit = true;

  on(event: string, handler: (arg: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  postMessage(message: Posted): void {
    this.posted.push(message);
    if (message.type === 'init' && this.answerInit) this.emit('message', { type: 'ready' });
  }

  kill(): void {
    this.killed = true;
    this.emit('exit', 0);
  }

  emit(event: string, arg: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(arg);
  }

  /**
   * Так выглядит канал со стороны main: `UtilityProcess` отдаёт САМО сообщение.
   * В воркере та же переписка приходит обёрткой `MessageEvent` (`event.data`) —
   * поэтому фейк обязан повторять именно родительскую сторону, иначе тест
   * закрепляет неверный контракт и пропускает мёртвый канал (поймано на 3.94.0).
   */
  fromWorker(message: Record<string, unknown>): void {
    this.emit('message', message);
  }
}

function makeProxy(children: FakeChild[], overrides: { autoSyncMs?: number | null } = {}) {
  let index = 0;
  const logs: string[] = [];
  const progress: unknown[] = [];
  const proxy = new SyncProxy({
    db: {} as never,
    clientId: 'client-1',
    apiBaseUrl: 'http://127.0.0.1:1',
    dbPath: '/tmp/matricarmz.sqlite',
    dbKey: 'key',
    autoSyncMs: overrides.autoSyncMs ?? null,
    workerPath: '/app/dist/main/syncWorker.js',
    onProgress: (payload) => progress.push(payload),
    log: (line) => logs.push(line),
    fork: () => {
      const child = children[index];
      index += 1;
      if (!child) throw new Error('unexpected extra spawn');
      return child as never;
    },
  });
  return { proxy, logs, progress };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const RUN_RESULT = { ok: true, pushed: 1, pulled: 2, serverCursor: 7 };

afterEach(() => {
  vi.useRealTimers();
  resetSyncHost();
});

beforeEach(() => {
  session.read.mockClear();
  setSyncHost({
    userDataPath: () => 'C:/userData',
    appVersion: () => '3.93.0',
    relaunch: () => {},
    exit: () => {},
    appendLog: () => {},
  });
});

describe('прокси движка синка', () => {
  it('передаёт воркеру каталог, версию и параметры запуска', () => {
    const child = new FakeChild();
    makeProxy([child]);
    const init = child.posted.find((m) => m.type === 'init');
    expect(init).toMatchObject({
      dbPath: '/tmp/matricarmz.sqlite',
      dbKey: 'key',
      userDataPath: 'C:/userData',
      appVersion: '3.93.0',
      clientId: 'client-1',
      apiBaseUrl: 'http://127.0.0.1:1',
    });
  });

  it('ручной прогон возвращает результат прогона из воркера', async () => {
    const child = new FakeChild();
    const { proxy } = makeProxy([child]);

    const run = proxy.runOnce();
    await tick();
    const request = child.posted.find((m) => m.type === 'run');
    expect(request).toBeDefined();
    child.fromWorker({ type: 'runResult', reqId: request!.reqId, result: RUN_RESULT });

    await expect(run).resolves.toEqual(RUN_RESULT);
  });

  it('прогресс идёт в окна мимо воркера, а статус — из его кэша', async () => {
    const child = new FakeChild();
    const { proxy, progress } = makeProxy([child]);

    child.fromWorker({ type: 'progress', payload: { state: 'progress', progress: 40 } });
    expect(progress).toEqual([{ state: 'progress', progress: 40 }]);

    const nextAutoSyncAt = Date.now() + 30_000;
    child.fromWorker({
      type: 'status',
      status: {
        state: 'syncing',
        lastSyncAt: 1,
        lastError: null,
        lastResult: RUN_RESULT,
        nextAutoSyncAt,
        apiBaseUrl: 'http://server',
      },
    });
    const status = proxy.getStatus();
    expect(status.state).toBe('syncing');
    expect(status.nextAutoSyncInMs).toBeGreaterThan(20_000);
    expect(proxy.getApiBaseUrl()).toBe('http://server');
  });

  it('упавший процесс поднимается сам, а прогон не зависает', async () => {
    vi.useFakeTimers();
    const first = new FakeChild();
    const second = new FakeChild();
    const { proxy } = makeProxy([first, second]);

    const run = proxy.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    first.emit('exit', 9);

    await expect(run).resolves.toMatchObject({ ok: false, error: 'sync worker exited' });
    expect(proxy.getStatus().state).toBe('error');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.posted.some((m) => m.type === 'init')).toBe(true);
    expect(proxy.getStatus().state).toBe('idle');
  });

  it('вопрос о сессии уходит в просящий процесс и возвращается ответом', async () => {
    const child = new FakeChild();
    makeProxy([child]);

    child.fromWorker({ type: 'session:read', callId: 'c1' });
    await tick();

    expect(session.read).toHaveBeenCalledTimes(1);
    expect(child.posted).toContainEqual({
      type: 'session:read:result',
      callId: 'c1',
      session: { accessToken: 'at', canRefresh: true, userId: 'u1', username: 'oper' },
    });
  });

  it('releaseDatabase закрывает соединение и больше не поднимает воркер', async () => {
    const child = new FakeChild();
    const { proxy, logs } = makeProxy([child]);

    const release = proxy.releaseDatabase();
    await tick();
    expect(child.posted.some((m) => m.type === 'close')).toBe(true);
    child.fromWorker({ type: 'closed' });
    await release;

    // Файл базы после закрытия удаляется — новый воркер открыл бы уже удалённый файл
    // и родил бы пустую реплику (или упал на ключе).
    const refused = await proxy.runOnce();
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('released its database');
    expect(logs.join('\n')).not.toContain('restart in');
  });

  it('stopAuto не гасит процесс: движок ещё нужен ручному прогону', async () => {
    const child = new FakeChild();
    const { proxy } = makeProxy([child], { autoSyncMs: 60_000 });

    proxy.stopAuto();
    expect(child.posted.some((m) => m.type === 'stopAuto')).toBe(true);
    expect(child.killed).toBe(false);
  });
});
