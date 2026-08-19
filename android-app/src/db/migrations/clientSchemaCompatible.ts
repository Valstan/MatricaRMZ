// Async-порт version-chained мигратора клиента
// (electron-app/src/main/services/migrations/clientSchemaMigrations.ts).
//
// Портирован МЕХАНИЗМ (baseline / цепочка / server-hash / rebuild-вердикт),
// а не исторические шаги 1→12: android-БД всегда создаётся свежей и
// базлайнится сразу на CURRENT_CLIENT_SCHEMA_VERSION — исторический SQL на ней
// не исполняется никогда. ЗЕРКАЛИТЬ сюда нужно только шаги НОВЕЕ 12, когда они
// появятся в electron-файле; пропущенный шаг не теряет данные — buildMigrationChain
// вернёт null и клиент уйдёт в rebuild (пересоздание БД + полный pull), как на
// десктопе. Синхронность констант держит тест clientSchemaCompatible.test.ts.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  SettingsKey,
  settingsGetNumber,
  settingsGetString,
  settingsSetNumber,
  settingsSetString,
} from '../../../../electron-app/src/main/services/settingsStore.js';
import type {
  SyncSchemaSnapshot,
  SyncSchemaTable,
} from '../../../../electron-app/src/main/services/migrations/clientSchemaMigrations.js';

import type { AsyncSqlite } from '../asyncSqlite.js';
import type { AsyncDrizzleDb } from '../drizzleAsync.js';

// Должна совпадать с electron-app (гейт — тест рядом). Не импортируем значение
// напрямую: electron-файл тянет better-sqlite3/node:crypto и в браузерный бандл не годится.
export const CURRENT_CLIENT_SCHEMA_VERSION = 12;

type Migration = {
  from: number;
  to: number;
  name: string;
  up: (db: AsyncDrizzleDb, sqlite: AsyncSqlite) => Promise<void>;
};

// Пусто намеренно: см. шапку файла. Первый реальный элемент появится с шагом 12→13.
const MIGRATIONS: Migration[] = [];

