/**
 * Что считать «застрявшей» неотправленной строкой.
 *
 * Зачем: инцидент 16.11.2026 — клиент держал 617 строк `attribute_values` в `pending`
 * неделями. Они не уходили на сервер, оператор об этом не знал, а серверное автолечение
 * упиралось в дневной бюджет и скипалось молча. Сторож нужен с обеих сторон: клиент
 * показывает оператору «застряло», сервер — владельцу.
 *
 * Порог 15 минут: синк у клиента ходит раз в минуту и будится немедленно на своей
 * правке, поэтому неотправленная строка старше 15 минут — это уже не «в пути».
 */

/** Порог «застряло», минут. */
export const STUCK_PENDING_MINUTES = 15;

/** Порог «застряло», мс. */
export const STUCK_PENDING_MS = STUCK_PENDING_MINUTES * 60_000;

export type StuckPendingSummary = {
  /** Сколько строк висит в `pending`/`error` дольше порога. */
  count: number;
  /** Когда застряла самая старая из них (unix-мс); `null` — застрявших нет. */
  oldestPendingAt: number | null;
  /** Порог, по которому считалось (минуты) — подпись в UI рисует именно его. */
  thresholdMinutes: number;
};

/** Момент, раньше которого неотправленная строка считается застрявшей. */
export function stuckPendingCutoff(now: number, minutes: number = STUCK_PENDING_MINUTES): number {
  return now - Math.max(1, Math.floor(minutes)) * 60_000;
}

/**
 * Застряла ли строка. `updated_at` — время последней правки строки: пока строка висит
 * и не уезжает, её никто не трогает, поэтому оно и есть «с какого момента зависла».
 */
export function isStuckPending(
  updatedAt: number | null | undefined,
  now: number,
  minutes: number = STUCK_PENDING_MINUTES,
): boolean {
  if (updatedAt == null) return false;
  const ts = Number(updatedAt);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return ts < stuckPendingCutoff(now, minutes);
}

export function emptyStuckPendingSummary(minutes: number = STUCK_PENDING_MINUTES): StuckPendingSummary {
  return { count: 0, oldestPendingAt: null, thresholdMinutes: minutes };
}

/** Возраст самой старой застрявшей строки в минутах; меньше минуты округляем вверх до 1. */
export function stuckAgeMinutes(oldestPendingAt: number | null, now: number): number {
  if (oldestPendingAt == null) return 0;
  const diff = now - Number(oldestPendingAt);
  if (!Number.isFinite(diff) || diff <= 0) return 0;
  return Math.max(1, Math.ceil(diff / 60_000));
}
