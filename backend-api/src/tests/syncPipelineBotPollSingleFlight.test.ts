import { describe, expect, it } from 'vitest';

import { createSingleFlightTick } from '../services/syncPipelineSupervisorService.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('single-flight tick опроса бота', () => {
  it('не запускает второй проход, пока идёт первый', async () => {
    const gate = deferred();
    let starts = 0;
    const tick = createSingleFlightTick(
      () => {
        starts += 1;
        return gate.promise;
      },
      () => undefined,
    );

    tick();
    tick();
    tick();
    expect(starts).toBe(1);

    gate.resolve();
    await gate.promise;
    await Promise.resolve();

    tick();
    expect(starts).toBe(2);
  });

  it('считает пропущенные тики и обнуляет счётчик после отчёта', async () => {
    const first = deferred();
    const second = deferred();
    const runs = [first.promise, second.promise];
    const settled: Array<{ skippedTicks: number }> = [];
    const tick = createSingleFlightTick(
      () => runs.shift() ?? Promise.resolve(),
      (info) => {
        settled.push({ skippedTicks: info.skippedTicks });
      },
    );

    tick();
    tick();
    tick();
    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(settled).toEqual([{ skippedTicks: 2 }]);

    tick();
    second.resolve();
    await second.promise;
    await Promise.resolve();
    expect(settled).toEqual([{ skippedTicks: 2 }, { skippedTicks: 0 }]);
  });

  it('не оставляет замок закрытым, если проход упал', async () => {
    const gate = deferred();
    let starts = 0;
    const tick = createSingleFlightTick(
      () => {
        starts += 1;
        return gate.promise;
      },
      () => undefined,
    );

    tick();
    gate.reject(new Error('boom'));
    await gate.promise.catch(() => undefined);
    await Promise.resolve();

    tick();
    expect(starts).toBe(2);
  });
});
