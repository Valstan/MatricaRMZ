// Runtime client DB uses better-sqlite3-multiple-ciphers (same 12.11.1 API as
// better-sqlite3, ChaCha20-Poly1305 at rest) so the local cache is encrypted with a
// per-machine key (docs/plans/_archive/sqlcipher-client-db-2026-07.md). Unit tests keep using
// plain better-sqlite3 ':memory:' — the type stays the better-sqlite3 one.
import Database from 'better-sqlite3-multiple-ciphers';
import type BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

let lastWritableSqlite: BetterSqlite3.Database | null = null;

/** Потолок страничного кэша, KiB (знак минус = KiB, а не число страниц). */
const PAGE_CACHE_KIB = 512 * 1024;
const BUSY_TIMEOUT_MS = 5_000;

function probeReadable(sqlite: Database.Database): boolean {
  try {
    sqlite.prepare('SELECT count(*) AS c FROM sqlite_master').get();
    return true;
  } catch {
    return false;
  }
}

function hasQueryPlannerStats(sqlite: Database.Database): boolean {
  try {
    const row = sqlite.prepare('SELECT count(*) AS c FROM sqlite_stat1').get() as
      | { c?: number }
      | undefined;
    return Number(row?.c ?? 0) > 0;
  } catch {
    // Таблицы статистики ещё нет — база не знает планов (свежая или после крупных правок).
    return false;
  }
}

/**
 * Кэш страниц по умолчанию у SQLite — 2 МБ, и на шифрованной базе этого не хватает:
 * каждая вытесненная страница расшифровывается заново, а применение pull — это
 * короткие транзакции по 2000 строк с обновлением индексов (замер на стендовом объёме:
 * 56 мс → 9 мс на пачку, пики 205 мс → 15 мс). 512 МБ здесь *лимит*, а не выделение:
 * SQLite занимает страницы по мере обращения и лишнего не держит.
 * `temp_store = MEMORY` уводит в память сортировки и DISTINCT отчётов.
 * `busy_timeout` готовит второе соединение (синк в отдельном процессе).
 */
function applyTuningPragmas(sqlite: Database.Database, mode: 'readwrite' | 'readonly'): void {
  sqlite.pragma(`cache_size = -${PAGE_CACHE_KIB}`);
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (mode === 'readonly') return;
  // Дешёвая уборка статистики; ANALYZE — только когда планов ещё нет (один раз на базу).
  sqlite.pragma('optimize');
  if (hasQueryPlannerStats(sqlite)) return;
  sqlite.pragma('analyze');
}

/**
 * Opens the client DB, encrypted when a key is provided.
 * Handles the legacy plaintext file transparently: if the keyed open can't read it,
 * the file is reopened without a key and encrypted in place via PRAGMA rekey
 * (SQLite3MultipleCiphers supports plaintext→cipher rekey; WAL is checkpointed first).
 * A file that is readable neither way throws — the caller's self-heal path takes over.
 */
export function openSqlite(dbPath: string, encryptionKey?: string | null) {
  let sqlite = new Database(dbPath);
  if (encryptionKey) {
    sqlite.pragma(`key='${encryptionKey}'`);
    if (!probeReadable(sqlite)) {
      sqlite.close();
      sqlite = new Database(dbPath);
      if (!probeReadable(sqlite)) {
        // Neither keyed nor plaintext — genuinely corrupt (or a foreign key).
        // Throw so the self-heal path in main/index.ts backs it up and recreates.
        try {
          sqlite.close();
        } catch {
          // nothing to release beyond the handle
        }
        throw new Error(`sqlite unreadable both with and without db-key: ${dbPath}`);
      }
      // Legacy plaintext DB: encrypt in place.
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
      sqlite.pragma('journal_mode = DELETE');
      sqlite.pragma(`rekey='${encryptionKey}'`);
    }
  }
  const handle = sqlite as unknown as BetterSqlite3.Database;
  lastWritableSqlite = handle;
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  applyTuningPragmas(sqlite, 'readwrite');
  const db = drizzle(handle);
  return { sqlite: handle, db };
}

export function openSqliteReadonly(dbPath: string, encryptionKey?: string | null) {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  if (encryptionKey) {
    sqlite.pragma(`key='${encryptionKey}'`);
    if (!probeReadable(sqlite)) {
      // Plaintext legacy file (not yet migrated by a writable open) — reopen without key.
      sqlite.close();
      const plain = new Database(dbPath, { readonly: true, fileMustExist: true });
      applyTuningPragmas(plain, 'readonly');
      plain.pragma('query_only = ON');
      plain.pragma('foreign_keys = OFF');
      return { sqlite: plain as unknown as BetterSqlite3.Database, db: drizzle(plain as unknown as BetterSqlite3.Database) };
    }
  }
  applyTuningPragmas(sqlite, 'readonly');
  sqlite.pragma('query_only = ON');
  sqlite.pragma('foreign_keys = OFF');
  const handle = sqlite as unknown as BetterSqlite3.Database;
  const db = drizzle(handle);
  return { sqlite: handle, db };
}

export function getSqliteHandle() {
  return lastWritableSqlite;
}
