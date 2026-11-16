/**
 * Дешёвая проба «есть ли у нас несинканные правки».
 *
 * Зачем: запись оператора (сообщение в чат, правка карточки, строка списка) ложится в
 * локальную SQLite со `sync_status = 'pending'` и уезжает на сервер только очередным
 * синком. Пока синк был раз в 5 минут, соседняя машина ждала минуты. Сторож в
 * `SyncManager` опрашивает эту пробу раз в секунду и пинает синк сразу, как появилась
 * своя работа, — но опрашивать что-то дорогое раз в секунду нельзя, отсюда проба:
 *
 * - ОДИН запрос на все таблицы (а не запрос на таблицу) — на планшете каждый вызов
 *   ещё и пересекает мост Capacitor, и 20 вызовов в секунду там были бы заметны;
 * - `sync_status IN ('pending','error')` — равенства по индексу `*_sync_status_idx`,
 *   который есть у каждой синкаемой таблицы; `<> 'synced'` пришлось бы читать индекс
 *   целиком.
 *
 * Считаем строки, а не «есть/нет»: `SyncManager` по изменению ЧИСЛА отличает новую
 * работу оператора от строки, которая вечно не уезжает (сервер её отвергает) — иначе
 * одна такая строка держала бы синк в петле.
 */
import { STUCK_PENDING_MINUTES, stuckPendingCutoff } from '@matricarmz/shared';

import type { SqlExecutor } from '../../database/sqlExecutor.js';

/** Таблицы реплики, у которых есть колонка `sync_status`. */
const PROBE_TABLES_SQL = `
  SELECT m.name AS name
    FROM sqlite_master m
   WHERE m.type = 'table'
     AND m.name NOT LIKE 'sqlite_%'
     AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'sync_status')
   ORDER BY m.name`;

/** Запасной путь для сборок SQLite без табличной функции `pragma_table_info`. */
const PROBE_TABLES_FALLBACK_SQL = `
  SELECT name
    FROM sqlite_master
   WHERE type = 'table'
     AND name NOT LIKE 'sqlite_%'
     AND sql LIKE '%sync_status%'
   ORDER BY name`;

/**
 * Таблицы, по которым считаем «застряло»: нужен ещё и `updated_at` — по нему видно,
 * с какого момента строка висит. Таблицы без такой колонки пропускаем.
 */
const STUCK_TABLES_SQL = `
  SELECT m.name AS name
    FROM sqlite_master m
   WHERE m.type = 'table'
     AND m.name NOT LIKE 'sqlite_%'
     AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'sync_status')
     AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'updated_at')
   ORDER BY m.name`;

const STUCK_TABLES_FALLBACK_SQL = `
  SELECT name
    FROM sqlite_master
   WHERE type = 'table'
     AND name NOT LIKE 'sqlite_%'
     AND sql LIKE '%sync_status%'
     AND sql LIKE '%updated_at%'
   ORDER BY name`;

/**
 * Таблицы, по которым синк НЕ торопим.
 *
 * `card_drafts` — черновик открытой карточки, он пишется автосейвом раз в ~1,5 с, пока
 * оператор печатает. Толку от мгновенной отправки нет (черновик нужен для восстановления
 * после сбоя и для второй машины ТОГО ЖЕ пользователя, чужим он не виден вовсе), а цена
 * есть: каждая отправка двигает номер журнала и будит весь парк на pull, в котором для
 * остальных ничего нет. Черновики уезжают попутным синком — по интервалу или вместе с
 * любой другой правкой.
 */
const DEFERRED_TABLES = new Set(['card_drafts']);

/**
 * Строки, которые «не повод торопить синк» ВНУТРИ таблицы: телеметрия интерфейса
 * (`ui.visit`/`ui.card_open`/…) — строка на визит вкладки, на каждое открытие
 * карточки. Если её считать мгновенно-pending, любой щелчок оператора будил бы
 * синк и крутил спиннер «N документов». Бизнес-журналы (`work_order.*` и пр.)
 * сюда НЕ входят — они важны и должны уезжать сразу. Телеметрия доезжает
 * попутным синком: плановым тиком (~5 мин), пробуждением или любой другой правкой.
 */
function deferredRowFilter(table: string): string {
  return table === 'audit_log' ? ` AND action NOT LIKE 'ui.%'` : '';
}

export function buildPendingCountSql(tables: readonly string[]): string {
  if (tables.length === 0) return 'SELECT 0 AS n';
  const parts = tables.map((t) => `(SELECT COUNT(*) FROM "${String(t).replace(/"/g, '""')}" WHERE sync_status IN ('pending','error')${deferredRowFilter(String(t))})`);
  return `SELECT ${parts.join(' + ')} AS n`;
}

/**
 * Строки, которые висят в `pending` дольше порога — «застряли».
 *
 * Зачем: инцидент 16.11.2026 — клиент держал 617 строк `attribute_values` в `pending`
 * неделями, сервер их не видел, оператор об этом не знал. Обычный счётчик pending
 * этого не показывал: строки были, но «неотправлено 617» никто не смотрел.
 *
 * Считаем только `sync_status = 'pending'`. Строки в `error` — это принятые сервером
 * с отказом (у них свой баннер «строка не принята сервером»), смешивать две разные
 * беды в один счётчик нельзя.
 */
