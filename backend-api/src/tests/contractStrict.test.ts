import { beforeEach, describe, expect, it, vi } from 'vitest';

const publish = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../services/sync/syncChangeService.js', () => ({
  recordSyncChanges: publish,
}));

vi.mock('../services/adminMasterdataService.js', () => ({
  setEntityAttribute: vi.fn().mockResolvedValue({ ok: true }),
}));

// Очередь ответов SELECT: каждый limit() или await цепочки забирает следующий набор.
const selectQueue: unknown[][] = [];
function chain() {
  const c: any = {};
  c.from = () => c;
  c.where = () => c;
  c.limit = async () => selectQueue.shift() ?? [];
  c.then = (resolve: (v: unknown[]) => unknown) => resolve(selectQueue.shift() ?? []);
  return c;
}

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
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: async () => [{ id: 'row-1' }],
        })),
      })),
    })),
    // Канонизация JSON через PG: в тестах — тождественная (формат проверяет PG вживую).
    execute: vi.fn(async () => ({ rows: [{ t: '[]' }] })),
  },
  pool: { query: vi.fn(), end: vi.fn() },
}));

import {
  createContractStrict,
  createCounterpartyStrict,
  patchContractStrict,
  patchCounterpartyStrict,
} from '../services/contractStrictService.js';

const ACTOR = { id: 'u-1', username: 'buh', role: 'admin' };
const CID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
});

describe('двери записи договоров/контрагентов (C1)', () => {
  it('неизвестное поле — громкий отказ до базы', async () => {
    const r = await patchContractStrict(CID, { hacker_field: 1 }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('hacker_field');
    const r2 = await patchCounterpartyStrict(CID, { ssn: 'x' }, ACTOR);
    expect(r2.ok).toBe(false);
  });

  it('неверный id и не-объект — отказ', async () => {
    expect((await patchContractStrict('nope', {}, ACTOR)).ok).toBe(false);
    expect((await createContractStrict([], ACTOR)).ok).toBe(false);
    expect((await createCounterpartyStrict({ name: '' }, ACTOR)).ok).toBe(false);
  });

  it('дубль внутреннего номера блокируется', async () => {
    // findContractInternalNumberDuplicate идёт раньше typeIdOf: сначала строки
    // договоров, затем тип. Ключ «20 гоз 25» равен ключу «20/ГОЗ-25».
    selectQueue.push([
      { id: 'other-id', internalNumber: '20/ГОЗ-25', number: '20/ГОЗ-25' },
    ]);
    selectQueue.push([{ id: 'type-contract' }]);
    const r = await createContractStrict({ internal_number: '20 гоз 25', number: 'x' }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('занят');
  });

  it('пересохранение неизменного номера не блокируется (тройка 20/ГОЗ-25)', async () => {
    // Строка уже несёт тот же ключ — гейт дублей пропускает без запроса к журналу.
    selectQueue.push([{ id: CID, internalNumber: '20/ГОЗ-25', deletedAt: null }]);
    const r = await patchContractStrict(CID, { internal_number: '20/ГОЗ-25', comment: 'x' }, ACTOR);
    expect(r.ok).toBe(true);
  });

  it('патч несуществующего договора — 404-семантика', async () => {
    selectQueue.push([]); // existing: пусто
    const r = await patchContractStrict(CID, { comment: 'hi' }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('не найден');
  });

  it('create с id клиента проходит гейт (deferred-create, баг 09.10.2026)', async () => {
    // Карточка открывается на сгенерированном uuid до первой записи — клиент всегда шлёт id.
    selectQueue.push([{ id: 'type-contract' }]); // typeIdOf
    const r = await createContractStrict({ id: CID, number: '7' }, ACTOR);
    expect(r.ok).toBe(true);
    selectQueue.push([{ id: 'type-customer' }]); // typeIdOf
    const r2 = await createCounterpartyStrict({ id: CID, name: 'Завод' }, ACTOR);
    expect(r2.ok).toBe(true);
  });

  it('patch с id по-прежнему отвергается — id живёт в URL, не в теле', async () => {
    const r = await patchContractStrict(CID, { id: CID }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('id');
  });

  it('заказчик вне справочника — громкий отказ', async () => {
    selectQueue.push([{ id: CID, deletedAt: null }]); // existing contract
    selectQueue.push([]); // counterparty: нет
    const r = await patchContractStrict(CID, { customer_id: '22222222-2222-4222-8222-222222222222' }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('заказчик');
  });

  it('execution_parts_json — массив: пустой и с строками принимаются (баг 10.10.2026)', async () => {
    // create нового договора без исполнения: клиент шлёт "[]".
    selectQueue.push([{ id: 'type-contract' }]); // typeIdOf
    const r = await createContractStrict({ id: CID, number: '7', execution_parts_json: '[]' }, ACTOR);
    expect(r.ok).toBe(true);
    // patch с непустым массивом строк.
    selectQueue.push([{ id: CID, deletedAt: null }]); // existing contract
    const r2 = await patchContractStrict(
      CID,
      { execution_parts_json: '[{"partId":"p1","plannedQty":5,"completedQty":0}]' },
      ACTOR,
    );
    expect(r2.ok).toBe(true);
  });

  it('execution_parts_json — не-массив и битый JSON режутся', async () => {
    // Валидация JSON идёт до typeIdOf: очередь SELECT не трогаем.
    const bad = ['{broken', '"str"', '42', '{"rows":[]}'];
    for (const raw of bad) {
      const r = await createContractStrict({ id: CID, number: '7', execution_parts_json: raw }, ACTOR);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('execution_parts_json');
    }
  });
});
