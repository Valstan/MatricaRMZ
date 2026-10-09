import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { getOperation, isManualHistoryRow, softDeleteOperation, updateManualEntry, upsertOperation } from './operationService.js';

// Ручные записи ленты истории правятся и удаляются в ленте (текст, дата, примечание).
// Канал общий (`ops:*`), поэтому гейт — здесь, а не доверием к экрану: этап, строку
// работ, переезд и авто-статус этим каналом трогать нельзя — у каждого своя дверь.

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
  return { db: drizzle(sqlite) as any };
}

const manualMeta = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: 'repair_history', action: 'Позвонили заказчику', at: 1000, note: 'перезвонить', ...over });

const seed = (db: any, over: Record<string, unknown> = {}) =>
  upsertOperation(db, {
    id: 'op1',
    engineId: 'e1',
    operationType: 'repair_history_entry',
    status: 'done',
    note: 'Позвонили заказчику',
    performedBy: 'ivanov',
    metaJson: manualMeta(),
    ...over,
  });

describe('updateManualEntry — только ручная запись', () => {
  it('меняет текст, дату и примечание, автора и момент ввода не трогает', async () => {
    const { db } = makeDb();
    await seed(db);
    expect(await updateManualEntry(db, 'op1', { action: 'Приехал курьер', at: 2000, note: 'забрал акт' })).toBe(true);

    const row = (await getOperation(db, 'op1')) as any;
    const meta = JSON.parse(String(row.metaJson));
    expect(meta.action).toBe('Приехал курьер');
    expect(meta.at).toBe(2000);
    expect(meta.note).toBe('забрал акт');
    expect(String(row.performedBy)).toBe('ivanov');
  });

  it('пустое действие отклоняет — строка без него ничего не говорит', async () => {
    const { db } = makeDb();
    await seed(db);
    expect(await updateManualEntry(db, 'op1', { action: '   ' })).toBe(false);
  });

  it('этап этим каналом не правится', async () => {
    const { db } = makeDb();
    await seed(db, {
      metaJson: JSON.stringify({
        kind: 'repair_history',
        action: 'Сборка двигателя',
        entryType: 'stage',
        stage: { code: 'sborka', name: 'Сборка двигателя' },
      }),
    });
    expect(await updateManualEntry(db, 'op1', { note: 'чужое' })).toBe(false);
  });

  it('строка работ и авто-статус этим каналом не правятся', async () => {
    const { db } = makeDb();
    await seed(db, {
      metaJson: JSON.stringify({ kind: 'repair_history', action: 'Укладка', sheet: { typeCode: 'ukladka' } }),
    });
    expect(await updateManualEntry(db, 'op1', { note: 'чужое' })).toBe(false);

    const { db: db2 } = makeDb();
    await seed(db2, {
      metaJson: JSON.stringify({ kind: 'repair_history', action: 'Ремонт начат', auto: true }),
    });
    expect(await updateManualEntry(db2, 'op1', { note: 'чужое' })).toBe(false);
  });

  it('несуществующей строки нет — честный false, а не тихий успех', async () => {
    const { db } = makeDb();
    expect(await updateManualEntry(db, 'nope', { note: 'x' })).toBe(false);
  });
});

describe('isManualHistoryRow — гейт общего канала', () => {
  it('ручная запись проходит, переезд — нет', () => {
    expect(isManualHistoryRow({ metaJson: manualMeta(), operationType: 'repair_history_entry' })).toBe(true);
    expect(isManualHistoryRow({ metaJson: manualMeta(), operationType: 'workshop_transfer' })).toBe(false);
  });

  it('битая мета и её отсутствие — не ручная запись (fail closed)', () => {
    expect(isManualHistoryRow({ metaJson: 'not-json{{{', operationType: 'repair_history_entry' })).toBe(false);
    expect(isManualHistoryRow({ operationType: 'repair_history_entry' })).toBe(false);
  });
});

describe('softDeleteOperation не менялся — удаляет любую строку по id (гейт выше, в IPC)', () => {
  it('ручная запись гасится', async () => {
    const { db } = makeDb();
    await seed(db);
    expect(await softDeleteOperation(db, 'op1')).toBe(true);
  });
});
