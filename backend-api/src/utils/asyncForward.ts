import type { Express } from 'express';

/**
 * Express 4 не ловит отклонённый промис async-обработчика.
 *
 * Что это значит на практике: если обработчик упал (например, база отказала на
 * уникальном индексе), Express 4 об этом НЕ УЗНАЁТ — ответ клиенту не уходит
 * никогда, запрос ВИСИТ до клиентского таймаута. Оператор видит «не сохранилось»
 * и жмёт кнопку ещё раз, а в базе тем временем ничего не изменилось.
 *
 * Наблюдение на стенде 11.11.2026 (двигатель Е02АТ5382): «Сохранить очередь»
 * уходила в серверную дверь, дверь падала на `erp_engine_reclamations_queue_uq`
 * (та же очередь, второй раз) — и запрос висел, а клиент отваливался по
 * таймауту. Ровно тот симптом, который видел владелец.
 *
 * Обёртка forward'ит отказ в `next(err)` — дальше срабатывает обычный обработчик
 * ошибок Express (500 с текстом), и клиент получает ответ, а не тишину.
 *
 * Слой достаётся из внутренности Express (`_router.stack`): обойти каждый
 * маршрут поимённо — сорок строк в app.ts, которые придётся править при каждом
 * новом маршруте; здесь же обёртка навешивается один раз на все слои всех
 * подключённых маршрутов. Если внутренности Express поменяются — обёртка молча
 * ничего не обернёт (проверка на `_router`/`stack`), и поведение останется
 * прежним, а не сломается.
 */
export function forwardAsyncErrors(app: Express): void {
  const stack = (app as unknown as { _router?: { stack?: unknown[] } })._router?.stack;
  if (!Array.isArray(stack)) return;
  for (const layer of stack as Array<{ handle?: unknown }>) {
    const mounted = layer?.handle as { stack?: unknown[] } | undefined;
    if (!mounted || !Array.isArray(mounted.stack)) continue;
    for (const sub of mounted.stack as Array<{ handle?: unknown }>) wrapLayer(sub);
  }
}

/** Оборачивает один слой: отклонённый промис → `next(err)`. */
function wrapLayer(layer: { handle?: unknown }): void {
  const handle = layer.handle;
  if (typeof handle !== 'function') return;
  if ((handle as { __asyncForwarded?: boolean }).__asyncForwarded === true) return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const result = (handle as (...a: unknown[]) => unknown).apply(this, args);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch((err: unknown) => {
        const next = args[2] as ((err?: unknown) => void) | undefined;
        if (typeof next === 'function') next(err);
        else throw err;
      });
    }
    return result;
  };
  (wrapped as { __asyncForwarded?: boolean }).__asyncForwarded = true;
  layer.handle = wrapped;
}
