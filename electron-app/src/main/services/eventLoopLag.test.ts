import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Замер пауз главного потока — это «термометр»: он сам ничего не ускоряет, но без него
// жалоба «программа замирает» остаётся разговором. Проверяем две вещи: что термометр
// включается/выключается без утечек и что порог не срабатывает на нормальном потоке.

const logPerfWarn = vi.hoisted(() => vi.fn());
vi.mock('./logService.js', () => ({ logPerfWarn }));

const {
  currentRssMb,
  formatLag,
  lagMetadata,
  readEventLoopLag,
  shouldReportLag,
  startEventLoopLagMonitor,
  startEventLoopLagReporting,
  stopEventLoopLagMonitor,
} = await import('./eventLoopLag.js');

beforeEach(() => {
  logPerfWarn.mockClear();
});

afterEach(() => {
  stopEventLoopLagMonitor();
});

describe('eventLoopLag — гистограмма задержек', () => {
  it('до старта монитора замера нет — потребители не получают выдуманных чисел', () => {
    expect(readEventLoopLag()).toBeNull();
  });

  it('замер идёт после старта и сбрасывается окном', async () => {
    startEventLoopLagMonitor(10);
    await new Promise((r) => setTimeout(r, 60));
    const first = readEventLoopLag();
    expect(first).not.toBeNull();
    expect(first!.samples).toBeGreaterThan(0);
    expect(first!.p99Ms).toBeGreaterThanOrEqual(0);
    // После сброса окно начинается заново: старые пробы не раздувают следующий замер.
    await new Promise((r) => setTimeout(r, 40));
    expect(readEventLoopLag()!.samples).toBeLessThan(first!.samples * 3);
  });

  it('повторный старт не заводит второй монитор', () => {
    startEventLoopLagMonitor(10);
    startEventLoopLagMonitor(10);
    expect(readEventLoopLag()).not.toBeNull();
    stopEventLoopLagMonitor();
    expect(readEventLoopLag()).toBeNull();
  });

  it('порог: пустое окно не считается паузой, высокий p99 — считается', () => {
    expect(shouldReportLag({ p50Ms: 0, p99Ms: 0, maxMs: 0, samples: 0 })).toBe(false);
    expect(shouldReportLag({ p50Ms: 2, p99Ms: 12, maxMs: 40, samples: 100 })).toBe(false);
    expect(shouldReportLag({ p50Ms: 30, p99Ms: 120, maxMs: 400, samples: 100 })).toBe(true);
    expect(shouldReportLag({ p50Ms: 30, p99Ms: 60, maxMs: 90, samples: 10 }, 75)).toBe(false);
  });

  it('сводка и метаданные несут числа, а не пустоту', () => {
    const lag = { p50Ms: 1.5, p99Ms: 120, maxMs: 400, samples: 33 };
    expect(formatLag(lag)).toContain('p99=120ms');
    const meta = lagMetadata(lag);
    expect(meta.loopP99Ms).toBe(120);
    expect(meta.loopSamples).toBe(33);
    expect(typeof meta.rssMb).toBe('number');
    expect(lagMetadata(null)).toEqual({});
    expect(currentRssMb()).toBeGreaterThan(0);
  });

  it('фоновая сводка молчит, пока поток не стоял', async () => {
    startEventLoopLagMonitor(10);
    const timer = startEventLoopLagReporting(
      { db: {} as never, apiBaseUrl: 'http://127.0.0.1:1', log: () => undefined },
      { intervalMs: 20, p99ThresholdMs: 5_000 },
    );
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(timer);
    expect(logPerfWarn).not.toHaveBeenCalled();
  });

  it('фоновая сводка докладывает, когда окно задержек перевалило порог', async () => {
    const timer = startEventLoopLagReporting(
      { db: {} as never, apiBaseUrl: 'http://127.0.0.1:1' },
      {
        intervalMs: 10,
        readLag: () => ({ p50Ms: 30, p99Ms: 120, maxMs: 400, samples: 42 }),
      },
    );
    await new Promise((r) => setTimeout(r, 60));
    clearInterval(timer);
    expect(logPerfWarn).toHaveBeenCalled();
    const [db, apiBaseUrl, key, message] = logPerfWarn.mock.calls[0]!;
    expect(db).toEqual({});
    expect(apiBaseUrl).toBe('http://127.0.0.1:1');
    expect(key).toBe('loop-lag');
    expect(String(message)).toContain('slow main thread');
  });

  it('сводка не докладывает то же окно дважды подряд, если оно в норме', async () => {
    const timer = startEventLoopLagReporting(
      { db: {} as never, apiBaseUrl: 'http://127.0.0.1:1' },
      { intervalMs: 10, readLag: () => ({ p50Ms: 1, p99Ms: 20, maxMs: 30, samples: 10 }) },
    );
    await new Promise((r) => setTimeout(r, 60));
    clearInterval(timer);
    expect(logPerfWarn).not.toHaveBeenCalled();
  });
});
