// Гонка с отменой: отменённый поиск не должен оставлять «висящий» отказ.
//
// Грабля M242 (27.11.2026): папку сносили (тест — временный каталог, оператор —
// переносит диск), пока её ещё читал фон. Поздний ENOENT прилетел без обработчика
// и ронял джоб CI при ПОЛНОСТЬЮ зелёных тестах («Vitest caught 1 unhandled error»).
// Корни: отменённый сигнал возвращал отказ, не взяв исходный промис под руку.

import { describe, expect, it } from 'vitest';

import { raceWithAbort, SearchCancelledError } from './searchAbort.js';

describe('гонка с отменой', () => {
  it('отменённый сигнал: исходный промис не остаётся без обработчика', async () => {
    const controller = new AbortController();
    controller.abort();

    // Промис, который откажется ПОЗЖЕ — как папка, исчезнувшая во время чтения.
    const late = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('ENOENT: no such file or directory, scandir')), 5);
    });

    await expect(raceWithAbort(late, controller.signal)).rejects.toBeInstanceOf(SearchCancelledError);

    // Ждём позднего отказа: если обработчика не было, vitest поймает необработанное
    // отклонение и джоб упадёт — это и есть страж поведения.
    await new Promise((r) => setTimeout(r, 40));
  });

  it('отмена на живом сигнале тоже не оставляет исходный промис без обработчика', async () => {
    const controller = new AbortController();
    const late = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('ENOENT: no such file or directory, scandir')), 5);
    });

    const raced = raceWithAbort(late, controller.signal);
    controller.abort();
    await expect(raced).rejects.toBeInstanceOf(SearchCancelledError);
    await new Promise((r) => setTimeout(r, 40));
  });

  it('без сигнала промис идёт как есть', async () => {
    await expect(raceWithAbort(Promise.resolve('ok'), undefined)).resolves.toBe('ok');
  });
});
