import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  listReclamationDefectNaturesFromQueue,
  loadEngineReclamationFactsMap,
} from './engineReclamationReplica.js';

// Факты отслеживания рекламации читаются из локальной реплики очереди заездов
// (`erp_engine_reclamations`). Раньше признак и даты брались из EAV-зеркала
// (`reclamation_flag`), которое поддерживалось только при сохранении карточки:
// «Сохранить очередь» писал очередь, и отслеживания не было ни в одном отчёте.

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 9, 1);

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE erp_engine_reclamations (
      id text PRIMARY KEY NOT NULL,
      engine_id text NOT NULL,
      queue_no integer NOT NULL,
      accepted_at integer,
      shipped_at integer,
      customer_reason text,
      actual_defect text,
      defect_nature text,
      act_number text,
      act_date integer,
      comment text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_server_seq integer,
      deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced'
    );
  `);
  return { sqlite, db: drizzle(sqlite) as never };
}

function seed(
  sqlite: Database.Database,
  row: {
    id: string;
    engineId: string;
    queueNo: number;
    acceptedAt?: number | null;
    shippedAt?: number | null;
    defectNature?: string | null;
    deletedAt?: number | null;
  },
) {
  sqlite
    .prepare(
      `INSERT INTO erp_engine_reclamations
        (id, engine_id, queue_no, accepted_at, shipped_at, customer_reason, actual_defect,
         defect_nature, act_number, act_date, comment, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id,
      row.engineId,
      row.queueNo,
      row.acceptedAt ?? null,
      row.shippedAt ?? null,
      null,
      null,
      row.defectNature ?? null,
      null,
      null,
      null,
      BASE,
      BASE,
      row.deletedAt ?? null,
    );
}

describe('реплика очереди рекламаций → факты отслеживания', () => {
  it('двигатель без рекламаций не попадает в карту', async () => {
    const { db } = makeDb();
    const facts = await loadEngineReclamationFactsMap(db, ['e1']);
    expect(facts.size).toBe(0);
  });

  it('очередь даёт признак и даты текущей рекламации', async () => {
    const { sqlite, db } = makeDb();
    seed(sqlite, { id: 'r1', engineId: 'e1', queueNo: 1, acceptedAt: BASE + 10 * DAY, shippedAt: BASE + 20 * DAY });
    const facts = await loadEngineReclamationFactsMap(db, ['e1']);
    expect(facts.get('e1')).toEqual({
      isReclamation: true,
      acceptedAt: BASE + 10 * DAY,
      shippedAt: BASE + 20 * DAY,
    });
  });

  it('текущая рекламация — последняя в очереди, а не первая', async () => {
    const { sqlite, db } = makeDb();
    seed(sqlite, { id: 'r1', engineId: 'e1', queueNo: 1, acceptedAt: BASE + 10 * DAY, shippedAt: BASE + 20 * DAY });
    seed(sqlite, { id: 'r2', engineId: 'e1', queueNo: 2, acceptedAt: BASE + 30 * DAY, shippedAt: null });
    const facts = await loadEngineReclamationFactsMap(db, ['e1']);
    expect(facts.get('e1')?.acceptedAt).toBe(BASE + 30 * DAY);
    expect(facts.get('e1')?.shippedAt).toBeNull();
  });

  it('снятая строка очереди в счёт не идёт', async () => {
    const { sqlite, db } = makeDb();
    seed(sqlite, { id: 'r1', engineId: 'e1', queueNo: 1, acceptedAt: BASE + 10 * DAY, deletedAt: BASE + 30 * DAY });
    const facts = await loadEngineReclamationFactsMap(db, ['e1']);
    expect(facts.size).toBe(0);
  });

  it('характеры дефекта берутся из очереди', async () => {
    const { sqlite, db } = makeDb();
    seed(sqlite, { id: 'r1', engineId: 'e1', queueNo: 1, acceptedAt: BASE, defectNature: 'Разрушение вкладышей' });
    seed(sqlite, { id: 'r2', engineId: 'e2', queueNo: 1, acceptedAt: BASE, defectNature: 'Дефект КИ' });
    const natures = await listReclamationDefectNaturesFromQueue(db);
    expect(natures).toContain('Разрушение вкладышей');
    expect(natures).toContain('Дефект КИ');
  });
});
