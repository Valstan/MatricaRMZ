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
  createPpeAbsence,
  createPpeGroup,
  deletePpeAbsence,
  deletePpeGroup,
  getPpeCard,
  getPpeGroupMembers,
  getPpeGroupNorms,
  getPpeNormSet,
  issuePpe,
  listPpeAbsences,
  listPpeGroups,
  listPpeNormSets,
  openPpeCard,
  resolveEmployeeNormSetIds,
  setPpeGroupMembers,
  setPpeGroupNorms,
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

describe('ppeService фаза 2: условия норм', () => {
  it('upsert с полом/сезоном/дежурной пишется', async () => {
    state.queue.push([{ id: NOM }]); // validateNomenclatureIds
    state.queue.push([]); // existing: нет
    const r = await upsertPpeNormSet({
      name: 'Зима',
      gender: 'M',
      season: 'winter',
      isDuty: true,
      lines: [{ nomenclatureId: NOM, qty: 1, wearMonths: 6 }],
    });
    expect(r.ok).toBe(true);
  });

  it('список отдаёт условия и фильтруется', async () => {
    state.queue.push([
      { id: NOM, name: 'Зима', postTitle: null, gender: 'M', season: 'winter', isDuty: false, validFrom: 1, validTo: null },
    ]);
    state.queue.push([]); // lines
    const r = await listPpeNormSets({ gender: 'M', season: 'winter' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ gender: 'M', season: 'winter', isDuty: false });
    }
  });

  it('карточка набора отдаёт условия', async () => {
    state.queue.push([{ id: NOM, name: 'Зима', postTitle: null, gender: null, season: null, isDuty: true, validFrom: 1, validTo: null }]);
    state.queue.push([]);
    const r = await getPpeNormSet(NOM);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normSet).toMatchObject({ gender: null, season: null, isDuty: true });
  });
});

describe('ppeService фаза 2: открытие через EAV', () => {
  it('строгой карточки нет, EAV-сущность есть — открывается', async () => {
    state.queue.push([]); // strict: нет
    state.queue.push([{ id: NOM }]); // eav: есть
    const r = await openPpeCard({ employeeId: NOM });
    expect(r.ok).toBe(true);
  });

  it('нет ни строгой, ни EAV — отказ', async () => {
    state.queue.push([]); // strict: нет
    state.queue.push([]); // eav: нет
    const r = await openPpeCard({ employeeId: NOM });
    expect(r.ok).toBe(false);
  });
});

describe('ppeService фаза 2: отпуска', () => {
  it('from позже to и мусор — отказ до базы', async () => {
    expect((await createPpeAbsence({ employeeId: NOM, fromMs: 5, toMs: 5 })).ok).toBe(false);
    expect((await createPpeAbsence({ employeeId: NOM, fromMs: 9, toMs: 5 })).ok).toBe(false);
    expect((await createPpeAbsence({ employeeId: '', fromMs: 1, toMs: 2 })).ok).toBe(false);
  });

  it('создание и удаление', async () => {
    state.queue.push([{ id: NOM }]); // emp: есть
    expect((await createPpeAbsence({ employeeId: NOM, fromMs: 1, toMs: 2 })).ok).toBe(true);
    state.queue.push([]); // emp: нет
    const missing = await createPpeAbsence({ employeeId: NOM, fromMs: 1, toMs: 2 });
    expect(missing.ok).toBe(false);
    state.queue.push([{ id: NOM, employeeId: NOM, fromMs: 1, toMs: 2, kind: 'vacation' }]);
    const listed = await listPpeAbsences({ employeeId: NOM });
    expect(listed.ok).toBe(true);
    const deleted = await deletePpeAbsence(NOM);
    expect(deleted.ok).toBe(true);
  });

  it('пересекающиеся отпуска хранятся оба (сдвиг — объединением в ядре)', async () => {
    state.queue.push([{ id: NOM }]);
    expect((await createPpeAbsence({ employeeId: NOM, fromMs: 1, toMs: 10 })).ok).toBe(true);
    state.queue.push([{ id: NOM }]);
    expect((await createPpeAbsence({ employeeId: NOM, fromMs: 5, toMs: 15 })).ok).toBe(true);
  });
});

describe('ppeService фаза 2: группы', () => {
  it('создание, список со счётчиками, удаление', async () => {
    expect((await createPpeGroup({ name: '  ' })).ok).toBe(false);
    expect((await createPpeGroup({ name: 'Зимники' })).ok).toBe(true);
    state.queue.push([{ id: 'g-1', name: 'Зимники' }]);
    state.queue.push([{ groupId: 'g-1' }, { groupId: 'g-1' }]);
    state.queue.push([{ groupId: 'g-1' }]);
    const listed = await listPpeGroups();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.rows).toEqual([{ id: 'g-1', name: 'Зимники', membersCount: 2, normsCount: 1 }]);
    const deleted = await deletePpeGroup('g-1');
    expect(deleted.ok).toBe(true);
  });

  it('состав: чужая группа и чужой сотрудник — отказ', async () => {
    state.queue.push([]); // group: нет
    expect((await setPpeGroupMembers({ groupId: 'g-9', employeeIds: [NOM] })).ok).toBe(false);
    state.queue.push([{ id: 'g-1' }]);
    state.queue.push([]); // employee: нет
    const bad = await setPpeGroupMembers({ groupId: 'g-1', employeeIds: [NOM] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('Сотрудник');
  });

  it('состав пишется и читается', async () => {
    state.queue.push([{ id: 'g-1' }]);
    state.queue.push([{ id: NOM }]);
    const set = await setPpeGroupMembers({ groupId: 'g-1', employeeIds: [NOM] });
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.members).toBe(1);
    state.queue.push([{ employeeId: NOM }]);
    const got = await getPpeGroupMembers('g-1');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.employeeIds).toEqual([NOM]);
  });

  it('нормы группы: битый набор — отказ, живые пишутся', async () => {
    state.queue.push([{ id: 'g-1' }]);
    state.queue.push([]); // sets: нет
    const bad = await setPpeGroupNorms({ groupId: 'g-1', normSetIds: [NOM] });
    expect(bad.ok).toBe(false);
    state.queue.push([{ id: 'g-1' }]);
    state.queue.push([{ id: NOM }]);
    const set = await setPpeGroupNorms({ groupId: 'g-1', normSetIds: [NOM] });
    expect(set.ok).toBe(true);
    state.queue.push([{ normSetId: NOM }]);
    const got = await getPpeGroupNorms('g-1');
    if (got.ok) expect(got.normSetIds).toEqual([NOM]);
  });
});

describe('ppeService фаза 2: транзитивные нормы', () => {
  it('личные + групповые объединяются', async () => {
    state.queue.push([{ id: CARD }]); // open card
    state.queue.push([{ normSetId: 'ns-1' }]); // cardNorms
    state.queue.push([{ groupId: 'g-1' }]); // memberships
    state.queue.push([{ normSetId: 'ns-2' }, { normSetId: 'ns-1' }]); // groupNorms
    const r = await resolveEmployeeNormSetIds(NOM);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.personal).toEqual(['ns-1']);
      expect(r.group).toEqual(['ns-2', 'ns-1']);
    }
  });

  it('без карточки и групп — пусто', async () => {
    state.queue.push([]); // card: нет
    state.queue.push([]); // memberships: нет
    const r = await resolveEmployeeNormSetIds(NOM);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r).toEqual({ ok: true, personal: [], group: [] });
  });
});
