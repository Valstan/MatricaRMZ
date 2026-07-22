// Runtime client DB uses better-sqlite3-multiple-ciphers (same 12.11.1 API as
// better-sqlite3, ChaCha20-Poly1305 at rest) so the local cache is encrypted with a
// per-machine key (docs/plans/_archive/sqlcipher-client-db-2026-07.md). Unit tests keep using
// plain better-sqlite3 ':memory:' — the type stays the better-sqlite3 one.
import Database from 'better-sqlite3-multiple-ciphers';
import type BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

let lastWritableSqlite: BetterSqlite3.Database | null = null;

function probeReadable(sqlite: Database.Database): boolean {
  try {
    sqlite.prepare('SELECT count(*) AS c FROM sqlite_master').get();
    return true;
  } catch {
    return false;
  }
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
      plain.pragma('query_only = ON');
      plain.pragma('foreign_keys = OFF');
      return { sqlite: plain as unknown as BetterSqlite3.Database, db: drizzle(plain as unknown as BetterSqlite3.Database) };
    }
  }
  sqlite.pragma('query_only = ON');
  sqlite.pragma('foreign_keys = OFF');
  const handle = sqlite as unknown as BetterSqlite3.Database;
  const db = drizzle(handle);
  return { sqlite: handle, db };
}

export function getSqliteHandle() {
  return lastWritableSqlite;
}
