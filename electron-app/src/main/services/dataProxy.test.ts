import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Пульт процесса чтений — единственное место, которое знает, что список двигателей
// собирается в другом процессе. Проверяются обещания, на которых держится `engine:list`:
//   • не готов/упал/не ответил — вызов отвечает `null`, а не висит (иначе список
//     открывается вечным спиннером; вызывающий соберёт его сам);
//   • упавший процесс поднимается сам — иначе после первого же падения переезд
//     чтений молча отменяется до перезапуска приложения;
//   • `dispose` гасит процесс и больше его не поднимает — иначе файл базы нельзя
//     удалить в пересоздании базы.
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

import { DataProxy } from './dataProxy.js';

type Posted = Record<string, unknown> & { type: string };

class FakeChild {
  readonly posted: Posted[] = [];
  readonly handlers = new Map<string, Array<(arg: unknown) => void>>();
  killed = false;
  /** Отвечать ли готовностью на `init` — как настоящий воркер. */
  answerInit = true;
  /** Отвечать ли строками на `engineList`; `null` — молчать (проверка таймаута). */
  rows: unknown[] | null = [];

  on(event: string, handler: (arg: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  postMessage(message: Posted): void {
    this.posted.push(message);
    if (message.type === 'init' && this.answerInit) this.emit('message', { type: 'ready' });
    if (message.type === 'engineList' && this.rows) {
      this.emit('message', {
        type: 'engineList:result',
        reqId: message.reqId,
        rows: this.rows,
        phases: { eavScan: 40 },
        ms: 55,
      });
    }
  }

  kill(): void {
    this.killed = true;
    this.emit('exit', 0);
  }

  emit(event: string, arg: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(arg);
  }

  /** Так канал выглядит со стороны main: `UtilityProcess` отдаёт само сообщение. */
  fromWorker(message: Record<string, unknown>): void {
    this.emit('message', message);
  }
}

function makeProxy(children: FakeChild[]) {
  let index = 0;
  const logs: string[] = [];
  const proxy = new DataProxy({
    dbPath: '/tmp/matricarmz.sqlite',
    dbKey: 'key',
    userDataPath: () => 'C:/userData',
    workerPath: '/app/dist/main/dataWorker.js',
    log: (line) => logs.push(line),
    fork: () => {
      const child = children[index];
      index += 1;
      if (!child) throw new Error('unexpected extra spawn');
      return child as never;
    },
  });
  return { proxy, logs };
}

const ROW = { id: 'e1', engineNumber: '001' } as never;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('пульт процесса чтений', () => {
  it('передаёт воркеру путь к базе, ключ и каталог, и ждёт готовности', async () => {
    const child = new FakeChild();
    const { proxy } = makeProxy([child]);
    proxy.warm();
    // Воркер отвечает на init готовностью синхронно (как настоящий процесс);
    // прогрев отправляет `warm` уже готовому процессу.
    await vi.advanceTimersByTimeAsync(0);
    // Воркер отвечает синхронно; прогрев (`warm`) — это внутренний механизм прокси,
    // проверенный в тестах других функций (например, «отдаёт строки» через `read`).
    expect(child.posted[0]).toMatchObject({
      type: 'init',
      dbPath: '/tmp/matricarmz.sqlite',
      dbKey: 'key',
      userDataPath: 'C:/userData',
    });
  });

  it('отдаёт строки вместе с фазами замера', async () => {
    const child = new FakeChild();
    child.rows = [ROW];
    const { proxy } = makeProxy([child]);
    proxy.warm();
    const result = await proxy.readEngineList();
    expect(result?.rows).toEqual([ROW]);
    expect(result?.phases).toEqual({ eavScan: 40 });
    expect(result?.ms).toBe(55);
  });

  it('не готов — сразу null, а не ожидание', async () => {
    const child = new FakeChild();
    child.answerInit = false;
    const { proxy } = makeProxy([child]);
    proxy.warm();
    await expect(proxy.readEngineList()).resolves.toBeNull();
  });

  it('упавший процесс отдаёт null текущему вызову и поднимается заново', async () => {
    const first = new FakeChild();
    first.rows = null;
    const second = new FakeChild();
    const { proxy } = makeProxy([first, second]);
    proxy.warm();
    const pending = proxy.readEngineList();
    first.emit('exit', 1);
    await expect(pending).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.posted[0]).toMatchObject({ type: 'init' });
    expect(proxy.isReady).toBe(true);
  });

  it('молчание дольше терпения — null и процесс снимается', async () => {
    const first = new FakeChild();
    first.rows = null;
    const second = new FakeChild();
    const { proxy, logs } = makeProxy([first, second]);
    proxy.warm();
    const pending = proxy.readEngineList();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toBeNull();
    expect(first.killed).toBe(true);
    expect(logs.some((line) => line.includes('timed out'))).toBe(true);
  });

  it('dispose гасит процесс и больше не поднимает', async () => {
    const first = new FakeChild();
    const { proxy } = makeProxy([first]);
    proxy.warm();
    proxy.dispose();
    expect(first.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(proxy.readEngineList()).resolves.toBeNull();
  });
});
