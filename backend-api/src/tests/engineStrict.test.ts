import { beforeEach, describe, expect, it, vi } from 'vitest';

const publish = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../sync/syncChangeService.js', () => ({
  recordSyncChanges: publish,
}));

// Очередь ответов SELECT: каждый limit() или await цепочки забирает следующий набор.
// innerJoin нужен гейтам engineNumberGuard (их нет в моке C1).
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

const setImpl = vi.hoisted(() => vi.fn());

vi.mock('../database/db.js', () => ({
  db: {
    select: vi.fn(() => chain()),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: async () => [{ id: 'row-1' }],
        onConflictDoUpdate: vi.fn(() => ({
          returning: async () => [{ id: 'row-1' }],
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: (v: unknown) => {
        setImpl(v);
        return {
          where: vi.fn(() => ({
            returning: async () => [{ id: 'row-1' }],
          })),
        };
      },
    })),
    execute: vi.fn(async () => ({ rows: [] })),
  },
  pool: { query: vi.fn(), end: vi.fn() },
}));

import { db } from '../database/db.js';
import { getEngineCardStrict, patchEngineCardStrict } from '../services/engineStrictService.js';

const ACTOR = { id: 'u-1', username: 'meh', role: 'admin' };
const EID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const EXISTING = {
  id: EID,
  engineNumber: 'OLD-1',
  engineInternalNumber: null,
  engineInternalNumberYear: null,
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
});

describe('двери записи карточки двигателя (E2)', () => {
  it('неизвестное поле — громкий отказ до базы', async () => {
    const r = await patchEngineCardStrict(EID, { hacker_field: 1 }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('hacker_field');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('неверный id и не-объект — отказ', async () => {
    expect((await patchEngineCardStrict('nope', {}, ACTOR)).ok).toBe(false);
    expect((await patchEngineCardStrict(EID, [], ACTOR)).ok).toBe(false);
    expect((await getEngineCardStrict('nope')).ok).toBe(false);
  });

  it('патч несуществующей карточки — 404-семантика', async () => {
    selectQueue.push([]); // existing: пусто
    const r = await patchEngineCardStrict(EID, { engine_note: 'hi' }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('не найден');
    const g = await getEngineCardStrict(EID);
    expect(g.ok).toBe(false);
  });

  it('пустой патч — changed:false без записи', async () => {
    selectQueue.push([{ ...EXISTING }]);
    const r = await patchEngineCardStrict(EID, {}, ACTOR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('дубль заводского номера блокируется', async () => {
    selectQueue.push([{ ...EXISTING }]);
    selectQueue.push([{ entityId: OTHER, valueJson: '"ABC-123"' }]);
    const r = await patchEngineCardStrict(EID, { engine_number: 'abc-123' }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('уже существует');
  });

  it('флаг осознанного дубля из того же патча снимает запрет номера', async () => {
    selectQueue.push([{ ...EXISTING }]);
    selectQueue.push([{ entityId: OTHER, valueJson: '"ABC-123"' }]);
    const r = await patchEngineCardStrict(
      EID,
      { engine_number: 'ABC-123', repeat_arrival_flag: true },
      ACTOR,
    );
    expect(r.ok).toBe(true);
  });

  it('флаг осознанного дубля из БД снимает запрет номера', async () => {
    selectQueue.push([{ ...EXISTING }]);
    selectQueue.push([{ entityId: OTHER, valueJson: '"ABC-123"' }]);
    selectQueue.push([{ valueJson: 'true' }]); // engineHasDuplicateBypassFlag
    const r = await patchEngineCardStrict(EID, { engine_number: 'ABC-123' }, ACTOR);
    expect(r.ok).toBe(true);
  });

  it('явное снятие флага в том же патче возвращает запрет (merged-взгляд)', async () => {
    // В БД флаг стоит, но патч его снимает — merged-состояние без обхода.
    // Гейт БД при этом не спрашивается вовсе: патч несёт флаги явно.
    selectQueue.push([{ ...EXISTING }]);
    selectQueue.push([{ entityId: OTHER, valueJson: '"ABC-123"' }]);
    const r = await patchEngineCardStrict(
      EID,
      { engine_number: 'ABC-123', repeat_arrival_flag: false },
      ACTOR,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('уже существует');
  });

  it('пересохранение того же номера не ходит в гейт', async () => {
    selectQueue.push([{ ...EXISTING, engineNumber: 'ABC-123' }]);
    const r = await patchEngineCardStrict(EID, { engine_number: 'abc-123' }, ACTOR);
    expect(r.ok).toBe(true);
  });

  it('дубль клейма (пара номер+год) блокируется без обхода', async () => {
    selectQueue.push([{ ...EXISTING }]);
    selectQueue.push([
      { entityId: OTHER, code: 'engine_internal_number', valueJson: '"41"' },
      { entityId: OTHER, code: 'engine_internal_number_year', valueJson: '2026' },
    ]);
    const r = await patchEngineCardStrict(
      EID,
      { engine_internal_number: '041', engine_internal_number_year: 2026 },
      ACTOR,
    );
    expect(r.ok).toBe(false);
  });

  it('пересохранение той же пары клейма не блокируется', async () => {
    selectQueue.push([{ ...EXISTING, engineInternalNumber: '41', engineInternalNumberYear: 2026 }]);
    const r = await patchEngineCardStrict(EID, { engine_internal_number: '41' }, ACTOR);
    expect(r.ok).toBe(true);
  });

  it('ссылка на несуществующий объект — громкий отказ', async () => {
    selectQueue.push([{ ...EXISTING }]);
    selectQueue.push([]); // entities: нет
    const r = await patchEngineCardStrict(EID, { customer_id: OTHER }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('customer_id');
  });

  it('пустая строка текста хранится NULL (как зеркало)', async () => {
    selectQueue.push([{ ...EXISTING }]);
    const r = await patchEngineCardStrict(EID, { engine_note: '' }, ACTOR);
    expect(r.ok).toBe(true);
    expect(setImpl).toHaveBeenCalled();
    const firstCall = setImpl.mock.calls[0];
    if (!firstCall) throw new Error('expected update.set to be called');
    const setArg = firstCall[0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ engineNote: null });
  });
});
