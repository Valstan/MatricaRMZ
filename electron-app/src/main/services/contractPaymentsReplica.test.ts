import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { ContractPayments } from '@matricarmz/shared';

import {
  readContractPaymentsStrict,
  saveContractPaymentsStrict,
} from './contractPaymentsReplica.js';

// Строгая реплика платежей (план contract-payments-strict-2026-10): чтение из реплики,
// запись диффом со статусом pending, правило свежести против EAV на переходный период.
function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE entity_types (id text PRIMARY KEY, code text NOT NULL, name text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE entities (id text PRIMARY KEY, type_id text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_defs (id text PRIMARY KEY, entity_type_id text NOT NULL, code text NOT NULL,
      name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0, meta_json text, created_at integer NOT NULL,
      updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_values (id text PRIMARY KEY, entity_id text NOT NULL, attribute_def_id text NOT NULL,
      value_json text, created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE erp_contract_payment_slots (id text PRIMARY KEY NOT NULL, contract_id text NOT NULL,
      section_key text NOT NULL, engine_brand_id text, engine_id text, contract_price_kop integer,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE erp_contract_payments (id text PRIMARY KEY NOT NULL, slot_id text NOT NULL,
      date text NOT NULL, amount_kop integer NOT NULL, kind text NOT NULL, note text,
      countdown_start integer NOT NULL DEFAULT 0, created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  `);
  sqlite.prepare(`INSERT INTO entity_types (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)`)
    .run('et-con', 'contract', 'Контракт', 1, 1);
  sqlite.prepare(`INSERT INTO entities (id,type_id,created_at,updated_at) VALUES (?,?,?,?)`)
    .run('con-1', 'et-con', 1, 1);
  sqlite.prepare(`INSERT INTO attribute_defs (id,entity_type_id,code,name,data_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run('ad-pay', 'et-con', 'contract_payments', 'Платежи', 'json', 1, 1);
  return { db: drizzle(sqlite), sqlite };
}

const CID = 'con-1';
const SLOT = '22222222-2222-4222-8222-222222222222';
const PAY = '44444444-4444-4444-8444-444444444444';

function sample(): ContractPayments {
  return {
    version: 1,
    slots: [
      {
        id: SLOT,
        sectionKey: 'primary',
        contractPriceKop: 5_000_000,
        payments: [
          { id: PAY, date: '2026-09-01', amountKop: 1_000_000, kind: 'advance', countdownStart: true },
        ],
      },
    ],
  };
}

describe('readContractPaymentsStrict', () => {
  it('пустой контракт — пустые платежи', async () => {
    const { db } = makeDb();
    expect(await readContractPaymentsStrict(db, CID)).toEqual({ version: 1, slots: [] });
  });

  it('запись и чтение round-trip, строки pending', async () => {
    const { db, sqlite } = makeDb();
    const r = await saveContractPaymentsStrict(db, CID, sample(), 1000);
    expect(r.changed).toBe(true);
    expect(await readContractPaymentsStrict(db, CID)).toEqual(sample());
    const statuses = sqlite
      .prepare(`SELECT DISTINCT sync_status AS s FROM erp_contract_payment_slots UNION SELECT DISTINCT sync_status FROM erp_contract_payments`)
      .all();
    expect(statuses).toEqual([{ s: 'pending' }]);
  });

  it('повторная запись того же — changed:false, updated_at не трогаем', async () => {
    const { db, sqlite } = makeDb();
    await saveContractPaymentsStrict(db, CID, sample(), 1000);
    const before = sqlite.prepare(`SELECT updated_at AS u FROM erp_contract_payment_slots`).get() as { u: number };
    const r = await saveContractPaymentsStrict(db, CID, sample(), 2000);
    expect(r.changed).toBe(false);
    const after = sqlite.prepare(`SELECT updated_at AS u FROM erp_contract_payment_slots`).get() as { u: number };
    expect(after.u).toBe(before.u);
  });

  it('дифф: правка суммы, новый платёж, удаление платежа, гашение слота', async () => {
    const { db, sqlite } = makeDb();
    await saveContractPaymentsStrict(db, CID, sample(), 1000);
    const next: ContractPayments = {
      version: 1,
      slots: [
        {
          id: SLOT,
          sectionKey: 'primary',
          contractPriceKop: 5_000_000,
          payments: [
            { id: PAY, date: '2026-09-01', amountKop: 2_000_000, kind: 'advance', countdownStart: true },
            { id: '55555555-5555-4555-8555-555555555555', date: '2026-09-10', amountKop: 500_000, kind: 'final' },
          ],
        },
      ],
    };
    await saveContractPaymentsStrict(db, CID, next, 2000);
    expect(await readContractPaymentsStrict(db, CID)).toEqual(next);
    // Удаляем платёж целиком.
    const cut: ContractPayments = {
      version: 1,
      slots: [{ id: SLOT, sectionKey: 'primary', payments: [] }],
    };
    await saveContractPaymentsStrict(db, CID, cut, 3000);
    const dead = sqlite.prepare(`SELECT count(*) AS c FROM erp_contract_payments WHERE deleted_at IS NOT NULL`).get() as { c: number };
    expect(dead.c).toBe(2);
    expect(await readContractPaymentsStrict(db, CID)).toEqual(cut);
    // Гасим слот — гаснут и его строки.
    await saveContractPaymentsStrict(db, CID, { version: 1, slots: [] }, 4000);
    const deadSlots = sqlite.prepare(`SELECT count(*) AS c FROM erp_contract_payment_slots WHERE deleted_at IS NOT NULL`).get() as { c: number };
    expect(deadSlots.c).toBe(1);
    expect(await readContractPaymentsStrict(db, CID)).toEqual({ version: 1, slots: [] });
  });

  it('свежий EAV побеждает strict, старый — нет', async () => {
    const { db, sqlite } = makeDb();
    await saveContractPaymentsStrict(db, CID, sample(), 1000);
    const eavPayments = {
      version: 1,
      slots: [{ id: SLOT, sectionKey: 'primary', payments: [{ id: PAY, date: '2026-10-01', amountKop: 9, kind: 'advance' }] }],
    };
    sqlite.prepare(`INSERT INTO attribute_values (id,entity_id,attribute_def_id,value_json,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run('av-1', CID, 'ad-pay', JSON.stringify(eavPayments), 500, 500);
    // EAV старше strict (500 < 1000) — читаем strict.
    expect(await readContractPaymentsStrict(db, CID)).toEqual(sample());
    sqlite.prepare(`UPDATE attribute_values SET updated_at = 1500 WHERE id = 'av-1'`).run();
    // EAV новее — читаем EAV.
    expect(await readContractPaymentsStrict(db, CID)).toEqual(eavPayments);
  });
});
