import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { logPerfWarn } from './logService.js';

// «Программа замирает» — это не медленная секунда на запрос, а стоящий главный поток:
// пока он занят применением pull (better-sqlite3 синхронный), окно не перерисовывается
// и IPC не отвечает. Гистограмма задержек таймера — единственный дешёвый способ увидеть
// это числом, а не жалобой из цеха. Пишем только аномалии (порог p99), сводка едет в
// серверный `client-*.log`, поэтому слабые машины парка видны без обхода.

export type EventLoopLag = { p50Ms: number; p99Ms: number; maxMs: number; samples: number };

/** Порог «ощутимая пауза» для сводок; для синка он же, но проверяется на его прогоне. */
export const SLOW_LOOP_P99_MS = 50;

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

function toMs(ns: number): number {
  return Math.round((ns / 1e6) * 10) / 10;
}

export function startEventLoopLagMonitor(resolutionMs = 20): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
}

export function stopEventLoopLagMonitor(): void {
  if (!histogram) return;
  histogram.disable();
  histogram = null;
}

/**
 * Текущие задержки главного потока. `reset` нужен, чтобы окно замера было узким:
 * для синка — от старта до конца прогона, а не «за последний час».
 */
export function readEventLoopLag(reset = true): EventLoopLag | null {
  if (!histogram) return null;
  const lag: EventLoopLag = {
    p50Ms: toMs(histogram.percentile(50)),
    p99Ms: toMs(histogram.percentile(99)),
    maxMs: toMs(histogram.max),
    samples: histogram.count,
  };
  if (reset) histogram.reset();
  return lag;
}

export function formatLag(lag: EventLoopLag): string {
  return `p50=${lag.p50Ms}ms p99=${lag.p99Ms}ms max=${lag.maxMs}ms samples=${lag.samples}`;
}

export function shouldReportLag(lag: EventLoopLag, thresholdMs = SLOW_LOOP_P99_MS): boolean {
  return lag.samples > 0 && lag.p99Ms >= thresholdMs;
}

export function currentRssMb(): number | null {
  const rss = process.memoryUsage?.().rss;
  return rss ? Math.round(rss / 1024 / 1024) : null;
}

/** Метаданные для лога: задержки + фактическая память процесса (кэш страниц живёт здесь). */
export function lagMetadata(lag: EventLoopLag | null): Record<string, unknown> {
  if (!lag) return {};
  return {
    loopP50Ms: lag.p50Ms,
    loopP99Ms: lag.p99Ms,
    loopMaxMs: lag.maxMs,
    loopSamples: lag.samples,
    rssMb: currentRssMb(),
  };
}

export type LagReportingArgs = {
  db: BetterSQLite3Database;
  apiBaseUrl: string;
  log?: (message: string) => void;
};

/**
 * Фоновая сводка: раз в минуту смотрит окно задержек и, если главный поток стоял
 * дольше порога, отправляет warn. Сам по себе монитор почти бесплатен (таймер 20 мс
 * внутри Node), поэтому включён всегда, а не по флагу.
 */
export function startEventLoopLagReporting(
  args: LagReportingArgs,
  opts: {
    intervalMs?: number;
    p99ThresholdMs?: number;
    /** Подмена источника замера — для тестов сводки без реальной блокировки потока. */
    readLag?: () => EventLoopLag | null;
  } = {},
): NodeJS.Timeout {
  const thresholdMs = opts.p99ThresholdMs ?? SLOW_LOOP_P99_MS;
  const readLag = opts.readLag ?? (() => readEventLoopLag());
  const timer = setInterval(() => {
    const lag = readLag();
    if (!lag || !shouldReportLag(lag, thresholdMs)) return;
    args.log?.(`perf: main thread lag ${formatLag(lag)} rss=${currentRssMb() ?? '?'}MB`);
    logPerfWarn(args.db, args.apiBaseUrl, 'loop-lag', `slow main thread: ${formatLag(lag)}`, {
      action: 'eventLoop',
      ...lagMetadata(lag),
    });
  }, opts.intervalMs ?? 60_000);
  timer.unref?.();
  return timer;
}
