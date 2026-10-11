import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOM = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const CARD = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const DOC = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';

const state = vi.hoisted(() => ({
  queue: [] as unknown[][],
  failInsert: false,
  returningRows: [[{ id: 'row-1' }]] as unknown[][],
  createdDoc: { ok: true, id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc' } as { ok: boolean; id?: string; error?: string },
  postedDoc: { ok: true, id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', posted: true } as {
    ok: boolean;
    id?: string;
    posted?: boolean;
    error?: string;
  },
}));

function chain() {
  const c: any = {};
  c.from = () => c;
  c.where = () => c;
  c.orderBy = () => c;
  c.innerJoin = () => c;
  c.limit = async () => state.queue.shift() ?? [];
  c.then = (resolve: (v: unknown[]) => unknown) => resolve(state.queue.shift() ?? []);
  return c;
}

function valuesMock() {
  return {
    values: async () => {
      if (state.failInsert) {
        state.failInsert = false;
        throw new Error('duplicate key');
      }
      return undefined;
    },
  };
}

function updateMock() {
  return {
    set: () => ({
      where: () => ({
        returning: async () => state.returningRows.shift() ?? [],
      }),
    }),
  };
}

vi.mock('../database/db.js', () => ({
  db: {
    select: () => chain(),
    insert: () => valuesMock(),
    update: () => updateMock(),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ select: () => chain(), insert: () => valuesMock(), update: () => updateMock() }),
  },
  pool: { query: () => undefined, end: () => undefined },
}));

vi.mock('../services/warehouseService.js', () => ({
  createWarehouseDocument: vi.fn(async () => state.createdDoc),
  postWarehouseDocument: vi.fn(async () => state.postedDoc),
}));

import {
  assignCardNorms,
  closePpeCard,
  getPpeCard,
  issuePpe,
  listPpeNormSets,
  openPpeCard,
  upsertPpeNormSet,
} from '../services/ppeService.js';

const ACTOR = { id: 'u-1', username: 'klad', role: 'storekeeper' };

beforeEach(() => {
  vi.clearAllMocks();
  state.queue.length = 0;
  state.failInsert = false;
  state.returningRows.length = 0;
  state.returningRows.push([{ id: 'row-1' }]);
  state.createdDoc = { ok: true, id: DOC };
  state.postedDoc = { ok: true, id: DOC, posted: true };
});

