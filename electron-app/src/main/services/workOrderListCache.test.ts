import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { WorkOrderPayload } from '@matricarmz/shared';

import { createWorkOrder, listWorkOrders, listWorkOrdersUsingPart, updateWorkOrder, deleteWorkOrder } from './workOrderService.js';

// Список нарядов переиспользует разбор строки, пока не изменился её updated_at. Проверяем, что
// кэш не отдаёт устаревшее: правка, удаление и поиск обязаны видеть свежее состояние.

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE operations (
      id text PRIMARY KEY NOT NULL,
      engine_entity_id text NOT NULL,
      operation_type text NOT NULL,
      status text NOT NULL,
      note text,
      performed_at integer,
      performed_by text,
      meta_json text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE TABLE audit_log (
      id text PRIMARY KEY NOT NULL,
      actor text NOT NULL,
      action text NOT NULL,
      entity_id text,
      table_name text,
      payload_json text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE TABLE entity_types (
      id text PRIMARY KEY NOT NULL,
      code text NOT NULL,
      name text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    CREATE TABLE entities (
      id text PRIMARY KEY NOT NULL,
      type_id text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
    INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES
      ('type-engine', 'engine', 'Двигатель', 1, 1),
      ('type-part', 'part', 'Деталь', 1, 1),
      ('type-service', 'service', 'Услуга', 1, 1);
    INSERT INTO entities (id, type_id, created_at, updated_at) VALUES
      ('eng-1', 'type-engine', 1, 1),
      ('part-1', 'type-part', 1, 1),
      ('part-2', 'type-part', 1, 1),
      ('service-1', 'type-service', 1, 1);
  `);
  return { sqlite, db: drizzle(sqlite) as any };
}

async function addOrder(db: any, patch: Partial<WorkOrderPayload> = {}): Promise<string> {
  const created = await createWorkOrder(db, 'tester');
  if (!created.ok) throw new Error(created.error);
  const saved = await updateWorkOrder(db, {
    id: created.id,
    payload: { ...created.payload, ...patch } as WorkOrderPayload,
    actor: 'tester',
  });
  if (!saved.ok) throw new Error(saved.error);
  return created.id;
}

function rowsOf(result: Awaited<ReturnType<typeof listWorkOrders>>) {
  if (!result.ok) throw new Error(result.error);
  return result.rows;
}

describe('listWorkOrders (кэш разбора)', () => {
  it('видит правку наряда, сделанную после первого запроса списка', async () => {
    const { sqlite, db } = makeDb();
    try {
      const id = await addOrder(db, { freeWorks: [{ lineNo: 1, serviceId: 'service-1', serviceName: 'Расточка', unit: 'шт', qty: 1, priceRub: 10, amountRub: 10 }] } as Partial<WorkOrderPayload>);
      expect(rowsOf(await listWorkOrders(db))[0]?.workType).toBe('Расточка');

      const current = rowsOf(await listWorkOrders(db))[0];
      expect(current).toBeTruthy();
      await updateWorkOrder(db, {
        id,
        payload: {
          ...(JSON.parse(String((sqlite.prepare(`SELECT meta_json FROM operations WHERE id=?`).get(id) as any).meta_json)) as WorkOrderPayload),
          freeWorks: [{ lineNo: 1, serviceId: 'service-1', serviceName: 'Шлифовка', unit: 'шт', qty: 1, priceRub: 10, amountRub: 10 }],
        },
        actor: 'tester',
      });

      expect(rowsOf(await listWorkOrders(db))[0]?.workType).toBe('Шлифовка');
    } finally {
      sqlite.close();
    }
  });

  it('убирает удалённый наряд из выдачи', async () => {
    const { sqlite, db } = makeDb();
    try {
      const keep = await addOrder(db);
      const drop = await addOrder(db);
      expect(rowsOf(await listWorkOrders(db))).toHaveLength(2);

      await deleteWorkOrder(db, { id: drop, actor: 'tester' });

      const rows = rowsOf(await listWorkOrders(db));
      expect(rows.map((r) => r.id)).toEqual([keep]);
    } finally {
      sqlite.close();
    }
  });

  it('фильтрует по подстроке и по месяцу', async () => {
    const { sqlite, db } = makeDb();
    try {
      await addOrder(db, {
        orderDate: Date.UTC(2026, 2, 15),
        freeWorks: [
          // Номер двигателя нормализация строки сохраняет только вместе с engineId.
          { lineNo: 1, serviceId: 'service-1', serviceName: 'Расточка', unit: 'шт', qty: 1, priceRub: 1, amountRub: 1, engineId: 'eng-1', engineNumber: '77777' },
        ],
      } as Partial<WorkOrderPayload>);
      await addOrder(db, { orderDate: Date.UTC(2026, 5, 15) } as Partial<WorkOrderPayload>);

      expect(rowsOf(await listWorkOrders(db, { q: '77777' }))).toHaveLength(1);
      expect(rowsOf(await listWorkOrders(db, { q: 'расточка' }))).toHaveLength(1);
      expect(rowsOf(await listWorkOrders(db, { q: 'такого-нет' }))).toHaveLength(0);
      // Месяц берётся из orderDate наряда, а не из даты строки.
      const march = rowsOf(await listWorkOrders(db, { month: '2026-03' }));
      expect(march).toHaveLength(1);
      expect(march[0]?.engineNumber).toBe('77777');
    } finally {
      sqlite.close();
    }
  });

  it('поиск по свежему значению не находит старое (кэш стога обновляется)', async () => {
    const { sqlite, db } = makeDb();
    try {
      const id = await addOrder(db, {
        freeWorks: [{ lineNo: 1, serviceId: 'service-1', serviceName: 'Расточка', unit: 'шт', qty: 1, priceRub: 1, amountRub: 1 }],
      } as Partial<WorkOrderPayload>);
      expect(rowsOf(await listWorkOrders(db, { q: 'расточка' }))).toHaveLength(1);

      const stored = JSON.parse(
        String((sqlite.prepare(`SELECT meta_json FROM operations WHERE id=?`).get(id) as any).meta_json),
      ) as WorkOrderPayload;
      await updateWorkOrder(db, {
        id,
        payload: {
          ...stored,
          freeWorks: [{ lineNo: 1, serviceId: 'service-1', serviceName: 'Шлифовка', unit: 'шт', qty: 1, priceRub: 1, amountRub: 1 }],
        },
        actor: 'tester',
      });

      expect(rowsOf(await listWorkOrders(db, { q: 'расточка' }))).toHaveLength(0);
      expect(rowsOf(await listWorkOrders(db, { q: 'шлифовка' }))).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});

describe('listWorkOrdersUsingPart', () => {
  it('возвращает только наряды с этой деталью', async () => {
    const { sqlite, db } = makeDb();
    try {
      const withPart = await addOrder(db, {
        workGroups: [{ groupId: 'g1', partId: 'part-1', partName: 'Гильза', lines: [] }],
      } as unknown as Partial<WorkOrderPayload>);
      await addOrder(db, {
        workGroups: [{ groupId: 'g2', partId: 'part-2', partName: 'Поршень', lines: [] }],
      } as unknown as Partial<WorkOrderPayload>);

      const found = await listWorkOrdersUsingPart(db, 'part-1');
      expect(found.ok).toBe(true);
      if (found.ok) expect(found.rows.map((r) => r.id)).toEqual([withPart]);

      const none = await listWorkOrdersUsingPart(db, 'part-404');
      expect(none.ok && none.rows).toEqual([]);
      const empty = await listWorkOrdersUsingPart(db, '   ');
      expect(empty.ok && empty.rows).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
