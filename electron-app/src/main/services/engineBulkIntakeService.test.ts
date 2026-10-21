import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ENGINE_BULK_INTAKE_MAX } from '@matricarmz/shared';

import { applyEngineBulkIntake, previewEngineBulkIntake } from './engineBulkIntakeService.js';

const here = dirname(fileURLToPath(import.meta.url));

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(here, '../../../drizzle/0032_erp_engine_cards_replica.sql'), 'utf8'));
  sqlite.exec(`
    CREATE TABLE entity_types (id text PRIMARY KEY NOT NULL, code text NOT NULL, name text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE entities (id text PRIMARY KEY NOT NULL, type_id text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer, deleted_at integer,
      sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_defs (id text PRIMARY KEY NOT NULL, entity_type_id text NOT NULL, code text NOT NULL,
      name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0, sort_order integer NOT NULL DEFAULT 0,
      meta_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_values (id text PRIMARY KEY NOT NULL, entity_id text NOT NULL, attribute_def_id text NOT NULL,
      value_json text, created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE operations (id text PRIMARY KEY NOT NULL, engine_entity_id text NOT NULL,
      operation_type text NOT NULL, status text NOT NULL, note text, performed_at integer, performed_by text,
      meta_json text, created_at integer NOT NULL, updated_at integer NOT NULL, last_server_seq integer,
      deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');

    INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES
      ('t-engine', 'engine', 'Engine', 1, 1),
      ('t-brand', 'engine_brand', 'Brand', 1, 1),
      ('t-customer', 'customer', 'Customer', 1, 1),
      ('t-contract', 'contract', 'Contract', 1, 1);

    INSERT INTO entities (id, type_id, created_at, updated_at) VALUES
      ('brand-bosch', 't-brand', 1, 1),
      ('cust-1', 't-customer', 1, 1),
      ('cust-2', 't-customer', 1, 1),
      ('contract-1', 't-contract', 2, 2),
      ('contract-2', 't-contract', 2, 2);

    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, created_at, updated_at) VALUES
      ('d-brand-name', 't-brand', 'name', 'Марка', 'text', 1, 1),
      ('d-cust-name', 't-customer', 'name', 'Контрагент', 'text', 1, 1),
      ('d-contract-name', 't-contract', 'number', 'Номер', 'text', 1, 1),
      ('d-contract-cust', 't-contract', 'customer_id', 'Контрагент', 'text', 1, 1),
      ('d-engine-number', 't-engine', 'engine_number', 'Номер двигателя', 'text', 1, 1),
      ('d-engine-arrival', 't-engine', 'arrival_date', 'Дата прихода', 'date', 1, 1),
      ('d-engine-brand', 't-engine', 'engine_brand', 'Марка', 'text', 1, 1),
      ('d-engine-brand-id', 't-engine', 'engine_brand_id', 'Марка (id)', 'text', 1, 1),
      ('d-engine-cust', 't-engine', 'customer_id', 'Контрагент', 'text', 1, 1),
      ('d-engine-contract', 't-engine', 'contract_id', 'Договор', 'text', 1, 1),
      ('d-engine-internal', 't-engine', 'engine_internal_number', 'Внутренний номер', 'text', 1, 1),
      ('d-engine-internal-year', 't-engine', 'engine_internal_number_year', 'Год номера', 'number', 1, 1);

    INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES
      ('v-1', 'brand-bosch', 'd-brand-name', '"Bosch"', 1, 1),
      ('v-2', 'cust-1', 'd-cust-name', '"Завод №1"', 1, 1),
      ('v-3', 'cust-2', 'd-cust-name', '"Завод №2"', 1, 1),
      ('v-4', 'contract-1', 'd-contract-name', '"Д-1"', 2, 2),
      ('v-5', 'contract-1', 'd-contract-cust', '"cust-1"', 2, 2),
      ('v-6', 'contract-2', 'd-contract-name', '"Д-2"', 2, 2),
      ('v-7', 'contract-2', 'd-contract-cust', '"cust-2"', 2, 2);
  `);
  return sqlite;
}

