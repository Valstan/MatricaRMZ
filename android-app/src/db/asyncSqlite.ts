// Асинхронный шов над платформенной реализацией SQLite (Ф1 android-порта,
// docs/plans/android-tablet-client-2026-08.md §Целевая архитектура).
//
// На планшете реализацией будет адаптер поверх @capacitor-community/sqlite
// (или fast-sql — решает бенч Ф0); в тестах на десктопе — адаптер поверх
// better-sqlite3 (testing/betterSqlite3Adapter.ts). Весь портированный код
// (миграторы, syncService, сервисы) ходит ТОЛЬКО через этот интерфейс —
// синхронного better-sqlite3-API в android-app быть не должно.

export type SqlValue = number | bigint | string | Uint8Array | null;

export type RunResult = {
  changes: number;
};

export interface AsyncSqlite {
  /** Пакет DDL/DML без параметров; допускает несколько statement'ов через `;`. */
  exec(sql: string): Promise<void>;
  /** Один statement с параметрами, без чтения результата. */
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  /** Строки объектами по именам колонок. */
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** Первая строка объектом или undefined. */
  get<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  /** Строки массивами в порядке колонок — формат, который ждёт drizzle sqlite-proxy. */
  values(sql: string, params?: SqlValue[]): Promise<SqlValue[][]>;
  close(): Promise<void>;
}
