// Адаптер AsyncSqlite поверх @capacitor-community/sqlite — платформенная
// реализация шва Ф1 на планшете (docs/plans/android-tablet-client-2026-08.md).
// Десктопный аналог для vitest — db/testing/betterSqlite3Adapter.ts; поведение
// обязано совпадать, за этим следит capacitorSqlite.test.ts (фейковый плагин
// с ОБЪЕКТНЫМИ строками поверх better-sqlite3).
//
// Плагин не умеет отдавать строки массивами, поэтому values() ходит через
// переписывание проекции (db/selectAliasing.ts) — см. подробности там.
import type { AsyncSqlite, RunResult, SqlValue } from '../db/asyncSqlite.js';
import { planQuery, stripSqlLineComments } from '../db/selectAliasing.js';

/** Ровно та часть SQLiteDBConnection, которой пользуется адаптер. */
export type CapacitorDbConnection = {
  execute(statements: string, transaction?: boolean): Promise<unknown>;
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<{ changes?: { changes?: number } }>;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  close(): Promise<void>;
};

// Мост Capacitor сериализует аргументы в JSON — bigint через него не проходит.
// В клиентской схеме больших целых нет (метки времени в мс), поэтому сужение
// до number безопасно и не молчаливо: остальные типы идут как есть.
function toBridgeValue(v: SqlValue): unknown {
  return typeof v === 'bigint' ? Number(v) : v;
}

function bind(params: SqlValue[] | undefined): unknown[] {
  return (params ?? []).map(toBridgeValue);
}

const warned = new Set<string>();

function warnUnparsed(sql: string): void {
  const key = sql.slice(0, 120);
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[capacitor-sqlite] проекция не разобрана, порядок колонок берётся из объекта: ${key}`);
}

// Экран падения на планшете показывал голое «Execute: not an error (code 0)» —
// по нему не понять, какой оператор упал (M145). Подписываем каждую ошибку
// плагина текстом SQL: диагностика едет вместе с сообщением, а не гадается.
function sqlSnippet(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function withSql(err: unknown, sql: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[capacitor-sqlite] оператор не прошёл: ${sqlSnippet(sql)}`, err);
  return new Error(`${msg} :: ${sqlSnippet(sql)}`);
}

export function createCapacitorAsyncSqlite(conn: CapacitorDbConnection): AsyncSqlite {
  // transaction:false обязателен во ВСЕХ вызовах: плагин иначе оборачивает
  // statement'ы в собственную транзакцию, а мы ведём их сами
  // (SqlExecutor.transaction в core/syncWiring.ts шлёт BEGIN IMMEDIATE/COMMIT),
  // и миграция 0007 c `PRAGMA foreign_keys=OFF/ON` внутри транзакции стала бы
  // тихим no-op (см. db/migrations/drizzleChain.ts).
  const objectRows = async (sql: string, params?: SqlValue[]): Promise<Array<Record<string, SqlValue>>> => {
    try {
      const res = await conn.query(sql, bind(params));
      return (res.values ?? []) as Array<Record<string, SqlValue>>;
    } catch (e) {
      throw withSql(e, sql);
    }
  };

  const self: AsyncSqlite = {
    async exec(sql: string): Promise<void> {
      // Пустой/комментарийный оператор в плагин не шлём вовсе: после снятия
      // комментариев он стал бы `execSQL(";")` — `not an error (code 0)` (M145).
      if (!stripSqlLineComments(sql).trim()) return;
      const plan = planQuery(sql);
      // Android: execute() не умеет statements, возвращающие строки, — execSQL
      // бросает «Queries can be performed using SQLiteDatabase query or rawQuery
      // methods only.» (документация плагина, Limitations → Android). Так ведут
      // себя PRAGMA journal_mode и прочие returnable-прагмы; non-returning
      // (foreign_keys, optimize) query() тоже переживает. Multi-statement
      // (несколько ';') query() не переварит — оставляем на execute().
      if (plan.kind === 'raw' && (sql.match(/;/g) ?? []).length <= 1) {
        await objectRows(sql);
        return;
      }
      try {
        await conn.execute(sql, false);
      } catch (e) {
        throw withSql(e, sql);
      }
    },

    async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
      try {
        const res = await conn.run(sql, bind(params), false);
        return { changes: res.changes?.changes ?? 0 };
      } catch (e) {
        throw withSql(e, sql);
      }
    },

    async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      const plan = planQuery(sql);
      if (plan.kind === 'exec') {
        await self.run(sql, params);
        return [];
      }
      // Строку собираем из алиасованной выборки: NULL-колонки Android в JSON не
      // кладёт вовсе, а стендовый better-sqlite3 отдаёт их явным null. Ключи
      // берём предсказанные (`names`) — одноимённые колонки джойна схлопываются
      // ровно как у better-sqlite3 .all(). Если хоть одно имя непредсказуемо
      // (выражение без алиаса) или проекция не разобрана — отдаём объект
      // плагина как есть: угадывать имя колонки за SQLite мы не будем.
      if (plan.kind === 'raw' || plan.names.some((n) => n === null)) {
        return (await objectRows(sql, params)) as T[];
      }
      const rows = await objectRows(plan.sql, params);
      return rows.map((row) => {
        const out: Record<string, SqlValue> = {};
        plan.names.forEach((name, i) => {
          out[name as string] = row[plan.aliases[i]!] ?? null;
        });
        return out as T;
      });
    },

    async get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
      const rows = await self.all<T>(sql, params);
      return rows[0];
    },

    async values(sql: string, params: SqlValue[] = []): Promise<SqlValue[][]> {
      const plan = planQuery(sql);
      if (plan.kind === 'exec') {
        await self.run(sql, params);
        return [];
      }
      if (plan.kind === 'raw') {
        warnUnparsed(sql);
        return (await objectRows(sql, params)).map((row) => Object.values(row));
      }
      const rows = await objectRows(plan.sql, params);
      return rows.map((row) => plan.aliases.map((a) => row[a] ?? null));
    },

    async close(): Promise<void> {
      await conn.close();
    },
  };

  return self;
}
