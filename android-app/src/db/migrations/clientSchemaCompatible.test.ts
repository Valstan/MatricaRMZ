// Гейты порта version-chained мигратора:
// 1) константа версии не разъехалась с electron-файлом;
// 2) hashServerSchema (WebCrypto) даёт бит-в-бит тот же hex, что electron (node:crypto);
// 3) baseline/compatible/downgrade/hash-mismatch — вердикты как на десктопе.
import { describe, expect, it } from 'vitest';

import {
  CURRENT_CLIENT_SCHEMA_VERSION as ELECTRON_VERSION,
  hashServerSchema as electronHashServerSchema,
  type SyncSchemaSnapshot,
} from '../../../../electron-app/src/main/services/migrations/clientSchemaMigrations.js';

import { createBetterSqlite3AsyncAdapter } from '../testing/betterSqlite3Adapter.js';
import { createDrizzleAsync } from '../drizzleAsync.js';
import { migrateSqliteAsync } from '../migrate.js';
import {
  CURRENT_CLIENT_SCHEMA_VERSION,
  ensureClientSchemaCompatible,
  hashServerSchema,
} from './clientSchemaCompatible.js';

const sampleSnapshot: SyncSchemaSnapshot = {
  generatedAt: 123,
  tables: {
    zeta: {
      columns: [
        { name: 'b', notNull: true, dataType: 'text' },
        { name: 'a', notNull: false },
      ],
      foreignKeys: [{ column: 'b', refTable: 'alpha', refColumn: 'id', onDelete: 'cascade' }],
      uniqueConstraints: [{ columns: ['b', 'a'] }, { columns: ['id'], isPrimary: true }],
    },
    alpha: {
      columns: [{ name: 'id', notNull: true, dataType: 'text', default: "'x'" }],
      foreignKeys: [],
    },
  },
};

describe('android clientSchemaCompatible', () => {
  it('версия схемы клиента совпадает с electron-файлом (защита от молчаливого дрейфа)', () => {
    expect(CURRENT_CLIENT_SCHEMA_VERSION).toBe(ELECTRON_VERSION);
  });

  it('hashServerSchema идентичен electron-реализации', async () => {
    expect(await hashServerSchema(sampleSnapshot)).toBe(electronHashServerSchema(sampleSnapshot));
  });

  it('свежая БД: baseline до CURRENT, повторный вызов — compatible', async () => {
    const adapter = createBetterSqlite3AsyncAdapter(':memory:');
    await migrateSqliteAsync(adapter);
    const db = createDrizzleAsync(adapter);

    const first = await ensureClientSchemaCompatible(db, adapter, sampleSnapshot);
    expect(first).toMatchObject({ action: 'ok', reason: 'baseline' });

    const second = await ensureClientSchemaCompatible(db, adapter, sampleSnapshot);
    expect(second).toMatchObject({ action: 'ok', reason: 'compatible' });
    await adapter.close();
  });

  it('смена server-hash НЕ даёт rebuild (v3.5.0), downgrade даёт', async () => {
    const adapter = createBetterSqlite3AsyncAdapter(':memory:');
    await migrateSqliteAsync(adapter);
    const db = createDrizzleAsync(adapter);
    await ensureClientSchemaCompatible(db, adapter, sampleSnapshot);

    // Смена серверной схемы при том же локальном hash → absorb, НЕ rebuild:
    // rebuild пересоздал бы ту же клиентскую схему, уничтожив незапушенное.
    const mutated: SyncSchemaSnapshot = {
      generatedAt: 124,
      tables: { ...sampleSnapshot.tables, extra: { columns: [{ name: 'id', notNull: true }], foreignKeys: [] } },
    };
    expect((await ensureClientSchemaCompatible(db, adapter, mutated)).action).toBe('server_schema_changed');
    // Хеш поглощён: повторная проверка с той же схемой — уже compatible.
    expect((await ensureClientSchemaCompatible(db, adapter, mutated)).action).toBe('ok');

    // Версия из будущего → rebuild.
    await adapter.run(`UPDATE sync_state SET value = ? WHERE key = 'schema.clientVersion'`, [
      String(CURRENT_CLIENT_SCHEMA_VERSION + 1),
    ]);
    expect((await ensureClientSchemaCompatible(db, adapter, sampleSnapshot)).action).toBe('rebuild');
    await adapter.close();
  });
});
