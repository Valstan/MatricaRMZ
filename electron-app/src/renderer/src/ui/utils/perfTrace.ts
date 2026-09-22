// Дешёвый счётчик горячих мест рендерера: сколько раз позвали и во что это обошлось.
// Нужен потому, что «интерфейс стал тяжелее» — без цифр любая оптимизация остаётся гаданием,
// а в репозитории до сих пор не было ни одного средства замера.
//
// Включается dev-сборкой ИЛИ флагом localStorage['matrica:perfTrace'] = '1'. Второе обязательно:
// мерить надо на слабой машине владельца, где стоит обычный релиз, и пересобирать её ради
// замера нельзя. Флаг читается ОДИН раз при инициализации — чтение хранилища в горячем цикле
// само по себе стало бы той нагрузкой, которую мы ищем.

export const PERF_TRACE_FLAG_KEY = 'matrica:perfTrace';

/** Строка сводки: точка замера, число вызовов, суммарное и максимальное время (мс). */
export type PerfRow = { name: string; count: number; totalMs: number; maxMs: number };

export type PerfTrace = {
  readonly enabled: boolean;
  /** Отметить вызов без замера времени — «сколько раз сюда зашли». */
  count(name: string): void;
  /** Замерить fn и вернуть её результат. Бросок fn не теряется, время всё равно учитывается. */
  measure<T>(name: string, fn: () => T): T;
  /** Напечатать сводку и обнулить счётчики. Возвращает то, что напечатал. */
  dump(): readonly PerfRow[];
};

export type PerfTraceOptions = {
  enabled: boolean;
  /** Часы; по умолчанию performance.now. Подменяются в тестах. */
  now?: () => number;
  /** Печать сводки; по умолчанию console.table. */
  log?: (rows: readonly PerfRow[]) => void;
};

const NO_ROWS: readonly PerfRow[] = Object.freeze([]);

// Выключенный трейсер — один на всех, общий замороженный объект: ни одной аллокации на вызов.
// Иначе средство замера само добавило бы работы процессору на каждом горячем кадре.
const DISABLED: PerfTrace = Object.freeze({
  enabled: false,
  count(_name: string): void {},
  measure<T>(_name: string, fn: () => T): T {
    return fn();
  },
  dump(): readonly PerfRow[] {
    return NO_ROWS;
  },
});

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

function defaultLog(rows: readonly PerfRow[]): void {
  console.table(
    rows.map((row) => ({
      точка: row.name,
      вызовов: row.count,
      'всего, мс': round(row.totalMs),
      'макс, мс': round(row.maxMs),
      'сред, мс': round(row.totalMs / row.count),
    })),
  );
}

/**
 * Трейсер с накоплением по имени. Чистая фабрика без таймеров и без обращений к окну —
 * периодическая сводка живёт ниже, в singleton'е, чтобы фабрику можно было тестировать.
 */
export function createPerfTrace(options: PerfTraceOptions): PerfTrace {
  if (!options.enabled) return DISABLED;

  const now = options.now ?? defaultNow;
  const log = options.log ?? defaultLog;
  const stats = new Map<string, { count: number; totalMs: number; maxMs: number }>();

  const record = (name: string, ms: number): void => {
    const prev = stats.get(name);
    if (prev === undefined) {
      stats.set(name, { count: 1, totalMs: ms, maxMs: ms });
      return;
    }
    // Мутируем запись на месте: новый объект на каждый вызов — лишний мусор для GC.
    prev.count += 1;
    prev.totalMs += ms;
    if (ms > prev.maxMs) prev.maxMs = ms;
  };

  return {
    enabled: true,
    count(name: string): void {
      record(name, 0);
    },
    measure<T>(name: string, fn: () => T): T {
      const startedAt = now();
      try {
        return fn();
      } finally {
        record(name, now() - startedAt);
      }
    },
    dump(): readonly PerfRow[] {
      // Пусто — молчим: иначе каждые 10 секунд в консоль падала бы пустая таблица.
      if (stats.size === 0) return NO_ROWS;
      const rows: PerfRow[] = [];
      for (const [name, s] of stats) rows.push({ name, count: s.count, totalMs: s.totalMs, maxMs: s.maxMs });
      stats.clear();
      rows.sort((a, b) => b.totalMs - a.totalMs);
      log(rows);
      return rows;
    },
  };
}

/**
 * Решение «включён ли замер». Вынесено отдельно и принимает чтение флага параметром,
 * потому что сам доступ к localStorage бросает в части окружений (запрещённое хранилище,
 * iframe без доступа) — трейсер не имеет права уронить этим рендерер.
 */
export function resolvePerfTraceEnabled(dev: boolean, readFlag: (key: string) => string | null): boolean {
  if (dev) return true;
  try {
    return readFlag(PERF_TRACE_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

const DUMP_INTERVAL_MS = 10_000;

function readLocalStorageFlag(key: string): string | null {
  return globalThis.localStorage?.getItem(key) ?? null;
}

const isDevBuild = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

export const perfTrace: PerfTrace = createPerfTrace({
  enabled: resolvePerfTraceEnabled(isDevBuild, readLocalStorageFlag),
});

// Периодическая сводка и ручка в консоли — только в окне рендерера: в тестах (environment node)
// окна нет, и импорт модуля не должен заводить таймеров.
if (perfTrace.enabled && typeof window !== 'undefined') {
  (window as unknown as { __matricaPerf?: PerfTrace }).__matricaPerf = perfTrace;
  window.setInterval(() => {
    perfTrace.dump();
  }, DUMP_INTERVAL_MS);
}
