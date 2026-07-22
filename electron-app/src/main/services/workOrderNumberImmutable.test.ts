import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { WorkOrderPayload } from '@matricarmz/shared';

import { createWorkOrder, setWorkOrderNumber, updateWorkOrder } from './workOrderService.js';

// Guard for the «№ новый навсегда» data-loss incident: a stale recovery draft (snapshot
// taken before deferred-create materialization) carries workOrderNumber: 0 — committing it
// over a materialized order must never downgrade the assigned number.

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
  `);
  return { sqlite, db: drizzle(sqlite) as any };
}

async function materialize(db: any): Promise<{ id: string; payload: WorkOrderPayload; number: number }> {
  const created = await createWorkOrder(db, 'tester');
  if (!created.ok) throw new Error(created.error);
  const saved = await updateWorkOrder(db, { id: created.id, payload: created.payload, actor: 'tester' });
  if (!saved.ok) throw new Error(saved.error);
  return { id: created.id, payload: created.payload, number: saved.workOrderNumber };
}

function storedNumber(sqlite: Database.Database, id: string): number {
  const row = sqlite.prepare(`SELECT meta_json FROM operations WHERE id = ?`).get(id) as { meta_json: string };
  return Number((JSON.parse(row.meta_json) as WorkOrderPayload).workOrderNumber ?? 0);
}

describe('work order number immutability', () => {
  it('first save materializes the row and assigns max+1', async () => {
    const { sqlite, db } = makeDb();
    try {
      const first = await materialize(db);
      const second = await materialize(db);
      expect(first.number).toBe(1);
      expect(second.number).toBe(2);
      expect(storedNumber(sqlite, second.id)).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it('committing a stale draft payload (number 0) keeps the assigned number', async () => {
    const { sqlite, db } = makeDb();
    try {
      const order = await materialize(db);
      // Stale recovery snapshot: taken before materialization → number 0.
      const stale: WorkOrderPayload = { ...order.payload, workOrderNumber: 0 };
      const saved = await updateWorkOrder(db, { id: order.id, payload: stale, actor: 'tester' });
      expect(saved.ok).toBe(true);
      if (saved.ok) expect(saved.workOrderNumber).toBe(order.number);
      expect(storedNumber(sqlite, order.id)).toBe(order.number);
    } finally {
      sqlite.close();
    }
  });

  it('a foreign number in the payload cannot overwrite the assigned one', async () => {
    const { sqlite, db } = makeDb();
    try {
      const order = await materialize(db);
      const tampered: WorkOrderPayload = { ...order.payload, workOrderNumber: 999 };
      const saved = await updateWorkOrder(db, { id: order.id, payload: tampered, actor: 'tester' });
      expect(saved.ok).toBe(true);
      if (saved.ok) expect(saved.workOrderNumber).toBe(order.number);
      expect(storedNumber(sqlite, order.id)).toBe(order.number);
    } finally {
      sqlite.close();
    }
  });

  it('heals an already-broken row (stored number 0) by assigning a fresh number on save', async () => {
    const { sqlite, db } = makeDb();
    try {
      const order = await materialize(db); // consumes number 1
      const broken = await materialize(db); // number 2
      // Simulate the past incident: stored payload downgraded to 0.
      sqlite
        .prepare(`UPDATE operations SET meta_json = ? WHERE id = ?`)
        .run(JSON.stringify({ ...broken.payload, workOrderNumber: 0 }), broken.id);
      expect(storedNumber(sqlite, broken.id)).toBe(0);

      const saved = await updateWorkOrder(db, {
        id: broken.id,
        payload: { ...broken.payload, workOrderNumber: 0 },
        actor: 'tester',
      });
      expect(saved.ok).toBe(true);
      if (saved.ok) {
        expect(saved.workOrderNumber).toBeGreaterThan(0);
        expect(saved.workOrderNumber).not.toBe(order.number);
        expect(storedNumber(sqlite, broken.id)).toBe(saved.workOrderNumber);
      }
    } finally {
      sqlite.close();
    }
  });
});

// Смена номера суперадмином — единственный легальный путь правки номера (IPC проверяет роль).
describe('setWorkOrderNumber (superadmin repair path)', () => {
  it('assigns a free number and keeps it through an ordinary save', async () => {
    const { sqlite, db } = makeDb();
    try {
      const order = await materialize(db);
      const changed = await setWorkOrderNumber(db, { id: order.id, workOrderNumber: 85, actor: 'root' });
      expect(changed.ok).toBe(true);
      expect(storedNumber(sqlite, order.id)).toBe(85);

      const saved = await updateWorkOrder(db, { id: order.id, payload: order.payload, actor: 'tester' });
      expect(saved.ok).toBe(true);
      if (saved.ok) expect(saved.workOrderNumber).toBe(85);
      expect(storedNumber(sqlite, order.id)).toBe(85);
    } finally {
      sqlite.close();
    }
  });

  it('repairs a zeroed number without touching the neighbour', async () => {
    const { sqlite, db } = makeDb();
    try {
      const keep = await materialize(db);
      const broken = await materialize(db);
      sqlite
        .prepare(`UPDATE operations SET meta_json = ? WHERE id = ?`)
        .run(JSON.stringify({ ...broken.payload, workOrderNumber: 0 }), broken.id);

      const changed = await setWorkOrderNumber(db, { id: broken.id, workOrderNumber: 86, actor: 'root' });
      expect(changed.ok).toBe(true);
      expect(storedNumber(sqlite, broken.id)).toBe(86);
      expect(storedNumber(sqlite, keep.id)).toBe(keep.number);
      const note = sqlite.prepare(`SELECT note FROM operations WHERE id = ?`).get(broken.id) as { note: string };
      expect(note.note).toBe('Наряд №86');
    } finally {
      sqlite.close();
    }
  });

  it('blocks a number already taken by another live order', async () => {
    const { sqlite, db } = makeDb();
    try {
      const first = await materialize(db);
      const second = await materialize(db);
      const changed = await setWorkOrderNumber(db, { id: second.id, workOrderNumber: first.number, actor: 'root' });
      expect(changed.ok).toBe(false);
      if (!changed.ok) expect(changed.error).toContain('уже занят');
      expect(storedNumber(sqlite, second.id)).toBe(second.number);
    } finally {
      sqlite.close();
    }
  });

  it('rejects non-positive and non-integer numbers', async () => {
    const { sqlite, db } = makeDb();
    try {
      const order = await materialize(db);
      for (const bad of [0, -3, 1.5, Number.NaN, 1_000_000]) {
        const changed = await setWorkOrderNumber(db, { id: order.id, workOrderNumber: bad, actor: 'root' });
        expect(changed.ok, `number ${bad} must be rejected`).toBe(false);
      }
      expect(storedNumber(sqlite, order.id)).toBe(order.number);
    } finally {
      sqlite.close();
    }
  });

  it('writes an audit row with the old and the new number', async () => {
    const { sqlite, db } = makeDb();
    try {
      const order = await materialize(db);
      await setWorkOrderNumber(db, { id: order.id, workOrderNumber: 42, actor: 'root' });
      const row = sqlite
        .prepare(`SELECT actor, action, payload_json FROM audit_log WHERE action = 'work_order.number_change'`)
        .get() as { actor: string; action: string; payload_json: string };
      expect(row?.actor).toBe('root');
      const payload = JSON.parse(row.payload_json) as { from: number; to: number };
      expect(payload.from).toBe(order.number);
      expect(payload.to).toBe(42);
    } finally {
      sqlite.close();
    }
  });
});