function deps(sqlite: Database.Database, canWriteStageRow = false) {
  return { db: drizzle(sqlite), actor: 'tester', canWriteStageRow };
}

// Даты — от «сегодня», а не жёстким литералом: создание карточки best-effort ставит этап
// «Создание карточки» моментом записи (Москва), и субординация дат отказала бы дефектовке,
// начни тест жить дольше своего календарного дня (поймано CI 21.10: «дефектовка» 20.10
// оказалась раньше авто-метки 21.10).
const ARRIVAL = Date.now() - 5 * 86_400_000;
const DEFECT = Date.now();

function cardRow(sqlite: Database.Database, id: string) {
  return sqlite
    .prepare('SELECT engine_number AS n, engine_brand_id AS b, engine_brand AS bl, customer_id AS c, contract_id AS k, arrival_date AS a, engine_internal_number AS i, engine_internal_number_year AS y FROM erp_engine_cards WHERE id = ?')
    .get(id) as Record<string, unknown>;
}

function stageCodes(sqlite: Database.Database, engineId: string): string[] {
  const rows = sqlite
    .prepare('SELECT meta_json AS m FROM operations WHERE engine_entity_id = ? AND deleted_at IS NULL')
    .all(engineId) as Array<{ m: string }>;
  return rows.map((row) => String((JSON.parse(row.m) as { stage?: { code?: string } }).stage?.code ?? ''));
}

