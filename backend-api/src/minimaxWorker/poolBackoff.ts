// Паузы между попытками взять аккаунт — по причинам отказа, с ростом.
//
// ⚠️ Почему пауза, а не «позвать ещё раз»: у Кармана есть лимит (60 запросов в
// минуту на токен и IP), а пул на сутки пустеет надолго. Частая переспрашивание
// пустого пула ⇒ 429 ⇒ и пул не согревается зря. В «Сарафане» те же идеи живут
// отдельными TTL (`MINIMAX_KARMAN_DOWN_TTL` / `_EMPTY_TTL` / `_NO_POINTS_TTL`),
// и паузы там общие для форков воркера, а не в памяти процесса.
//
// У нас форков нет: воркер — один systemd-юнит, один процесс. Поэтому состояние
// пауз живёт здесь, в модуле, — оно общее для всех запросов этого сервиса (все
// они проходят через один экземпляр), и переживает только его перезапуск.
//
// Разные причины ⇒ разные сроки ожидания: «пул пуст на сутки» и «Карман не
// ответил» — разные вещи, и ждать их надо по-разному (ADR-0017 «Сарафана»;
// brain G619: «кончились аккаунты» и «кончилась квота» — разные причины).

import type { KarmanFailureReason } from './karmanPool.js';

export type PoolBackoffOptions = {
  /** Базовая пауза для каждой причины, мс. */
  baseMs?: Partial<Record<KarmanFailureReason, number>>;
  /** Потолок паузы для каждой причины, мс. */
  maxMs?: Partial<Record<KarmanFailureReason, number>>;
  /** Множитель роста за каждую неудачу подряд. */
  factor?: number;
  /** Сейчас (для тестов). */
  now?: () => number;
};

/**
 * Базовые паузы, мс.
 *
 * - `pool_empty` — свободных аккаунтов нет: сутки учёта комнаты, ждать долго;
 * - `pool_no_tokens` — аккаунты есть, а пары токенов нет: ждать ещё дольше
 *   (вход владельца не появится мгновенно);
 * - `pool_no_handable` — кандидаты были, но все отбракованы: Карман сам разберётся
 *   через минуты, пробовать часто бессмысленно;
 * - `karman_unavailable` — сеть/сервис: короткая пауза, вопрос не срочный;
 * - `rate_limited` — нас самого залимитили: пауза не меньше окна лимита;
 * - `token_*` — не наша ошибка конфигурации: ждать долго, чинить должен владелец.
 */
const DEFAULT_BASE_MS: Record<KarmanFailureReason, number> = {
  pool_empty: 60_000,
  pool_no_tokens: 300_000,
  pool_no_handable: 60_000,
  karman_unavailable: 15_000,
  rate_limited: 65_000,
  token_unauthorized: 300_000,
  token_read_only: 300_000,
  account_not_found: 15_000,
  account_not_ours: 15_000,
  bad_request: 60_000,
};

const DEFAULT_MAX_MS: Record<KarmanFailureReason, number> = {
  pool_empty: 15 * 60_000,
  pool_no_tokens: 30 * 60_000,
  pool_no_handable: 15 * 60_000,
  karman_unavailable: 5 * 60_000,
  rate_limited: 15 * 60_000,
  token_unauthorized: 60 * 60_000,
  token_read_only: 60 * 60_000,
  account_not_found: 5 * 60_000,
  account_not_ours: 5 * 60_000,
  bad_request: 15 * 60_000,
};

const DEFAULT_FACTOR = 2;

export type PoolBackoffState = {
  /** До какого момента (epoch мс) пул не опрашиваем. */
  pausedUntilMs: number;
  /** Неудач подряд по каждой причине — от него растёт пауза. */
  failures: Record<string, number>;
  /** Последняя причина отказа — для журнала и `/health`. */
  lastReason: KarmanFailureReason | null;
};

/**
 * Счётчик пауз пула.
 *
 * Пауза растёт по причине: каждая неудача подряд увеличивает её в `factor` раз
 * (до потолка), успех обнуляет счётчики. Рост нужен, потому что пустой пул на
 * сутки и на минуту — разные случаи, а одинаковая пауза бьёт по лимиту Кармана.
 */
export class PoolBackoff {
  private readonly baseMs: Record<KarmanFailureReason, number>;
  private readonly maxMs: Record<KarmanFailureReason, number>;
  private readonly factor: number;
  private readonly now: () => number;
  private pausedUntilMs = 0;
  private failures: Record<string, number> = {};
  private lastReason: KarmanFailureReason | null = null;

  constructor(options: PoolBackoffOptions = {}) {
    this.baseMs = { ...DEFAULT_BASE_MS, ...(options.baseMs ?? {}) };
    this.maxMs = { ...DEFAULT_MAX_MS, ...(options.maxMs ?? {}) };
    this.factor = Math.max(1, options.factor ?? DEFAULT_FACTOR);
    this.now = options.now ?? (() => Date.now());
  }

  /** Отказали: отметить причину и вернуть, до какого момента ждать. */
  noteFailure(reason: KarmanFailureReason): number {
    const streak = (this.failures[reason] ?? 0) + 1;
    this.failures = { ...this.failures, [reason]: streak };
    this.lastReason = reason;
    const base = this.baseMs[reason] ?? DEFAULT_BASE_MS.karman_unavailable;
    const max = this.maxMs[reason] ?? DEFAULT_MAX_MS.karman_unavailable;
    const delay = Math.min(max, base * this.factor ** (streak - 1));
    this.pausedUntilMs = this.now() + delay;
    return delay;
  }

  /** Успех: счётчики неудач обнуляются — пул снова в работе. */
  noteSuccess(): void {
    this.failures = {};
    this.lastReason = null;
    this.pausedUntilMs = 0;
  }

  /** Пул сейчас на паузе? */
  isPaused(): boolean {
    return this.now() < this.pausedUntilMs;
  }

  /** Сколько ещё ждать, мс (0 — не на паузе). */
  remainingMs(): number {
    return Math.max(0, this.pausedUntilMs - this.now());
  }

  /** Снимок состояния — для `/health` и журнала. */
  snapshot(): PoolBackoffState {
    return {
      pausedUntilMs: this.pausedUntilMs,
      failures: { ...this.failures },
      lastReason: this.lastReason,
    };
  }
}
