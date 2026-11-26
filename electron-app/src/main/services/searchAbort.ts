// Отмена поиска: сигнал и гонка с ним (промт КАРМАНА #166).
//
// Модуль БЕЗ зависимости от Electron: его тянут и сервисы поиска, и тесты.
// Канал прогресса и вещание в окна живут в `searchProgress.ts`.

/** Поиск отменён оператором — это не ошибка, а отдельное состояние. */
export class SearchCancelledError extends Error {
  constructor() {
    super('Поиск отменён оператором');
    this.name = 'SearchCancelledError';
  }
}

/**
 * Гонка промиса с отменой: отмена рвёт ожидание немедленно.
 *
 * Нужна там, где работа уходит в чтение файла: `readFile` не отменяется, но
 * оператор не должен ждать его конца — хендлер возвращает частичный результат
 * сразу, а чтение в фоне дорабатывает и умирает вместе с файлом.
 */
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new SearchCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SearchCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Отменён ли поиск (по его сигналу). */
export function isSearchCancelled(signal: AbortSignal | undefined | null): boolean {
  return Boolean(signal?.aborted);
}
