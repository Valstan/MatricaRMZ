/**
 * Расхождение часов компьютера с часами сервера.
 *
 * Источник истины — заголовок `Date` от нашего же сервера: сторонние сервисы
 * не нужны, трафик не тратим. Поправка считается на середине RTT: иначе на
 * медленной сети ошибка съедает половину задержки.
 *
 * Порог предупреждения — 2 минуты: меньше расхождение никто не заметит,
 * а больше — уже ломает синк по времени и подписи документов.
 */

/** Порог, после которого время считается рассинхронизированным. */
export const CLOCK_SKEW_THRESHOLD_MS = 2 * 60 * 1000;

/** Как часто проверяем (раз в 2 часа). */
export const CLOCK_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;

export type ClockSkew = {
  /** Расхождение в мс: положительное — наш компьютер отстаёт от сервера. */
  skewMs: number | null;
  /** Когда проверили (мс epoch). */
  checkedAt: number | null;
  /** Время сервера по его заголовку `Date` (мс epoch). */
  serverTimeMs: number | null;
  /** Круговая задержка запроса (мс). */
  rttMs: number | null;
  error: string | null;
};

export const EMPTY_CLOCK_SKEW: ClockSkew = {
  skewMs: null,
  checkedAt: null,
  serverTimeMs: null,
  rttMs: null,
  error: null,
};

/**
 * Расхождение часов по трём точкам: когда отправили, когда сервер ответил
 * своим временем, когда получили. Сравниваем серверное время с серединой
 * интервала — так ошибка сети делится пополам.
 */
export function computeClockSkew(sentAtMs: number, serverTimeMs: number, receivedAtMs: number): {
  skewMs: number;
  rttMs: number;
} {
  const rttMs = Math.max(0, receivedAtMs - sentAtMs);
  const midpoint = sentAtMs + rttMs / 2;
  return { skewMs: Math.round(serverTimeMs - midpoint), rttMs: Math.round(rttMs) };
}

/** Расхождение больше порога — предупреждаем оператора. */
export function clockSkewIsProblem(skewMs: number | null, thresholdMs: number = CLOCK_SKEW_THRESHOLD_MS): boolean {
  if (skewMs == null || !Number.isFinite(skewMs)) return false;
  return Math.abs(skewMs) > thresholdMs;
}

/** «Время на компьютере расходится с сервером на N мин» — для плашки. */
export function formatClockSkew(skewMs: number | null): string {
  if (skewMs == null || !Number.isFinite(skewMs)) return '—';
  const abs = Math.abs(skewMs);
  const minutes = Math.floor(abs / 60000);
  if (minutes < 1) return 'меньше минуты';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} ч ${rest} мин` : `${hours} ч`;
}