describe('ppeService: нормы', () => {
  it('пустое имя и пустые строки — отказ до базы', async () => {
    expect((await upsertPpeNormSet({ name: '  ', lines: [{ nomenclatureId: NOM, qty: 1, wearMonths: 12 }] })).ok).toBe(false);
    expect((await upsertPpeNormSet({ name: 'Слесарь', lines: [] })).ok).toBe(false);
    expect((await upsertPpeNormSet({ name: 'Слесарь', lines: [{ nomenclatureId: NOM, qty: 0, wearMonths: 12 }] })).ok).toBe(false);
  });

  it('битая ссылка номенклатуры — отказ', async () => {
    state.queue.push([]); // validateNomenclatureIds: пусто
    const r = await upsertPpeNormSet({ name: 'Слесарь', lines: [{ nomenclatureId: NOM, qty: 1, wearMonths: 12 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('не существует');
  });

  it('новый набор пишется со строками', async () => {
    state.queue.push([{ id: NOM }]); // validateNomenclatureIds
    state.queue.push([]); // existing: нет
    const r = await upsertPpeNormSet({ name: 'Слесарь', lines: [{ nomenclatureId: NOM, qty: 2, wearMonths: 6 }] });
    expect(r.ok).toBe(true);
  });

  it('список без фильтров не падает на пустой базе', async () => {
    state.queue.push([]); // sets
    const r = await listPpeNormSets();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toEqual([]);
  });
});

describe('ppeService: карточки', () => {
  it('открытие без сотрудника и на несуществующего — отказ', async () => {
    expect((await openPpeCard({ employeeId: '' })).ok).toBe(false);
    state.queue.push([]); // emp: нет
    const r = await openPpeCard({ employeeId: NOM });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('не найден');
  });

  it('открытие и дубль открытой карточки', async () => {
    state.queue.push([{ id: NOM }]);
    expect((await openPpeCard({ employeeId: NOM })).ok).toBe(true);
    state.queue.push([{ id: NOM }]);
    state.failInsert = true;
    const r = await openPpeCard({ employeeId: NOM });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('уже есть открытая');
  });

  it('назначение норм: чужая карточка, закрытая, битый набор', async () => {
    state.queue.push([]); // card: нет
    expect((await assignCardNorms({ cardId: CARD, normSetIds: [NOM] })).ok).toBe(false);
    state.queue.push([{ id: CARD, closedAt: 1000 }]); // закрыта
    const closed = await assignCardNorms({ cardId: CARD, normSetIds: [NOM] });
    expect(closed.ok).toBe(false);
    state.queue.push([{ id: CARD, closedAt: null }]);
    state.queue.push([]); // sets: нет
    const bad = await assignCardNorms({ cardId: CARD, normSetIds: [NOM] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('не существует');
  });

  it('назначение норм: новые пишутся, повторные не дублируются', async () => {
    state.queue.push([{ id: CARD, closedAt: null }]);
    state.queue.push([{ id: NOM }]);
    state.queue.push([]); // existing: нет
    const r = await assignCardNorms({ cardId: CARD, normSetIds: [NOM] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.assigned).toBe(1);
  });

  it('чтение без ключа и несуществующей — отказ', async () => {
    expect((await getPpeCard({})).ok).toBe(false);
    state.queue.push([]); // card: нет
    expect((await getPpeCard({ cardId: CARD })).ok).toBe(false);
  });

  it('закрытие несуществующей — отказ', async () => {
    state.returningRows.length = 0;
    state.returningRows.push([]);
    const r = await closePpeCard({ cardId: CARD });
    expect(r.ok).toBe(false);
  });
});

describe('ppeService: выдача', () => {
  const lines = [{ nomenclatureId: NOM, qty: 1 }];

  it('пустые входы — отказ до базы', async () => {
    expect((await issuePpe({ cardId: '', warehouseId: 'w', lines, actor: ACTOR })).ok).toBe(false);
    expect((await issuePpe({ cardId: CARD, warehouseId: '', lines, actor: ACTOR })).ok).toBe(false);
    expect((await issuePpe({ cardId: CARD, warehouseId: 'w', lines: [], actor: ACTOR })).ok).toBe(false);
    expect((await issuePpe({ cardId: CARD, warehouseId: 'w', lines: [{ nomenclatureId: NOM, qty: 0 }], actor: ACTOR })).ok).toBe(false);
  });

  it('чужая и закрытая карточки — отказ', async () => {
    state.queue.push([]); // card: нет
    expect((await issuePpe({ cardId: CARD, warehouseId: 'w', lines, actor: ACTOR })).ok).toBe(false);
    state.queue.push([{ id: CARD, closedAt: 1000 }]);
    const r = await issuePpe({ cardId: CARD, warehouseId: 'w', lines, actor: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('закрыта');
  });

  it('успех: черновик создан, проведён, след записан', async () => {
    state.queue.push([{ id: CARD, closedAt: null }]);
    state.queue.push([{ id: NOM }]);
    const r = await issuePpe({ cardId: CARD, warehouseId: 'w', lines, actor: ACTOR });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documentId).toBe(DOC);
      expect(r.entries).toBe(1);
    }
  });

  it('проводка упала — документ остался черновиком, следа нет', async () => {
    state.queue.push([{ id: CARD, closedAt: null }]);
    state.queue.push([{ id: NOM }]);
    state.postedDoc = { ok: false, error: 'пустой склад' };
    const r = await issuePpe({ cardId: CARD, warehouseId: 'w', lines, actor: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('черновиком');
  });

  it('создание документа упало — отказ с причиной склада', async () => {
    state.queue.push([{ id: CARD, closedAt: null }]);
    state.queue.push([{ id: NOM }]);
    state.createdDoc = { ok: false, error: 'склад не найден' };
    const r = await issuePpe({ cardId: CARD, warehouseId: 'w', lines, actor: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('склад не найден');
  });
});
