import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { buildCardSnapshotFacts, listEngineRmzNumbers } from './engineRmzNumbersHistory.js';

// Реестр «Номера РМЗ» (план engine-rmz-numbers-2026-10, PR-4).
//
// Экран отвечает на вопрос, на который не отвечают ни список двигателей (карточки там
// уже нет), ни журнал действий (номера в нём нет): какой номер был у удалённой карточки,
// кто и почему её удалил и что в ней было. Тесты держат ровно это: удалённая строка
// приходит со статусом, автором, причиной и снимком, живая — без снимка, свежие сверху.
const here = dirname(fileURLToPath(import.meta.url));

const ENGINE_ID = '11111111-1111-4111-8111-111111111111';
const DELETED_ID = '22222222-2222-4222-8222-222222222222';
const SNAPSHOT_ONLY_ID = '33333333-3333-4333-8333-333333333333';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(here, '../../../drizzle/0032_erp_engine_cards_replica.sql'), 'utf8'));
  sqlite.exec(readFileSync(join(here, '../../../drizzle/0037_engine_rmz_numbers_replica.sql'), 'utf8'));
  return { sqlite, db: drizzle(sqlite) as never };
}

function insertNumber(
  sqlite: Database.Database,
  row: {
    id: string;
    seq: number;
    status?: string;
    createdBy?: string | null;
    createdAt?: number;
    cardDeletedAt?: number | null;
    cardDeletedBy?: string | null;
    deleteReason?: string | null;
    snapshotJson?: string | null;
  },
) {
  sqlite
    .prepare(
      `INSERT INTO erp_engine_numbers
         (id, seq, status, created_by, card_deleted_at, card_deleted_by, delete_reason, snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.seq,
      row.status ?? 'active',
      row.createdBy ?? null,
      row.cardDeletedAt ?? null,
      row.cardDeletedBy ?? null,
      row.deleteReason ?? null,
      row.snapshotJson ?? null,
      row.createdAt ?? 1_700_000_000_000,
      1_700_000_000_000,
    );
}

function insertCard(sqlite: Database.Database, row: { id: string; engineNumber?: string | null; internal?: string | null; year?: number | null; brand?: string | null }) {
  sqlite
    .prepare(
      `INSERT INTO erp_engine_cards
         (id, engine_number, engine_internal_number, engine_internal_number_year, engine_brand, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.engineNumber ?? null, row.internal ?? null, row.year ?? null, row.brand ?? null, 1, 1);
}

describe('listEngineRmzNumbers', () => {
  it('пустой реестр — пустой список, а не выдумка', async () => {
    const { sqlite, db } = makeDb();
    expect(await listEngineRmzNumbers(db)).toEqual([]);
    sqlite.close();
  });

  it('живая карточка: номер, опознание из реплики, без снимка', async () => {
    const { sqlite, db } = makeDb();
    insertNumber(sqlite, { id: ENGINE_ID, seq: 451, createdBy: 'operator1' });
    insertCard(sqlite, { id: ENGINE_ID, engineNumber: 'Д-42', internal: '41', year: 2026, brand: 'ЯМЗ-236' });

    const [row] = await listEngineRmzNumbers(db);
    expect(row).toMatchObject({
      engineId: ENGINE_ID,
      seq: 451,
      rmzCode: 'RMZ451',
      status: 'active',
      engineNumber: 'Д-42',
      internalNumber: '41/26',
      engineBrand: 'ЯМЗ-236',
      createdBy: 'operator1',
      cardDeletedBy: '',
      deleteReason: '',
    });
    // У живой карточки снимка нет: «что было» открывается самой карточкой, копия была бы враньём о времени.
    expect(row?.snapshot).toEqual([]);
    sqlite.close();
  });

  it('удалённая карточка: статус, автор, причина и снимок «что было»', async () => {
    const { sqlite, db } = makeDb();
    insertNumber(sqlite, {
      id: DELETED_ID,
      seq: 452,
      status: 'deleted',
      createdBy: 'operator1',
      cardDeletedAt: 1_700_100_000_000,
      cardDeletedBy: 'master2',
      deleteReason: 'Заведена ошибочно, дубль',
      snapshotJson: JSON.stringify({
        engineNumber: 'Д-77',
        engineInternalNumber: '7',
        engineInternalNumberYear: 2026,
        engineBrand: 'ЯМЗ-238',
        arrivalDate: 1_700_000_000_000,
        statusRepaired: true,
        statusRepairedDate: 1_700_050_000_000,
        repeatArrivalFlag: true,
        engineNote: 'трещина в блоке',
      }),
    });

    const [row] = await listEngineRmzNumbers(db);
    expect(row).toMatchObject({
      engineId: DELETED_ID,
      status: 'deleted',
      cardDeletedBy: 'master2',
      deleteReason: 'Заведена ошибочно, дубль',
      engineNumber: 'Д-77',
      internalNumber: '7/26',
      engineBrand: 'ЯМЗ-238',
    });
    expect(row?.cardDeletedAt).toBe(1_700_100_000_000);
    const labels = (row?.snapshot ?? []).map((f) => f.label);
    expect(labels).toContain('Документный номер');
    expect(labels).toContain('Внутренний номер');
    expect(labels).toContain('Марка');
    expect(labels).toContain('Дата прихода');
    expect(labels).toContain('Повторный заезд');
    expect(labels).toContain('Примечание');
    // Статус с датой — подпись из общего словаря, а не сырой код колонки.
    const repaired = (row?.snapshot ?? []).find((f) => f.label === 'Отремонтирован');
    expect(repaired?.value).toMatch(/\d{2}\.\d{2}\.\d{4}/);
    sqlite.close();
  });

  it('карточки в реплике нет — опознание берётся из снимка, номер не теряется', async () => {
    const { sqlite, db } = makeDb();
    // Холодная машина: реестр приехал, карточку клиент ещё не догнал (или она слита).
    insertNumber(sqlite, {
      id: SNAPSHOT_ONLY_ID,
      seq: 453,
      status: 'deleted',
      cardDeletedBy: 'buh1',
      deleteReason: 'Дубль по внутреннему номеру',
      snapshotJson: JSON.stringify({
        engine_number: 'Д-99',
        engine_internal_number: '99',
        engine_internal_number_year: 2025,
        engine_brand: 'ЯМЗ-7511',
      }),
    });

    const [row] = await listEngineRmzNumbers(db);
    // Снимок может приехать и snake_case-ом — читаем оба вида, иначе строка была бы пустой.
    expect(row).toMatchObject({ engineNumber: 'Д-99', internalNumber: '99/25', engineBrand: 'ЯМЗ-7511' });
    expect(row?.snapshot.some((f) => f.label === 'Марка')).toBe(true);
    sqlite.close();
  });

  it('битый снимок не роняет реестр: номер и история остаются', async () => {
    const { sqlite, db } = makeDb();
    insertNumber(sqlite, {
      id: DELETED_ID,
      seq: 454,
      status: 'deleted',
      cardDeletedBy: 'master2',
      deleteReason: 'ошиблись',
      snapshotJson: '{не json',
    });

    const [row] = await listEngineRmzNumbers(db);
    expect(row?.rmzCode).toBe('RMZ454');
    expect(row?.deleteReason).toBe('ошиблись');
    expect(row?.snapshot).toEqual([]);
    sqlite.close();
  });

  it('свежие номера сверху, порядок числовой', async () => {
    const { sqlite, db } = makeDb();
    insertNumber(sqlite, { id: ENGINE_ID, seq: 9 });
    insertNumber(sqlite, { id: DELETED_ID, seq: 1000 });
    insertNumber(sqlite, { id: SNAPSHOT_ONLY_ID, seq: 451 });

    const codes = (await listEngineRmzNumbers(db)).map((r) => r.rmzCode);
    expect(codes).toEqual(['RMZ1000', 'RMZ451', 'RMZ9']);
    sqlite.close();
  });
});

describe('buildCardSnapshotFacts', () => {
  it('пустой снимок — пустой список, а не прочерки', () => {
    expect(buildCardSnapshotFacts(null)).toEqual([]);
    expect(buildCardSnapshotFacts({})).toEqual([]);
  });

  it('читает и camelCase, и snake_case', () => {
    expect(buildCardSnapshotFacts({ engineNumber: 'A' })).toEqual([{ label: 'Документный номер', value: 'A' }]);
    expect(buildCardSnapshotFacts({ engine_number: 'B' })).toEqual([{ label: 'Документный номер', value: 'B' }]);
  });

  it('выключенный статус в снимок не попадает — это «чего не было»', () => {
    const labels = buildCardSnapshotFacts({ statusRepaired: false, statusRepairStarted: true }).map((f) => f.label);
    expect(labels).toEqual(['Начат ремонт']);
  });
});
