import { describe, expect, it, vi } from 'vitest';

import { forwardAsyncErrors } from './asyncForward.js';

// Express 4 не ловит отклонённый промис async-обработчика: упал обработчик — ответ
// клиенту не уходит никогда, запрос висит до клиентского таймаута. Именно так вела
// себя дверь рекламаций: падение на уникальном индексе выглядело как «не сохранилось».
// Обёртка forward'ит отказ в `next(err)` — ответ уходит, а не тишина.

type Layer = { handle?: unknown };

/** Мини-роутер: слой с обработчиком и заглушкой `next`. */
function fakeRouter(handle: unknown): { stack: Layer[] } {
  return { stack: [{ handle }] };
}

describe('forwardAsyncErrors — отказ async-обработчика уходит в next', () => {
  it('отклонённый промис вызывает next с ошибкой', async () => {
    const boom = new Error('база отказала');
    const inner = async () => {
      throw boom;
    };
    const layer: Layer = { handle: inner };
    const router = fakeRouter(layer.handle);
    const app = { _router: { stack: [{ handle: router }] } } as never;

    forwardAsyncErrors(app);

    const next = vi.fn();
    const wrapped = (router.stack[0]!.handle as (...args: unknown[]) => unknown);
    void wrapped({}, {}, next);
    await new Promise((r) => setTimeout(r, 0));
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('успешный обработчик ничего не вызывает и отдаёт свой результат', async () => {
    const inner = async () => 'ok';
    const layer: Layer = { handle: inner };
    const router = fakeRouter(layer.handle);
    const app = { _router: { stack: [{ handle: router }] } } as never;

    forwardAsyncErrors(app);

    const next = vi.fn();
    const wrapped = (router.stack[0]!.handle as (...args: unknown[]) => unknown);
    const out = await wrapped({}, {}, next);
    expect(out).toBe('ok');
    expect(next).not.toHaveBeenCalled();
  });

  it('синхронный обработчик (не промис) не трогаем', () => {
    const inner = () => 'sync';
    const router = fakeRouter(inner);
    const app = { _router: { stack: [{ handle: router }] } } as never;

    forwardAsyncErrors(app);

    const wrapped = (router.stack[0]!.handle as (...args: unknown[]) => unknown);
    expect(wrapped({}, {}, vi.fn())).toBe('sync');
  });

  it('внутренности Express не те же — обёртка молча ничего не делает', () => {
    const app = {} as never;
    expect(() => forwardAsyncErrors(app)).not.toThrow();
  });
});