describe('previewEngineBulkIntake', () => {
  it('находит дубль в строгой реплике и помечает новый номер', async () => {
    const sqlite = makeDb();
    sqlite
      .prepare('INSERT INTO erp_engine_cards (id, engine_number, arrival_date, engine_brand, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('e-old', 'AAA-111', Date.parse('2025-03-01T12:00:00'), 'Bosch', 1, 1);
    const preview = await previewEngineBulkIntake(drizzle(sqlite), 'AAA-111 bbb-222');
    expect(preview.rows.map((r) => r.number)).toEqual(['AAA-111', 'bbb-222']);
    expect(preview.rows[0]?.existing?.id).toBe('e-old');
    expect(preview.rows[1]?.existing).toBeNull();
    expect(preview.overflow).toBe(0);
    sqlite.close();
  });

  it('подсказывает похожий номер, когда точного совпадения нет', async () => {
    const sqlite = makeDb();
    sqlite
      .prepare('INSERT INTO erp_engine_cards (id, engine_number, created_at, updated_at) VALUES (?,?,?,?)')
      .run('e-old', 'AAA-111', 1, 1);
    const preview = await previewEngineBulkIntake(drizzle(sqlite), 'AAA-112 AAA-111');
    expect(preview.rows[1]?.existing?.id).toBe('e-old');
    // Точное совпадение — гейт дублей, подсказка ему не нужна.
    expect(preview.rows[1]?.similar).toEqual([]);
    expect(preview.rows[0]?.similar.map((s) => s.engineNumber)).toEqual(['AAA-111']);
    sqlite.close();
  });

  it('видит двигатель, который есть только в EAV (до pull реплики)', async () => {
    const sqlite = makeDb();
    sqlite.exec(`
      INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('e-eav', 't-engine', 1, 1);
      INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
        VALUES ('v-num', 'e-eav', 'd-engine-number', '"CCC-333"', 1, 1),
               ('v-arr', 'e-eav', 'd-engine-arrival', '1750000000000', 1, 1);
    `);
    const preview = await previewEngineBulkIntake(drizzle(sqlite), 'ccc-333');
    expect(preview.rows[0]?.existing?.id).toBe('e-eav');
    expect(preview.rows[0]?.existing?.arrivalDate).toBe(1750000000000);
    sqlite.close();
  });

  it('отдаёт карточку целиком: марку, договор, внутренний номер и наличие этапа дефектовки', async () => {
    const sqlite = makeDb();
    sqlite
      .prepare(
        'INSERT INTO erp_engine_cards (id, engine_number, engine_brand_id, engine_brand, customer_id, contract_id, engine_internal_number, engine_internal_number_year, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run('e-full', 'FULL-1', 'brand-bosch', 'Bosch', 'cust-1', 'contract-1', '41', 2026, 1, 1);
    sqlite
      .prepare(
        `INSERT INTO operations (id, engine_entity_id, operation_type, status, meta_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        'op-1',
        'e-full',
        'repair_history_entry',
        'done',
        JSON.stringify({
          kind: 'repair_history',
          action: 'Разборка/Дефектовка',
          entryType: 'stage',
          at: DEFECT,
          stage: { code: 'disassembly_defect', name: 'Разборка/Дефектовка' },
        }),
        1,
        1,
      );
    const preview = await previewEngineBulkIntake(drizzle(sqlite), 'full-1');
    expect(preview.rows[0]?.existing).toMatchObject({
      id: 'e-full',
      engineBrandId: 'brand-bosch',
      customerId: 'cust-1',
      contractId: 'contract-1',
      internalNumber: '41',
      internalNumberYear: 2026,
      hasDefectStage: true,
    });
    sqlite.close();
  });

  it('внутренний повтор помечает repeatedInBatch', async () => {
    const sqlite = makeDb();
    const preview = await previewEngineBulkIntake(drizzle(sqlite), 'X-1\nX-1\nX-2');
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]?.repeatedInBatch).toBe(true);
    expect(preview.rows[1]?.repeatedInBatch).toBe(false);
    sqlite.close();
  });

  it('список сверх предела отдаёт overflow', async () => {
    const sqlite = makeDb();
    const text = Array.from({ length: ENGINE_BULK_INTAKE_MAX + 2 }, (_, i) => `N-${i}`).join(' ');
    const preview = await previewEngineBulkIntake(drizzle(sqlite), text);
    expect(preview.overflow).toBe(2);
    sqlite.close();
  });
});

describe('applyEngineBulkIntake', () => {
  it('без общих полей заводит карточку с одним номером — все поля необязательны', async () => {
    const sqlite = makeDb();
    const r = await applyEngineBulkIntake(deps(sqlite), {
      rows: [{ number: 'NEW-1', action: 'create' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(1);
    const row = cardRow(sqlite, r.createdIds[0] ?? '');
    expect(row).toMatchObject({ n: 'NEW-1', b: null, c: null, k: null, a: null, i: null });
    sqlite.close();
  });

  it('договор другого контрагента не принимает', async () => {
    const sqlite = makeDb();
    const r = await applyEngineBulkIntake(deps(sqlite), {
      brandId: 'brand-bosch',
      customerId: 'cust-1',
      contractId: 'contract-2',
      arrivalDate: ARRIVAL,
      rows: [{ number: 'NEW-1', action: 'create' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('другому контрагенту');
    sqlite.close();
  });

  it('контрагента берёт из договора, если выбран только договор', async () => {
    const sqlite = makeDb();
    const r = await applyEngineBulkIntake(deps(sqlite), {
      contractId: 'contract-1',
      rows: [{ number: 'NEW-1', action: 'create' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(cardRow(sqlite, r.createdIds[0] ?? '')).toMatchObject({ c: 'cust-1', k: 'contract-1' });
    sqlite.close();
  });

  it('заводит карточки с маркой, контрагентом, договором и датой прихода', async () => {
    const sqlite = makeDb();
    const r = await applyEngineBulkIntake(deps(sqlite), {
      brandId: 'brand-bosch',
      customerId: 'cust-1',
      contractId: 'contract-1',
      arrivalDate: ARRIVAL,
      rows: [
        { number: 'NEW-1', action: 'create' },
        { number: 'NEW-2', action: 'create' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(2);
    const rows = sqlite
      .prepare('SELECT engine_number AS n, engine_brand AS b, customer_id AS c, contract_id AS k, arrival_date AS a FROM erp_engine_cards ORDER BY engine_number')
      .all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.n)).toEqual(['NEW-1', 'NEW-2']);
    expect(rows[0]).toMatchObject({ b: 'Bosch', c: 'cust-1', k: 'contract-1', a: ARRIVAL });
    sqlite.close();
  });

  it('внутренний номер пишется в карточку построчно, со своим годом', async () => {
    const sqlite = makeDb();
    const r = await applyEngineBulkIntake(deps(sqlite), {
      brandId: 'brand-bosch',
      rows: [
        { number: 'NEW-1', action: 'create', internalNumber: '41/26' },
        { number: 'NEW-2', action: 'create', internalNumber: '42' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const first = cardRow(sqlite, r.createdIds[0] ?? '');
    const second = cardRow(sqlite, r.createdIds[1] ?? '');
    expect(first).toMatchObject({ i: '41', y: 2026 });
    expect(second).toMatchObject({ i: '42', y: new Date().getFullYear() });
    sqlite.close();
  });

  it('дата дефектовки ставит этап «Разборка/Дефектовка» один раз', async () => {
    const sqlite = makeDb();
    const r = await applyEngineBulkIntake(deps(sqlite, true), {
      arrivalDate: ARRIVAL,
      defectDate: DEFECT,
      rows: [{ number: 'NEW-1', action: 'create' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = r.createdIds[0] ?? '';
    expect(r.defectStageMissed).toBe(0);
    expect(stageCodes(sqlite, id)).toContain('disassembly_defect');
    sqlite.close();
  });

  it('без права писать этапы дата дефектовки не теряется молча — попадает в итог', async () => {
    const sqlite = makeDb();
    const r = await applyEngineBulkIntake(deps(sqlite, false), {
      defectDate: DEFECT,
      rows: [{ number: 'NEW-1', action: 'create' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(1);
    expect(r.defectStageMissed).toBe(1);
    expect(r.defectStageError).toContain('права');
    sqlite.close();
  });

  it('дубль по умолчанию пропускается, повторный заезд — заводится с флагом и ссылкой', async () => {
    const sqlite = makeDb();
    sqlite.exec(`
      INSERT INTO erp_engine_cards (id, engine_number, created_at, updated_at) VALUES
        ('e-old', 'DUP-1', 1, 1), ('e-old-2', 'DUP-2', 1, 1);
      INSERT INTO entities (id, type_id, created_at, updated_at) VALUES
        ('e-old', 't-engine', 1, 1), ('e-old-2', 't-engine', 1, 1);
      -- Тот же номер лежит и в EAV — именно его читает гейт дублей при записи карточки.
      INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at) VALUES
        ('v-dup', 'e-old', 'd-engine-number', '"DUP-1"', 1, 1),
        ('v-dup-2', 'e-old-2', 'd-engine-number', '"DUP-2"', 1, 1);
    `);
    const r = await applyEngineBulkIntake(deps(sqlite), {
      brandId: 'brand-bosch',
      customerId: 'cust-1',
      contractId: 'contract-1',
      arrivalDate: ARRIVAL,
      rows: [
        { number: 'DUP-1', action: 'skip' },
        { number: 'DUP-2', action: 'repeat_arrival', previousEngineId: 'e-old-2' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(1);
    expect(r.skipped).toBe(1);
    const row = sqlite
      .prepare('SELECT engine_number AS n, repeat_arrival_flag AS f, previous_arrival_id AS p FROM erp_engine_cards WHERE id NOT IN (?,?)')
      .get('e-old', 'e-old-2') as Record<string, unknown>;
    expect(row).toMatchObject({ n: 'DUP-2', f: 1, p: 'e-old-2' });
    sqlite.close();
  });

  it('«обновить» дописывает только недостающее и не перезаписывает заполненное', async () => {
    const sqlite = makeDb();
    sqlite.exec(`
      INSERT INTO erp_engine_cards (id, engine_number, customer_id, created_at, updated_at)
        VALUES ('e-old', 'OLD-1', 'cust-2', 1, 1);
      INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('e-old', 't-engine', 1, 1);
      INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
        VALUES ('v-old-num', 'e-old', 'd-engine-number', '"OLD-1"', 1, 1);
    `);
    const r = await applyEngineBulkIntake(deps(sqlite), {
      brandId: 'brand-bosch',
      customerId: 'cust-1',
      contractId: 'contract-1',
      arrivalDate: ARRIVAL,
      rows: [{ number: 'OLD-1', action: 'update', internalNumber: '41/26' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(0);
    expect(r.updated).toBe(1);
    expect(r.updatedIds).toEqual(['e-old']);
    expect(r.contractedIds).toEqual(['e-old']);
    // Контрагент в карточке был другой — его не тронули, остальное дописали.
    expect(cardRow(sqlite, 'e-old')).toMatchObject({
      n: 'OLD-1',
      b: 'brand-bosch',
      c: 'cust-2',
      k: 'contract-1',
      a: ARRIVAL,
      i: '41',
      y: 2026,
    });
    sqlite.close();
  });

  it('«обновить» дописывает дату дефектовки, если этапа нет', async () => {
    const sqlite = makeDb();
    sqlite.exec(`
      INSERT INTO erp_engine_cards (id, engine_number, created_at, updated_at) VALUES ('e-old', 'OLD-1', 1, 1);
      INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('e-old', 't-engine', 1, 1);
      INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
        VALUES ('v-old-num', 'e-old', 'd-engine-number', '"OLD-1"', 1, 1);
    `);
    const r = await applyEngineBulkIntake(deps(sqlite, true), {
      defectDate: DEFECT,
      rows: [{ number: 'OLD-1', action: 'update' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.updated).toBe(1);
    expect(stageCodes(sqlite, 'e-old')).toContain('disassembly_defect');
    sqlite.close();
  });

  it('«обновить» при полной карточке ничего не пишет и считает строку пропущенной', async () => {
    const sqlite = makeDb();
    sqlite.exec(`
      INSERT INTO erp_engine_cards (id, engine_number, engine_brand_id, engine_brand, customer_id, contract_id, arrival_date, engine_internal_number, engine_internal_number_year, created_at, updated_at)
        VALUES ('e-old', 'OLD-1', 'brand-bosch', 'Bosch', 'cust-1', 'contract-1', ${ARRIVAL}, '41', 2026, 1, 1);
      INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('e-old', 't-engine', 1, 1);
      INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
        VALUES ('v-old-num', 'e-old', 'd-engine-number', '"OLD-1"', 1, 1);
    `);
    const r = await applyEngineBulkIntake(deps(sqlite), {
      brandId: 'brand-bosch',
      customerId: 'cust-1',
      contractId: 'contract-1',
      arrivalDate: ARRIVAL,
      rows: [{ number: 'OLD-1', action: 'update', internalNumber: '41/26' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.updated).toBe(0);
    expect(r.skipped).toBe(1);
    expect(cardRow(sqlite, 'e-old')).toMatchObject({ n: 'OLD-1', i: '41', y: 2026 });
    sqlite.close();
  });

  it('повтор номера внутри пачки заводит одну карточку', async () => {
    const sqlite = makeDb();
    const r = await applyEngineBulkIntake(deps(sqlite), {
      brandId: 'brand-bosch',
      customerId: 'cust-1',
      contractId: 'contract-1',
      arrivalDate: ARRIVAL,
      rows: [
        { number: 'SAME-1', action: 'create' },
        { number: 'same 1', action: 'create' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(1);
    expect(r.skipped).toBe(1);
    sqlite.close();
  });

  it('несуществующая марка — отказ, карточек нет', async () => {
    const sqlite = makeDb();
    const r = await applyEngineBulkIntake(deps(sqlite), {
      brandId: 'brand-missing',
      customerId: 'cust-1',
      contractId: 'contract-1',
      arrivalDate: ARRIVAL,
      rows: [{ number: 'NEW-1', action: 'create' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Марка');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM erp_engine_cards').get()).toMatchObject({ n: 0 });
    sqlite.close();
  });

  it('«индивидуально по каждому» перекрывает общие поля пачки', async () => {
    const sqlite = makeDb();
    sqlite.exec(`
      INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('brand-other', 't-brand', 1, 1);
      INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
        VALUES ('v-b-2', 'brand-other', 'd-brand-name', '"Cummins"', 1, 1);
    `);
    const r = await applyEngineBulkIntake(deps(sqlite, true), {
      brandId: 'brand-bosch',
      customerId: 'cust-1',
      contractId: 'contract-1',
      arrivalDate: ARRIVAL,
      rows: [
        { number: 'OWN-1', action: 'create', brandId: 'brand-other', incomingOtkDate: DEFECT, waybillNumber: 'Н-7' },
        { number: 'OWN-2', action: 'create' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(2);
    const first = cardRow(sqlite, r.createdIds[0]!);
    const second = cardRow(sqlite, r.createdIds[1]!);
    expect(first).toMatchObject({ b: 'brand-other', bl: 'Cummins', a: DEFECT });
    expect(second).toMatchObject({ b: 'brand-bosch', bl: 'Bosch', a: ARRIVAL });
    const waybill = sqlite
      .prepare("SELECT arrival_invoice AS w FROM erp_engine_cards WHERE id = ?")
      .get(r.createdIds[0]!) as { w: string | null };
    expect(waybill.w).toBe('Н-7');
    sqlite.close();
  });

  it('входной контроль ОТК ставится датой строки и считается в итоге', async () => {
    const sqlite = makeDb();
    const otkCalls: Array<{ engineId: string; dateMs: number }> = [];
    const r = await applyEngineBulkIntake(
      {
        ...deps(sqlite, true),
        writeIncomingOtk: async (engineId, dateMs) => {
          otkCalls.push({ engineId, dateMs });
          return { ok: true, applied: true, conflict: false };
        },
      },
      {
        brandId: 'brand-bosch',
        customerId: 'cust-1',
        contractId: 'contract-1',
        arrivalDate: ARRIVAL,
        rows: [{ number: 'OTK-1', action: 'create' }],
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(otkCalls).toEqual([{ engineId: r.createdIds[0], dateMs: ARRIVAL }]);
    expect(r.otkApplied).toBe(1);
    expect(r.otkMissed).toBe(0);
    sqlite.close();
  });

  it('акт ОТК не создан — пачка всё равно заводит карточки, а итог говорит вслух', async () => {
    const sqlite = makeDb();
    const r = await applyEngineBulkIntake(
      {
        ...deps(sqlite, true),
        writeIncomingOtk: async () => ({ ok: false, error: 'Нет права на операции' }),
      },
      {
        brandId: 'brand-bosch',
        customerId: 'cust-1',
        contractId: 'contract-1',
        arrivalDate: ARRIVAL,
        rows: [{ number: 'OTK-2', action: 'create' }],
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(1);
    expect(r.otkMissed).toBe(1);
    expect(r.otkError).toContain('Нет права');
    sqlite.close();
  });

  it('в карточке другой приход — акт ставим фактом карточки, дату не перезаписываем', async () => {
    const sqlite = makeDb();
    const oldArrival = ARRIVAL - 30 * 86_400_000;
    sqlite.exec(`
      INSERT INTO erp_engine_cards (id, engine_number, arrival_date, created_at, updated_at)
        VALUES ('e-old', 'OLD-2', ${oldArrival}, 1, 1);
      INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('e-old', 't-engine', 1, 1);
    `);
    const otkCalls: Array<{ engineId: string; dateMs: number }> = [];
    const r = await applyEngineBulkIntake(
      {
        ...deps(sqlite, true),
        writeIncomingOtk: async (engineId, dateMs) => {
          otkCalls.push({ engineId, dateMs });
          return { ok: true, applied: true, conflict: false };
        },
      },
      {
        arrivalDate: ARRIVAL,
        rows: [{ number: 'OLD-2', action: 'update' }],
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(otkCalls).toEqual([{ engineId: 'e-old', dateMs: oldArrival }]);
    expect(r.otkConflicts).toBe(1);
    expect(cardRow(sqlite, 'e-old')).toMatchObject({ a: oldArrival });
    sqlite.close();
  });
});
