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

export function buildPendingCountSql(tables: readonly string[]): string {
  if (tables.length === 0) return 'SELECT 0 AS n';
  const parts = tables.map((t) => `(SELECT COUNT(*) FROM "${String(t).replace(/"/g, '""')}" WHERE sync_status IN ('pending','error'))`);
  return `SELECT ${parts.join(' + ')} AS n`;
}

let cachedTables: string[] | null = null;
let cachedSql: string | null = null;

/** Сбросить кэш списка таблиц (пересборка локальной БД, тесты). */
export function resetPendingProbeCache(): void {
  cachedTables = null;
  cachedSql = null;
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