// normalizeSchema — порт 1:1 (parity держит тест: хэши должны совпадать с electron).
function normalizeSchema(snapshot: SyncSchemaSnapshot) {
  const tables: Record<string, SyncSchemaTable> = {};
  const tableNames = Object.keys(snapshot.tables || {}).sort((a, b) => a.localeCompare(b));
  for (const table of tableNames) {
    const info = snapshot.tables[table];
    const columns = (info?.columns ?? [])
      .map((c) => ({
        name: String(c.name),
        notNull: !!c.notNull,
        dataType: c.dataType ?? null,
        default: c.default ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const foreignKeys = (info?.foreignKeys ?? [])
      .map((fk) => ({
        column: String(fk.column),
        refTable: String(fk.refTable),
        refColumn: String(fk.refColumn),
        onUpdate: fk.onUpdate ?? null,
        onDelete: fk.onDelete ?? null,
      }))
      .sort((a, b) => {
        const ak = `${a.column}:${a.refTable}:${a.refColumn}`;
        const bk = `${b.column}:${b.refTable}:${b.refColumn}`;
        return ak.localeCompare(bk);
      });
    const uniqueConstraints = (info?.uniqueConstraints ?? [])
      .map((uq) => ({
        columns: Array.isArray(uq.columns) ? uq.columns.map(String).sort() : [],
        isPrimary: !!uq.isPrimary,
      }))
      .filter((uq) => uq.columns.length > 0)
      .sort((a, b) => {
        const ak = `${a.isPrimary ? 1 : 0}:${a.columns.join(',')}`;
        const bk = `${b.isPrimary ? 1 : 0}:${b.columns.join(',')}`;
        return ak.localeCompare(bk);
      });
    tables[table] = { columns, foreignKeys, uniqueConstraints };
  }
  return { tables };
}

export async function hashServerSchema(snapshot: SyncSchemaSnapshot): Promise<string> {
  const raw = JSON.stringify(normalizeSchema(snapshot));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function buildMigrationChain(fromVersion: number, toVersion: number): Migration[] | null {
  if (fromVersion === toVersion) return [];
  const chain: Migration[] = [];
  let current = fromVersion;
  for (let i = 0; i < 1000 && current < toVersion; i += 1) {
    const next = MIGRATIONS.find((m) => m.from === current);
    if (!next) return null;
    chain.push(next);
    current = next.to;
  }
  return current === toVersion ? chain : null;
}

// settingsStore типизирован под BetterSQLite3Database, но по коду — чистый
// drizzle await-стиль и работает поверх sqlite-proxy. Единая точка приведения.
function asSettingsDb(db: AsyncDrizzleDb): BetterSQLite3Database {
  return db as unknown as BetterSQLite3Database;
}

export async function ensureClientSchemaCompatible(
  db: AsyncDrizzleDb,
  sqlite: AsyncSqlite,
  serverSchema: SyncSchemaSnapshot | null,
  opts?: { log?: (message: string) => void },
): Promise<{ action: 'ok' | 'migrated' | 'rebuild' | 'server_schema_changed'; reason?: string; serverHash?: string | null }> {
  const log = opts?.log ?? (() => {});
  const settingsDb = asSettingsDb(db);
  const storedVersion = await settingsGetNumber(settingsDb, SettingsKey.ClientSchemaVersion, 0);
  const storedHash = await settingsGetString(settingsDb, SettingsKey.ServerSchemaHash);
  const serverHash = serverSchema ? await hashServerSchema(serverSchema) : null;

  if (storedVersion === 0) {
    await settingsSetNumber(settingsDb, SettingsKey.ClientSchemaVersion, CURRENT_CLIENT_SCHEMA_VERSION);
    if (serverHash) await settingsSetString(settingsDb, SettingsKey.ServerSchemaHash, serverHash);
    return { action: 'ok', reason: 'baseline', serverHash };
  }

  if (storedVersion > CURRENT_CLIENT_SCHEMA_VERSION) {
    return { action: 'rebuild', reason: 'client schema downgrade detected', serverHash };
  }

  if (storedVersion < CURRENT_CLIENT_SCHEMA_VERSION) {
    const chain = buildMigrationChain(storedVersion, CURRENT_CLIENT_SCHEMA_VERSION);
    if (!chain) {
      return { action: 'rebuild', reason: `missing migrations ${storedVersion} -> ${CURRENT_CLIENT_SCHEMA_VERSION}`, serverHash };
    }
    try {
      for (const m of chain) {
        log(`schema migration ${m.from} -> ${m.to}: ${m.name}`);
        await m.up(db, sqlite);
      }
      await settingsSetNumber(settingsDb, SettingsKey.ClientSchemaVersion, CURRENT_CLIENT_SCHEMA_VERSION);
      if (serverHash) await settingsSetString(settingsDb, SettingsKey.ServerSchemaHash, serverHash);
      return { action: 'migrated', reason: `migrated ${storedVersion} -> ${CURRENT_CLIENT_SCHEMA_VERSION}`, serverHash };
    } catch (e) {
      return { action: 'rebuild', reason: `migration failed: ${String(e)}`, serverHash };
    }
  }

  if (serverHash && storedHash && serverHash !== storedHash) {
    // Mirror of the electron decision (v3.5.0): a changed server hash must not
    // wipe the local DB — rebuild recreates the same schema while destroying
    // unpushed rows. Absorb and continue; align/repair handles additive drift.
    await settingsSetString(settingsDb, SettingsKey.ServerSchemaHash, serverHash);
    return { action: 'server_schema_changed', reason: 'server schema hash changed', serverHash };
  }

  if (serverHash && serverHash !== storedHash) {
    await settingsSetString(settingsDb, SettingsKey.ServerSchemaHash, serverHash);
  }

  return { action: 'ok', reason: 'compatible', serverHash };
}
