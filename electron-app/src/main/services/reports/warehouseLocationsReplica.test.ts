import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { getWarehouseLocationsForReport, getWarehouseLocationsFromReplica } from './context.js';

// План Б (07.09.2026): справочник складов и цехов приезжает в клиентскую реплику, а не
// запрашивается по сети при каждом отчёте. Причина — M112: тип локации решает, цех это или
// склад, и без связи отчёт «Выработка цехов» отдавал ноль строк, неотличимый от «за период
// ничего не ремонтировали».
function makeDb(withTable = true) {
  const sqlite = new Database(':memory:');
  if (withTable) {
    sqlite.exec(`
      CREATE TABLE warehouse_locations (
        id text PRIMARY KEY NOT NULL,
        type text NOT NULL,
        code text NOT NULL,
        name text NOT NULL,
        workshop_id text,
        is_active integer NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        metadata_json text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        last_server_seq integer,
        deleted_at integer,
        sync_status text NOT NULL DEFAULT 'synced'
      );
      INSERT INTO warehouse_locations (id, type, code, name, created_at, updated_at) VALUES
        ('loc-1','workshop','workshop_3','Цех №3', 1, 1),
        ('loc-2','system','default','Основной склад', 1, 1);
      INSERT INTO warehouse_locations (id, type, code, name, created_at, updated_at, deleted_at) VALUES
        ('loc-3','regular','old','Снятая локация', 1, 1, 2);
    `);
  }
  return drizzle(sqlite);
}

describe('справочник складов читается из локальной реплики', () => {
  it('отдаёт живые локации с типом и кодом — по ним отчёт отличает цех от склада', async () => {
    const byId = await getWarehouseLocationsFromReplica(makeDb());
    expect(byId.get('loc-1')).toEqual({ code: 'workshop_3', name: 'Цех №3', type: 'workshop' });
    expect(byId.get('loc-2')?.type).toBe('system');
  });

  it('удалённые локации в справочник не попадают', async () => {
    const byId = await getWarehouseLocationsFromReplica(makeDb());
    expect(byId.has('loc-3')).toBe(false);
    expect(byId.size).toBe(2);
  });

  it('таблицы ещё нет (клиент до 0024) — пустая карта, а не падение отчёта', async () => {
    const byId = await getWarehouseLocationsFromReplica(makeDb(false));
    expect(byId.size).toBe(0);
  });

  it('реплика заполнена — в сеть не ходим вовсе', async () => {
    // ctx без sysDb и apiBaseUrl: сетевой путь на таком ctx вернул бы пустую карту,
    // поэтому непустой результат доказывает, что ответ пришёл из реплики.
    const byId = await getWarehouseLocationsForReport(makeDb(), {});
    expect(byId.size).toBe(2);
  });

  it('реплика пуста — откатываемся на сеть (клиент до первого pull)', async () => {
    const byId = await getWarehouseLocationsForReport(makeDb(false), {});
    expect(byId.size).toBe(0); // сеть в тесте недоступна, но путь пройден без падения
  });
});

// Две цепочки миграций клиента ведут одну и ту же схему: файл drizzle (свежая установка) и
// `ensureClientSchemaParity` в migrate.ts (уже установленные клиенты). Разошлись — часть парка
// получает таблицу, часть нет, и pull падает у половины (прецедент 0022).
describe('обе цепочки миграций заводят одну и ту же таблицу', () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const MIGRATION = src('../../../../drizzle/0024_warehouse_locations_replica.sql');
  const PARITY = src('../../database/migrate.ts');

  const columns = [
    'type',
    'code',
    'name',
    'workshop_id',
    'is_active',
    'sort_order',
    'metadata_json',
    'last_server_seq',
    'sync_status',
  ];

  /** DDL без комментариев: слово CHECK в пояснении — не ограничение схемы. */
  function ddlOnly(sql: string): string {
    return sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
  }

  it('файл миграции создаёт таблицу со всеми колонками контракта', () => {
    expect(MIGRATION).toContain('CREATE TABLE IF NOT EXISTS `warehouse_locations`');
    for (const column of columns) expect(MIGRATION, `нет колонки ${column}`).toContain(`\`${column}\``);
  });

  it('parity-путь заводит ту же таблицу теми же колонками', () => {
    expect(PARITY).toContain('CREATE TABLE IF NOT EXISTS warehouse_locations');
    for (const column of columns) expect(PARITY, `нет колонки ${column}`).toContain(`${column} `);
  });

  it('реплика не строже сервера: ни CHECK, ни UNIQUE по коду', () => {
    // Строгая реплика роняет pull всему парку — миграция 0020 так и называется,
    // «replica not stricter», и повод у неё был живой.
    const migrationDdl = ddlOnly(MIGRATION);
    expect(migrationDdl).not.toContain('CHECK');
    expect(migrationDdl).not.toContain('UNIQUE INDEX');

    const parityFrom = PARITY.slice(PARITY.indexOf('CREATE TABLE IF NOT EXISTS warehouse_locations'));
    const parityDdl = ddlOnly(parityFrom.slice(0, parityFrom.indexOf('`);')));
    expect(parityDdl).not.toContain('CHECK');
    expect(parityDdl).not.toContain('UNIQUE');
  });
});
