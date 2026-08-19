import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

// Вердикты compat-проверки клиентской схемы. Ключевая регрессия v3.5.0:
// смена СЕРВЕРНОГО схема-хеша больше не сносит локальную БД (rebuild пересоздал
// бы ту же клиентскую схему, уничтожив несинканные строки и сессию) — вместо
// этого хеш поглощается и синк продолжается. Rebuild остаётся только для
// действительно непригодной локальной схемы (downgrade, битая цепочка).

vi.mock('../../database/db.js', () => ({ getSqliteHandle: () => null }));

import { SettingsKey, settingsSetNumber } from '../settingsStore.js';
import {
  CURRENT_CLIENT_SCHEMA_VERSION,
  ensureClientSchemaCompatible,
  hashServerSchema,
  type SyncSchemaSnapshot,
} from './clientSchemaMigrations.js';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE sync_state (key text PRIMARY KEY NOT NULL, value text NOT NULL, updated_at integer NOT NULL);`);
  return drizzle(sqlite);
}

const snapshotA: SyncSchemaSnapshot = {
  generatedAt: 1,
  tables: { entities: { columns: [{ name: 'id', notNull: true }], foreignKeys: [] } },
};
const snapshotB: SyncSchemaSnapshot = {
  generatedAt: 2,
  tables: {
    entities: { columns: [{ name: 'id', notNull: true }, { name: 'extra', notNull: false }], foreignKeys: [] },
  },
};

describe('ensureClientSchemaCompatible verdicts', () => {
  it('first run is a baseline, second with the same schema is compatible', async () => {
    const db = makeDb();
    expect((await ensureClientSchemaCompatible(db, snapshotA)).action).toBe('ok');
    expect((await ensureClientSchemaCompatible(db, snapshotA))).toMatchObject({ action: 'ok', reason: 'compatible' });
  });

  it('server hash change is absorbed, NOT a rebuild', async () => {
    const db = makeDb();
    await ensureClientSchemaCompatible(db, snapshotA);
    expect(hashServerSchema(snapshotA)).not.toBe(hashServerSchema(snapshotB));

    const verdict = await ensureClientSchemaCompatible(db, snapshotB);
    expect(verdict.action).toBe('server_schema_changed');
    // The new hash is stored: the next check with the same server schema is clean.
    expect((await ensureClientSchemaCompatible(db, snapshotB)).action).toBe('ok');
  });

  it('client schema downgrade still rebuilds', async () => {
    const db = makeDb();
    await ensureClientSchemaCompatible(db, snapshotA);
    await settingsSetNumber(db, SettingsKey.ClientSchemaVersion, CURRENT_CLIENT_SCHEMA_VERSION + 1);
    expect((await ensureClientSchemaCompatible(db, snapshotA)).action).toBe('rebuild');
  });
});