export type StuckPendingProbe = {
  count: number;
  oldestPendingAt: number | null;
  byTable: Array<{ table: string; n: number; oldestPendingAt: number | null }>;
};

let cachedTables: string[] | null = null;
let cachedSql: string | null = null;
let cachedStuckTables: string[] | null = null;

/** Сбросить кэш списка таблиц (пересборка локальной БД, тесты). */
export function resetPendingProbeCache(): void {
  cachedTables = null;
  cachedSql = null;
  cachedStuckTables = null;
}

export async function listPendingProbeTables(exec: SqlExecutor): Promise<string[]> {
  const read = async (sql: string) =>
    (await exec.all<{ name: string }>(sql)).map((r) => String(r.name)).filter((name) => !DEFERRED_TABLES.has(name));
  try {
    return await read(PROBE_TABLES_SQL);
  } catch {
    return await read(PROBE_TABLES_FALLBACK_SQL);
  }
}

async function listStuckProbeTables(exec: SqlExecutor): Promise<string[]> {
  if (cachedStuckTables) return cachedStuckTables;
  const read = async (sql: string) =>
    (await exec.all<{ name: string }>(sql)).map((r) => String(r.name)).filter((name) => !DEFERRED_TABLES.has(name));
  try {
    cachedStuckTables = await read(STUCK_TABLES_SQL);
  } catch {
    cachedStuckTables = await read(STUCK_TABLES_FALLBACK_SQL);
  }
  return cachedStuckTables;
}

/**
 * Потабличный счёт застрявших строк и время самой старой из них.
 *
 * `updated_at` — время последней правки строки: пока строка висит и не уезжает, её
 * никто не трогает, поэтому оно и есть «с какого момента зависла».
 */
export async function countStuckPendingLocalRows(
  exec: SqlExecutor,
  opts?: { now?: number; minutes?: number },
): Promise<StuckPendingProbe> {
  const now = opts?.now ?? Date.now();
  const minutes = opts?.minutes ?? STUCK_PENDING_MINUTES;
  const cutoff = stuckPendingCutoff(now, minutes);
  const tables = await listStuckProbeTables(exec);
  const byTable: StuckPendingProbe['byTable'] = [];
  let count = 0;
  let oldestPendingAt: number | null = null;
  for (const table of tables) {
    const name = String(table).replace(/"/g, '""');
    try {
      const row = await exec.get<{ n: number; oldest: number | null }>(
        `SELECT COUNT(*) AS n, MIN(updated_at) AS oldest FROM "${name}" WHERE sync_status = 'pending' AND updated_at IS NOT NULL AND updated_at < ?${deferredRowFilter(name)}`,
        [cutoff],
      );
      const n = Math.max(0, Number(row?.n ?? 0) || 0);
      const oldest = row?.oldest == null ? null : Number(row.oldest);
      if (n > 0) {
        byTable.push({ table: String(table), n, oldestPendingAt: oldest });
        count += n;
        if (oldest != null && (oldestPendingAt == null || oldest < oldestPendingAt)) oldestPendingAt = oldest;
      }
    } catch {
      // Таблица могла переехать/пересобраться — молча пропускаем её, счётчик врёт меньше,
      // чем падает проба целиком.
    }
  }
  return { count, oldestPendingAt, byTable };
}

/**
 * Сколько локальных строк ещё не приняты сервером. `-1` — пробу выполнить не удалось
 * (БД закрыта, схема не готова): вызывающий трактует это как «не знаю», а не как ноль.
 */
export async function countPendingLocalRows(exec: SqlExecutor): Promise<number> {
  try {
    if (!cachedTables || !cachedSql) {
      cachedTables = await listPendingProbeTables(exec);
      cachedSql = buildPendingCountSql(cachedTables);
    }
    const row = await exec.get<{ n: number }>(cachedSql);
    return Math.max(0, Number(row?.n ?? 0) || 0);
  } catch {
    // Список таблиц мог устареть (реплика пересобрана) — следующий заход пересоберёт.
    resetPendingProbeCache();
    return -1;
  }
}

/**
 * Та же проба, но потаблично с замером времени — только для диагностики медленной
 * пробы (сторона SyncManager зовёт лишь когда общий COUNT уже превысил порог).
 */
export async function countPendingLocalRowsByTable(
  exec: SqlExecutor,
): Promise<Array<{ table: string; ms: number; n: number }>> {
  const tables = cachedTables ?? (await listPendingProbeTables(exec));
  const out: Array<{ table: string; ms: number; n: number }> = [];
  for (const t of tables) {
    const name = String(t).replace(/"/g, '""');
    const startedAt = Date.now();
    try {
      const row = await exec.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM "${name}" WHERE sync_status IN ('pending','error')${deferredRowFilter(name)}`,
      );
      out.push({ table: String(t), ms: Date.now() - startedAt, n: Math.max(0, Number(row?.n ?? 0) || 0) });
    } catch {
      out.push({ table: String(t), ms: -1, n: -1 });
    }
  }
  return out;
}
