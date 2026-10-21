/**
 * Режим Ииваныча: где считаем ответ и когда пробуем локальный движок.
 *
 * Решение владельца (21.10.2026): Ииваныч **всегда** сначала считает на этом
 * компьютере, и только если локальный движок не справился — уходит на сервер.
 * Поэтому режимов три: «Авто» (дефолт для всех), «Только этот ПК» и
 * «Только сервер». Ручной выбор владельца уважаем, но чистая установка и
 * отсутствие значения дают «Авто».
 *
 * Circuit breaker: после нескольких подряд неудач локального движка мы его
 * не трогаем какое-то время — иначе каждый вопрос ждёт таймаут, а это
 * раздражает сильнее, чем ответ с сервера.
 */

export type AiEngineMode = 'auto' | 'local' | 'prod';

export const AI_ENGINE_MODES: readonly AiEngineMode[] = ['auto', 'local', 'prod'] as const;

/** Сколько подряд неудач локального движка открывают circuit breaker. */
export const LOCAL_ENGINE_BREAKER_FAILURES = 3;

/** Сколько локальный движок не трогаем после серии неудач (10–30 минут). */
export const LOCAL_ENGINE_BREAKER_COOLDOWN_MS = 15 * 60_000;

export type AiEngineBreaker = {
  /** Неудач подряд (с последнего успеха). */
  failures: number;
  /** До какого момента локальный движок не пробуем (мс epoch; 0 — не открыт). */
  openedUntil: number;
};

export const EMPTY_AI_ENGINE_BREAKER: AiEngineBreaker = { failures: 0, openedUntil: 0 };

/** Ручной выбор уважаем; пустое или неизвестное значение — «Авто». */
export function resolveAiEngineMode(raw: string | null | undefined): AiEngineMode {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'local' || value === 'prod' || value === 'auto') return value;
  return 'auto';
}

/** Пробовать ли локальный движок прямо сейчас. */
export function shouldTryLocalEngine(
  mode: AiEngineMode,
  breaker: AiEngineBreaker,
  nowMs: number = Date.now(),
): boolean {
  if (mode === 'prod') return false;
  if (mode === 'local') return true;
  return !isLocalEngineBreakerOpen(breaker, nowMs);
}

/** Открыт ли breaker прямо сейчас. */
export function isLocalEngineBreakerOpen(breaker: AiEngineBreaker, nowMs: number = Date.now()): boolean {
  return breaker.openedUntil > nowMs;
}

/** Через сколько миллисекунд breaker откроется снова (0 — открыт). */
export function localEngineBreakerRetryInMs(breaker: AiEngineBreaker, nowMs: number = Date.now()): number {
  if (!isLocalEngineBreakerOpen(breaker, nowMs)) return 0;
  return breaker.openedUntil - nowMs;
}

export function recordLocalEngineSuccess(): AiEngineBreaker {
  return { failures: 0, openedUntil: 0 };
}

export function recordLocalEngineFailure(
  breaker: AiEngineBreaker,
  nowMs: number = Date.now(),
): AiEngineBreaker {
  const failures = breaker.failures + 1;
  if (failures < LOCAL_ENGINE_BREAKER_FAILURES) return { failures, openedUntil: 0 };
  return { failures, openedUntil: nowMs + LOCAL_ENGINE_BREAKER_COOLDOWN_MS };
}

/** Где посчитан ответ — оператор должен видеть, к кому он ушёл. */
export type AiAnswerSource = 'local' | 'server';

export const AI_ANSWER_SOURCE_LABEL: Record<AiAnswerSource, string> = {
  local: 'считал этот компьютер',
  server: 'считал сервер',
};
