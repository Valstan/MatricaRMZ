import { describe, expect, it, vi } from 'vitest';

import { createPerfTrace, resolvePerfTraceEnabled, type PerfRow } from './perfTrace';

// Часы по расписанию: measure берёт now() дважды, так что пары задают длительности.
function scriptedNow(steps: number[]): () => number {
  let i = 0;
  return () => steps[i++] ?? 0;
}

describe('createPerfTrace (выключен)', () => {
  it('не считает и ничего не печатает', () => {
    const log = vi.fn();
    const trace = createPerfTrace({ enabled: false, log });

    trace.count('row-render');
    trace.count('row-render');
    trace.measure('filter', () => 42);

    expect(trace.enabled).toBe(false);
    expect(trace.dump()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('measure отдаёт результат функции и не трогает часы', () => {
    const now = vi.fn(() => 0);
    const trace = createPerfTrace({ enabled: false, now });

    expect(trace.measure('filter', () => 'готово')).toBe('готово');
    expect(now).not.toHaveBeenCalled();
  });
});

describe('createPerfTrace (включён)', () => {
  it('копит count, total и max по имени', () => {
    const log = vi.fn();
    const trace = createPerfTrace({ enabled: true, now: scriptedNow([0, 5, 10, 17, 100, 103]), log });

    trace.measure('filter', () => null); // 5 мс
    trace.measure('filter', () => null); // 7 мс
    trace.measure('filter', () => null); // 3 мс
    trace.count('row-render');
    trace.count('row-render');

    const rows = trace.dump();
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get('filter')).toEqual({ name: 'filter', count: 3, totalMs: 15, maxMs: 7 });
    expect(byName.get('row-render')).toEqual({ name: 'row-render', count: 2, totalMs: 0, maxMs: 0 });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('measure возвращает значение функции и считает её время', () => {
    const trace = createPerfTrace({ enabled: true, now: scriptedNow([2, 14]), log: vi.fn() });

    expect(trace.measure('build-bom', () => ({ ok: true }))).toEqual({ ok: true });
    expect(trace.dump()).toEqual([{ name: 'build-bom', count: 1, totalMs: 12, maxMs: 12 }]);
  });

  it('учитывает время даже когда функция бросила, и бросок доходит до вызывающего', () => {
    const trace = createPerfTrace({ enabled: true, now: scriptedNow([0, 9]), log: vi.fn() });

    expect(() =>
      trace.measure('build-bom', () => {
        throw new Error('сломалось');
      }),
    ).toThrow('сломалось');
    expect(trace.dump()).toEqual([{ name: 'build-bom', count: 1, totalMs: 9, maxMs: 9 }]);
  });

  it('dump сбрасывает счётчики и на пустом больше не печатает', () => {
    const log = vi.fn();
    const trace = createPerfTrace({ enabled: true, now: scriptedNow([0, 4]), log });

    trace.measure('filter', () => null);
    expect(trace.dump()).toHaveLength(1);
    expect(trace.dump()).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('сортирует сводку по суммарному времени — тяжёлое сверху', () => {
    const trace = createPerfTrace({ enabled: true, now: scriptedNow([0, 1, 0, 50, 0, 10]), log: vi.fn() });

    trace.measure('лёгкое', () => null);
    trace.measure('тяжёлое', () => null);
    trace.measure('среднее', () => null);

    expect(trace.dump().map((row: PerfRow) => row.name)).toEqual(['тяжёлое', 'среднее', 'лёгкое']);
  });
});

describe('resolvePerfTraceEnabled', () => {
  it('включён в dev-сборке без обращения к хранилищу', () => {
    const readFlag = vi.fn(() => null);
    expect(resolvePerfTraceEnabled(true, readFlag)).toBe(true);
    expect(readFlag).not.toHaveBeenCalled();
  });

  it('включается флагом хранилища в обычной сборке', () => {
    expect(resolvePerfTraceEnabled(false, () => '1')).toBe(true);
    expect(resolvePerfTraceEnabled(false, () => '0')).toBe(false);
    expect(resolvePerfTraceEnabled(false, () => null)).toBe(false);
  });

  it('бросок localStorage не ломает модуль', () => {
    expect(
      resolvePerfTraceEnabled(false, () => {
        throw new Error('SecurityError: доступ к хранилищу закрыт');
      }),
    ).toBe(false);
  });
});
