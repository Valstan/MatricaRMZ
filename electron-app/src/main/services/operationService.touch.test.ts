import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { SystemIds } from '@matricarmz/shared';

import { softDeleteOperation, touchEngineEntity, updateManualEntry, upsertOperation } from './operationService.js';

// История — часть карточки (владелец 10.10.2026): запись/правка/удаление операции
// двигает entities.updatedAt, иначе «дата изменения» списка стоит на месте.
function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE entities (id text PRIMARY KEY, type_id text,
      created_at integer NOT NULL DEFAULT 0, updated_at integer NOT NULL DEFAULT 0,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
      status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  `);
  sqlite
    .prepare(`INSERT INTO entities (id,type_id,created_at,updated_at,sync_status) VALUES (?,?,?,?,?)`)
    .run('e1', 'et-engine', 100, 100, 'synced');
  return { sqlite, db: drizzle(sqlite) as any };
}

const entityUpdatedAt = (sqlite: any, id: string): number =>
  Number(sqlite.prepare(`SELECT updated_at FROM entities WHERE id = ?`).get(id)?.updated_at ?? NaN);

const manualMeta = () => JSON.stringify({ kind: 'repair_history', action: 'Позвонили', at: 1000 });

describe('touchEngineEntity — история двигает дату карточки', () => {
  it('upsert операции поднимает updatedAt сущности', async () => {
    const { sqlite, db } = makeDb();
    await upsertOperation(db, {
      id: 'op1',
      engineId: 'e1',
      operationType: 'repair_history_entry',
      status: 'done',
      performedBy: 'ivanov',
      metaJson: manualMeta(),
    });
    expect(entityUpdatedAt(sqlite, 'e1')).toBeGreaterThan(100);
  });

  it('правка и удаление операции тоже двигают дату', async () => {
    const { sqlite, db } = makeDb();
    await upsertOperation(db, {
      id: 'op1',
      engineId: 'e1',
      operationType: 'repair_history_entry',
      status: 'done',
      performedBy: 'ivanov',
      metaJson: manualMeta(),
    });
    const afterCreate = entityUpdatedAt(sqlite, 'e1');
    expect(await updateManualEntry(db, 'op1', { note: 'x' })).toBe(true);
    expect(entityUpdatedAt(sqlite, 'e1')).toBeGreaterThanOrEqual(afterCreate);
    expect(await softDeleteOperation(db, 'op1')).toBe(true);
    expect(entityUpdatedAt(sqlite, 'e1')).toBeGreaterThanOrEqual(afterCreate);
  });

  it('контейнерные pseudo-сущности не трогаем', async () => {
    const { sqlite, db } = makeDb();
    await touchEngineEntity(db, SystemIds.SupplyRequestsContainerEntityId);
    await touchEngineEntity(db, SystemIds.WorkOrdersContainerEntityId);
    await touchEngineEntity(db, '');
    expect(entityUpdatedAt(sqlite, 'e1')).toBe(100);
  });
});
