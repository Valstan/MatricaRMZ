import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { getOperation, upsertOperation } from './operationService.js';

// H1: автор строки этапа — навсегда. Правка примечания/статуса не должна переписывать
// «Кто» на правщика; пустой/`local` след офлайн-создания лечится первым настоящим логином.

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE operations (id text PRIMARY KEY, engine_entity_id text NOT NULL, operation_type text NOT NULL,
      status text NOT NULL, note text, performed_at integer, performed_by text, meta_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  `);
  return { sqlite, db: drizzle(sqlite) as any };
}

const input = (over: Record<string, unknown> = {}) => ({
  id: 'op1',
  engineId: 'e1',
  operationType: 'repair_stage',
  status: 'done',
  note: 'n',
  performedBy: 'ivanov',
  metaJson: '{}',
  ...over,
});

async function performedBy(db: any) {
  const row = await getOperation(db, 'op1');
  return String((row as any)?.performedBy ?? '');
}

describe('upsertOperation — автор первой записи сохраняется (H1)', () => {
  it('создание пишет актора, правка его не меняет', async () => {
    const { db } = makeDb();
    expect(await upsertOperation(db, input())).toEqual({ created: true });
    expect(await performedBy(db)).toBe('ivanov');
    expect(await upsertOperation(db, input({ performedBy: 'petrov', note: 'правка' }))).toEqual({ created: false });
    expect(await performedBy(db)).toBe('ivanov');
  });

  it('пустой и local автор лечатся первым настоящим логином, дальше — навсегда', async () => {
    const { db } = makeDb();
    await upsertOperation(db, input({ performedBy: 'local' }));
    await upsertOperation(db, input({ performedBy: 'petrov' }));
    expect(await performedBy(db)).toBe('petrov');
    await upsertOperation(db, input({ performedBy: 'sidorov' }));
    expect(await performedBy(db)).toBe('petrov');
  });
});
