// Листовой модуль без node-зависимостей: его тянет и `syncManager`, который собирается
// в android-бандл (web). Сам замер (`eventLoopLag.ts`) остаётся десктопным — в браузере
// `node:perf_hooks` нет.

export type EventLoopLag = { p50Ms: number; p99Ms: number; maxMs: number; samples: number };

/** Порог «ощутимая пауза»: главный поток стоял дольше — окно не перерисовывалось. */
export const SLOW_LOOP_P99_MS = 50;

export function formatLag(lag: EventLoopLag): string {
  return `p50=${lag.p50Ms}ms p99=${lag.p99Ms}ms max=${lag.maxMs}ms samples=${lag.samples}`;
}

export function shouldReportLag(lag: EventLoopLag, thresholdMs = SLOW_LOOP_P99_MS): boolean {
  return lag.samples > 0 && lag.p99Ms >= thresholdMs;
}

export function currentRssMb(): number | null {
  // В планшетном web-бандле `process` может отсутствовать — метрика там не нужна.
  if (typeof process === 'undefined' || typeof process.memoryUsage !== 'function') return null;
  const rss = process.memoryUsage().rss;
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
