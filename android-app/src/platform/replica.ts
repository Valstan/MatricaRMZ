// Открытие локальной реплики на планшете: SQLCipher-БД через
// @capacitor-community/sqlite. Ключ БД держит сам плагин (EncryptedSharedPreferences
// поверх Android Keystore) — отдельного хранилища секретов у нас нет, слой
// шифрования ровно один (см. шапку shims/electron.ts).
//
// Fail-closed: если шифрование поднять не удалось, БД всё равно открывается, но
// хук encryptionAvailable() отдаёт false — и authService сам перестаёт класть
// сессию на диск (перелогин после рестарта). Тихо «как-нибудь» не работаем.
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';

import type { AsyncSqlite } from '../db/asyncSqlite.js';
import { createCapacitorAsyncSqlite } from './capacitorSqlite.js';

export const REPLICA_DB_NAME = 'matricarmz';

export type AndroidReplica = {
  sqlite: AsyncSqlite;
  /** Ключ реплики лежит в Keystore и БД зашифрована. */
  encrypted: boolean;
  /** Снос файлов реплики для reset-флоу синка (после — relaunch). */
  reset: () => Promise<void>;
};

function generatePassphrase(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function ensureSecret(conn: SQLiteConnection): Promise<boolean> {
  try {
    const stored = await conn.isSecretStored();
    if (!stored.result) await conn.setEncryptionSecret(generatePassphrase());
    return true;
  } catch (e) {
    console.error('[android-replica] Keystore недоступен, реплика без шифрования:', e);
    return false;
  }
}

export async function openAndroidReplica(): Promise<AndroidReplica> {
  const conn = new SQLiteConnection(CapacitorSQLite);
  await conn.checkConnectionsConsistency();

  const encrypted = await ensureSecret(conn);
  const mode = encrypted ? 'secret' : 'no-encryption';

  const existing = await conn.isConnection(REPLICA_DB_NAME, false);
  const db: SQLiteDBConnection = existing.result
    ? await conn.retrieveConnection(REPLICA_DB_NAME, false)
    : await conn.createConnection(REPLICA_DB_NAME, encrypted, mode, 1, false);
  if (!(await db.isDBOpen()).result) await db.open();

  const sqlite = createCapacitorAsyncSqlite(db);
  // Те же прагмы, что ставит стендовый адаптер: без них паритет поведения
  // (WAL + внешние ключи) держался бы только на десктопе.
  await sqlite.exec('PRAGMA journal_mode = WAL;');
  await sqlite.exec('PRAGMA foreign_keys = ON;');

  return {
    sqlite,
    encrypted,
    reset: async () => {
      await db.delete();
      await conn.closeConnection(REPLICA_DB_NAME, false);
    },
  };
}
