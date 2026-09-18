/**
 * Сколько ждать перед следующим ждущим запросом, если новостей не было.
 *
 * Ждущий запрос рассчитан на то, что сервер ДЕРЖИТ его до конца окна. Но ответить
 * пустым «сейчас же» может кто угодно по дороге: прокси, заглушка, сервер другой
 * версии. Без этой паузы такой ответ превращает цикл в петлю без передышки — запрос
 * за запросом на полной скорости (поймано android-смоуками моста 18.09.2026, где
 * фейковый сервер отвечает `200 {ok:true}` на любой URL). Добираем остаток окна:
 * в худшем случае пробуждение вырождается в обычный опрос раз в окно, а не в петлю.
 */
export function computeWakeIdlePauseMs(elapsedMs: number, holdMs: number): number {
  return Math.max(0, Math.max(0, holdMs) - Math.max(0, elapsedMs));
}

/**
 * Что делать сторожу локальных правок на очередном тике.
 *
 * Правило одно: **изменилось число несинканных строк — значит, оператор только что
 * что-то записал**, и синк запускается немедленно. Если число то же самое, а строки
 * не уехали, — это строка, которую сервер не принимает; такую переспрашиваем с
 * растущей паузой, иначе один вечно-pending ряд держал бы синк в петле по секунде.
 */
export function computeLocalDirtyAction(args: {
  pendingRows: number;
  lastPendingRows: number | null;
  nowMs: number;
  lastDirtySyncAtMs: number | null;
  retryDelayMs: number;
  minRetryDelayMs: number;
  maxRetryDelayMs: number;
}): { sync: boolean; nextRetryDelayMs: number } {
  const min = Math.max(0, args.minRetryDelayMs);
  const max = Math.max(min, args.maxRetryDelayMs);
  const retry = Math.min(max, Math.max(min, args.retryDelayMs || min));

  // -1 — пробу выполнить не удалось: не знаем, а не «чисто».
  if (args.pendingRows < 0) return { sync: false, nextRetryDelayMs: retry };
  if (args.pendingRows === 0) return { sync: false, nextRetryDelayMs: min };

  if (args.lastPendingRows == null || args.pendingRows !== args.lastPendingRows) {
    return { sync: true, nextRetryDelayMs: min };
  }
  if (args.lastDirtySyncAtMs == null || args.nowMs - args.lastDirtySyncAtMs >= retry) {
    return { sync: true, nextRetryDelayMs: Math.min(max, Math.max(min, retry * 2)) };
  }
  return { sync: false, nextRetryDelayMs: retry };
}

export function computeNextSyncDelayMs(args: {
  baseIntervalMs: number;
  resultOk: boolean;
  pulled: number;
  pushed: number;
  offline: boolean;
  consecutiveErrors: number;
  random?: () => number;
}): { nextDelayMs: number; nextConsecutiveErrors: number } {
  let nextDelayMs = args.baseIntervalMs;
  let nextConsecutiveErrors = args.consecutiveErrors;

  if (args.offline) {
    nextConsecutiveErrors = 0;
    nextDelayMs = Math.min(args.baseIntervalMs, 60_000);
  } else if (!args.resultOk) {
    nextConsecutiveErrors += 1;
    const backoff = Math.min(10 * 60_000, 30_000 * 2 ** Math.min(4, nextConsecutiveErrors - 1));
    nextDelayMs = Math.max(30_000, backoff);
  } else {
    nextConsecutiveErrors = 0;
    const activity = Number(args.pulled ?? 0) + Number(args.pushed ?? 0);
    nextDelayMs = activity > 0 ? Math.min(45_000, Math.max(15_000, Math.floor(args.baseIntervalMs / 3))) : args.baseIntervalMs;
  }

  const randomFn = args.random ?? Math.random;
  const jitter = Math.floor(nextDelayMs * 0.15 * randomFn());
  nextDelayMs = Math.max(10_000, nextDelayMs + jitter);

  return { nextDelayMs, nextConsecutiveErrors };
}

