import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { logPerfWarn } from './logService.js';
import { SLOW_LOOP_P99_MS, formatLag, lagMetadata, shouldReportLag } from './eventLoopLagMetrics.js';
import type { EventLoopLag } from './eventLoopLagMetrics.js';

// «Программа замирает» — это не медленная секунда на запрос, а стоящий главный поток:
// пока он занят применением pull (better-sqlite3 синхронный), окно не перерисовывается
// и IPC не отвечает. Гистограмма задержек таймера — единственный дешёвый способ увидеть
// это числом, а не жалобой из цеха. Пишем только аномалии (порог p99), сводка едет в
// серверный `client-*.log`, поэтому слабые машины парка видны без обхода.
//
// Модуль десктопный: `node:perf_hooks` в web-сборке (планшет) нет, поэтому `syncManager`
// берёт замер инъекцией, а не импортом.

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
    args.log?.(`perf: main thread lag ${formatLag(lag)} rss=${lagMetadata(lag).rssMb ?? '?'}MB`);
    logPerfWarn(args.db, args.apiBaseUrl, 'loop-lag', `slow main thread: ${formatLag(lag)}`, {
      action: 'eventLoop',
      ...lagMetadata(lag),
    });
  }, opts.intervalMs ?? 60_000);
  timer.unref?.();
  return timer;
}
