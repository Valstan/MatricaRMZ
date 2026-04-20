import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  enqueueWarehouseCommand,
  listDueWarehouseCommands,
  markWarehouseCommandApplied,
  markWarehouseCommandFailed,
} from './warehouseCommandOutboxService.js';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE warehouse_command_outbox (
      id text PRIMARY KEY NOT NULL,
      client_operation_id text NOT NULL,
      command_type text NOT NULL,
      aggregate_type text NOT NULL DEFAULT 'warehouse_document',
      aggregate_id text,
      payload_json text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      next_retry_at integer NOT NULL DEFAULT 0,
      last_error text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX warehouse_command_outbox_client_operation_id_uq ON warehouse_command_outbox(client_operation_id);
    CREATE INDEX warehouse_command_outbox_status_next_retry_idx ON warehouse_command_outbox(status, next_retry_at);
  `);
  return { sqlite, db: drizzle(sqlite) as any };
}

describe('warehouseCommandOutboxService', () => {
  it('enqueues and returns due command', async () => {
    const { sqlite, db } = makeDb();
    try {
      await enqueueWarehouseCommand(db, {
        commandType: 'document_upsert',
        aggregateId: 'doc-1',
        body: { id: 'doc-1', docNo: 'D-1' },
      });
      const due = await listDueWarehouseCommands(db, 10);
      expect(due).toHaveLength(1);
      expect(due[0]?.commandType).toBe('document_upsert');
      expect(due[0]?.body.id).toBe('doc-1');
    } finally {
      sqlite.close();
    }
  });

  it('moves failed command to retry and then applied', async () => {
    const { sqlite, db } = makeDb();
    try {
      const queued = await enqueueWarehouseCommand(db, {
        commandType: 'document_cancel',
        aggregateId: 'doc-2',
        body: { documentId: 'doc-2' },
      });
      await markWarehouseCommandFailed(db, queued.id, 'network');
      const pending = await listDueWarehouseCommands(db, 10);
      expect(pending).toHaveLength(0);
      sqlite.prepare(`UPDATE warehouse_command_outbox SET next_retry_at = 0 WHERE id = ?`).run(queued.id);
      const due = await listDueWarehouseCommands(db, 10);
      expect(due).toHaveLength(1);
      await markWarehouseCommandApplied(db, queued.id);
      const noDue = await listDueWarehouseCommands(db, 10);
      expect(noDue).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
});

