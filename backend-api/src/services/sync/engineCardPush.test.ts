import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

const selectQueue: unknown[][] = [];
function chain() {
  const c: any = {};
  c.from = () => c;
  c.innerJoin = () => c;
  c.where = () => c;
  c.limit = async () => selectQueue.shift() ?? [];
  c.then = (resolve: (v: unknown[]) => unknown) => resolve(selectQueue.shift() ?? []);
  return c;
}

vi.mock('../../database/db.js', () => ({
  db: {
    select: vi.fn(() => chain()),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(async () => ({ rows: [] })),
  },
  pool: { query: vi.fn(), end: vi.fn() },
}));

import { db } from '../../database/db.js';
import { toEngineCardInput } from './dictionarySyncPublisherService.js';
import { ENGINE_CARD_GATE_REASONS, partitionEngineCardGates } from './engineCardPushGuard.js';
import { diffEngineCardPushTrail } from '../engineStrictService.js';
import type { SyncWriteInput } from './syncWriteService.js';

const EID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function input(row: Record<string, unknown>): SyncWriteInput {
  return { type: 'upsert', table: SyncTableName.ErpEngineCards, row, row_id: String(row.id ?? EID) };
}

const BASE_ROW: Record<string, unknown> = {
  id: EID,
  engine_number: 'A-1',
  engine_internal_number: null,
  engine_internal_number_year: null,
  repeat_arrival_flag: false,
  number_collision_flag: false,
  created_at: 1000,
  updated_at: 2000,
  deleted_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
});

describe('pre-sign гейты push карточек (E3a)', () => {
  it('чистая строка проходит без запросов', async () => {
    const r = await partitionEngineCardGates([input({ ...BASE_ROW, engine_number: null })]);
    expect(r.skipped).toEqual([]);
    expect(r.allowed).toHaveLength(1);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('дубль заводского номера — skip до подписи', async () => {
    selectQueue.push([{ entityId: OTHER, valueJson: '"A-1"' }]);
    const r = await partitionEngineCardGates([input({ ...BASE_ROW })]);
    expect(r.allowed).toHaveLength(0);
    expect(r.skipped).toEqual([
      { table: SyncTableName.ErpEngineCards, row_id: EID, reason: ENGINE_CARD_GATE_REASONS.numberDup },
    ]);
  });

  it('флаг обхода в строке снимает запрет номера', async () => {
    selectQueue.push([{ entityId: OTHER, valueJson: '"A-1"' }]);
    const r = await partitionEngineCardGates([input({ ...BASE_ROW, repeat_arrival_flag: true })]);
    expect(r.skipped).toEqual([]);
    expect(r.allowed).toHaveLength(1);
  });

  it('дубль пары клейма — skip, обхода нет', async () => {
    selectQueue.push([
      { entityId: OTHER, code: 'engine_internal_number', valueJson: '"41"' },
      { entityId: OTHER, code: 'engine_internal_number_year', valueJson: '2026' },
    ]);
    const r = await partitionEngineCardGates([
      input({ ...BASE_ROW, engine_number: null, engine_internal_number: '041', engine_internal_number_year: 2026 }),
    ]);
    expect(r.allowed).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe(ENGINE_CARD_GATE_REASONS.pairDup);
  });

  it('невалидный год пары — не блок (как гейт EAV)', async () => {
    const r = await partitionEngineCardGates([
      input({ ...BASE_ROW, engine_number: null, engine_internal_number: '41', engine_internal_number_year: 1999 }),
    ]);
    expect(r.skipped).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('тумбстоун гейты не проходят', async () => {
    const r = await partitionEngineCardGates([input({ ...BASE_ROW, deleted_at: 3000 })]);
    expect(r.skipped).toEqual([]);
    expect(r.allowed).toHaveLength(1);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('чужие таблицы не трогает', async () => {
    const other: SyncWriteInput = {
      type: 'upsert',
      table: SyncTableName.Operations,
      row: { id: 'x' },
      row_id: 'x',
    };
    const r = await partitionEngineCardGates([other]);
    expect(r.allowed).toEqual([other]);
    expect(r.skipped).toEqual([]);
  });
});

describe('diff следа push-apply (E3a)', () => {
  it('новая строка — след по всем присланным кодам', () => {
    const trail = diffEngineCardPushTrail(null, { engine_number: 'A-1', engine_note: 'n' });
    expect(trail).toContainEqual(['engine_number', 'A-1']);
    expect(trail).toContainEqual(['engine_note', 'n']);
  });

  it('равные строки — следа нет', () => {
    const cur = { engine_number: 'A-1', engine_note: null, status_repaired: false };
    const trail = diffEngineCardPushTrail(cur, { ...cur });
    expect(trail).toEqual([]);
  });

  it('только изменившиеся коды; пустая строка равна NULL', () => {
    const trail = diffEngineCardPushTrail(
      { engine_number: 'A-1', engine_note: null },
      { engine_number: 'A-1', engine_note: '', status_repaired: true },
    );
    expect(trail).toEqual([['status_repaired', true]]);
  });
});

describe('toEngineCardInput (паблишер)', () => {
  it('camelCase → snake, флаги — boolean', () => {
    const out = toEngineCardInput({
      id: EID,
      engineNumber: 'A-1',
      engineInternalNumberYear: 2026,
      statusRepaired: true,
      statusReworkSent: false,
      engineNote: '',
      createdAt: 1000,
      updatedAt: 2000,
      deletedAt: null,
    });
    expect(out.table).toBe(SyncTableName.ErpEngineCards);
    const row = out.row as Record<string, unknown>;
    expect(row).toMatchObject({
      id: EID,
      engine_number: 'A-1',
      engine_internal_number_year: 2026,
      status_repaired: true,
      status_rework_sent: false,
      engine_note: null,
    });
  });
});
