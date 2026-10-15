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
  closeCollective,
  closePpeCard,
  createPpeAbsence,
  createPpeGroup,
  deletePpeAbsence,
  deletePpeGroup,
  distributeCollective,
  getPpeCard,
  getPpeCollective,
  getPpeGroupMembers,
  getPpeGroupNorms,
  getPpeNormSet,
  issueDutyPpe,
  issuePpe,
  listPpeAbsences,
  listPpeCollectives,
  listPpeGroups,
  listPpeNormSets,
  openCollective,
  openPpeCard,
  resolveEmployeeNormSetIds,
  setPpeGroupMembers,
  setPpeGroupNorms,
  upsertPpeNormSet,
} from '../services/ppeService.js';
import { createWarehouseDocument } from '../services/warehouseService.js';

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

describe('ppeService PR-3: коллективная выдача', () => {
  const DEP = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
  const EMP2 = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';
  const NOM2 = 'ffffffff-ffff-4fff-ffff-ffffffffffff';
  const line = { employeeId: CARD, nomenclatureId: NOM, qty: 2 };

  function lastCreateCall() {
    const calls = vi.mocked(createWarehouseDocument).mock.calls;
    return calls[calls.length - 1]?.[0] as
      | { docType?: string; departmentId?: string; header?: unknown; lines?: unknown[] }
      | undefined;
  }

  it('пустые шапка/строки — отказ до базы', async () => {
    expect((await openCollective({ departmentId: '', warehouseId: 'w' })).ok).toBe(false);
    expect((await openCollective({ departmentId: DEP, warehouseId: '' })).ok).toBe(false);
    expect((await openCollective({ departmentId: DEP, warehouseId: 'w', lines: [{ ...line, qty: 0 }] })).ok).toBe(false);
    expect((await openCollective({ departmentId: DEP, warehouseId: 'w', lines: [{ ...line, employeeId: ' ' }] })).ok).toBe(false);
  });

  it('битая номенклатура и чужой сотрудник — отказ', async () => {
    state.queue.push([]); // validateNomenclatureIds: пусто
    const badNom = await openCollective({ departmentId: DEP, warehouseId: 'w', lines: [line] });
    expect(badNom.ok).toBe(false);
    if (!badNom.ok) expect(badNom.error).toContain('не существует');
    state.queue.push([{ id: NOM }]); // номенклатура есть
    state.queue.push([]); // сотрудник: нет
    const badEmp = await openCollective({ departmentId: DEP, warehouseId: 'w', lines: [line] });
    expect(badEmp.ok).toBe(false);
    if (!badEmp.ok) expect(badEmp.error).toContain('Сотрудник');
  });

  it('черновик создаётся и редактируется, проведённый не правится', async () => {
    state.queue.push([{ id: NOM }]);
    state.queue.push([{ id: CARD }]);
    state.queue.push([]); // existing: нет
    const created = await openCollective({ departmentId: DEP, warehouseId: 'w', lines: [line] });
    expect(created.ok).toBe(true);

    state.queue.push([{ id: NOM }]);
    state.queue.push([{ id: CARD }]);
    state.queue.push([{ id: 'c-1', documentId: null }]); // черновик
    const edited = await openCollective({ id: 'c-1', departmentId: DEP, warehouseId: 'w', lines: [line] });
    expect(edited.ok).toBe(true);

    state.queue.push([{ id: NOM }]);
    state.queue.push([{ id: CARD }]);
    state.queue.push([{ id: 'c-1', documentId: DOC }]); // уже проведён
    const locked = await openCollective({ id: 'c-1', departmentId: DEP, warehouseId: 'w', lines: [line] });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error).toContain('проведена');
  });

  it('список и карточка отдают строки и счётчики', async () => {
    state.queue.push([{ id: 'c-1', departmentId: DEP, warehouseId: 'w', documentId: null, distributedAt: null }]);
    state.queue.push([
      { collectiveId: 'c-1', employeeId: CARD },
      { collectiveId: 'c-1', employeeId: CARD },
      { collectiveId: 'c-1', employeeId: EMP2 },
    ]);
    const listed = await listPpeCollectives({ departmentId: DEP });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.rows[0]).toMatchObject({ id: 'c-1', linesCount: 3, employeesCount: 2, documentId: null });
    }

    state.queue.push([]); // пустая база
    const empty = await listPpeCollectives();
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.rows).toEqual([]);

    state.queue.push([{ id: 'c-1', departmentId: DEP, warehouseId: 'w', documentId: null, distributedAt: 5 }]);
    state.queue.push([{ id: 'l-1', employeeId: CARD, nomenclatureId: NOM, qty: 1 }]);
    const card = await getPpeCollective('c-1');
    expect(card.ok).toBe(true);
    if (card.ok) {
      expect(card.collective.lines).toHaveLength(1);
      expect(card.collective.distributedAt).toBe(5);
    }
    state.queue.push([]); // нет коллектива
    expect((await getPpeCollective('c-9')).ok).toBe(false);
  });

  it('проведение: документ агрегирован по позиции, следы — по строкам', async () => {
    state.queue.push([{ id: 'c-1', departmentId: DEP, warehouseId: 'w', documentId: null }]);
    state.queue.push([
      { id: 'l-1', employeeId: CARD, nomenclatureId: NOM, qty: 2 },
      { id: 'l-2', employeeId: EMP2, nomenclatureId: NOM, qty: 1 },
      { id: 'l-3', employeeId: EMP2, nomenclatureId: NOM2, qty: 4 },
    ]);
    state.queue.push([{ id: NOM }, { id: NOM2 }]); // validateNomenclatureIds
    state.queue.push([{ id: 'card-2', employeeId: EMP2 }]); // открытая карточка только у EMP2
    const r = await distributeCollective({ collectiveId: 'c-1', actor: ACTOR });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documentId).toBe(DOC);
      expect(r.entries).toBe(3);
      expect(r.employees).toBe(2);
      expect(r.alreadyDistributed).toBe(false);
    }
    expect(lastCreateCall()).toMatchObject({
      docType: 'stock_issue',
      departmentId: DEP,
      header: { warehouseId: 'w' },
      lines: [
        { nomenclatureId: NOM, qty: 3, warehouseId: 'w' },
        { nomenclatureId: NOM2, qty: 4, warehouseId: 'w' },
      ],
    });
  });

  it('проведение: отсутствующая карточка открывается, гонка перечитывает открытую', async () => {
    state.queue.push([{ id: 'c-2', departmentId: DEP, warehouseId: 'w', documentId: null }]);
    state.queue.push([{ id: 'l-1', employeeId: CARD, nomenclatureId: NOM, qty: 1 }]);
    state.queue.push([{ id: NOM }]);
    state.queue.push([]); // открытых карточек нет
    state.failInsert = true; // вставка карточки падает — гонка
    state.queue.push([{ id: 'card-race' }]); // перечитали открытую
    const r = await distributeCollective({ collectiveId: 'c-2', actor: ACTOR });
    expect(r.ok).toBe(true);
  });

  it('повторное проведение второй документ не создаёт', async () => {
    state.queue.push([{ id: 'c-1', departmentId: DEP, warehouseId: 'w', documentId: DOC }]);
    state.queue.push([{ id: 'l-1', employeeId: CARD, nomenclatureId: NOM, qty: 1 }]);
    const r = await distributeCollective({ collectiveId: 'c-1', actor: ACTOR });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.documentId).toBe(DOC);
      expect(r.alreadyDistributed).toBe(true);
    }
    expect(vi.mocked(createWarehouseDocument)).not.toHaveBeenCalled();
  });

  it('пустые строки, сбой создания и сбой проводки — отказ', async () => {
    state.queue.push([{ id: 'c-1', departmentId: DEP, warehouseId: 'w', documentId: null }]);
    state.queue.push([]);
    expect((await distributeCollective({ collectiveId: 'c-1', actor: ACTOR })).ok).toBe(false);

    state.queue.push([{ id: 'c-1', departmentId: DEP, warehouseId: 'w', documentId: null }]);
    state.queue.push([{ id: 'l-1', employeeId: CARD, nomenclatureId: NOM, qty: 1 }]);
    state.queue.push([{ id: NOM }]);
    state.createdDoc = { ok: false, error: 'склад не найден' };
    const noDoc = await distributeCollective({ collectiveId: 'c-1', actor: ACTOR });
    expect(noDoc.ok).toBe(false);
    if (!noDoc.ok) expect(noDoc.error).toContain('склад не найден');

    state.queue.push([{ id: 'c-1', departmentId: DEP, warehouseId: 'w', documentId: null }]);
    state.queue.push([{ id: 'l-1', employeeId: CARD, nomenclatureId: NOM, qty: 1 }]);
    state.queue.push([{ id: NOM }]);
    state.postedDoc = { ok: false, error: 'нет остатка' };
    const notPosted = await distributeCollective({ collectiveId: 'c-1', actor: ACTOR });
    expect(notPosted.ok).toBe(false);
    if (!notPosted.ok) expect(notPosted.error).toContain('черновиком');
  });

  it('отмена: черновик закрывается, проведённый — нет', async () => {
    state.queue.push([{ id: 'c-1', documentId: null }]);
    expect((await closeCollective('c-1')).ok).toBe(true);
    state.queue.push([{ id: 'c-1', documentId: DOC }]);
    const done = await closeCollective('c-1');
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error).toContain('сторнируйте');
    state.queue.push([]);
    expect((await closeCollective('c-9')).ok).toBe(false);
  });
});

describe('ppeService PR-3: дежурные', () => {
  const DEP = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';

  it('пустые входы и не-дежурный набор — отказ', async () => {
    expect((await issueDutyPpe({ normSetId: '', warehouseId: 'w', actor: ACTOR })).ok).toBe(false);
    expect((await issueDutyPpe({ normSetId: NOM, warehouseId: '', actor: ACTOR })).ok).toBe(false);
    state.queue.push([{ id: NOM, isDuty: false, departmentId: DEP }]);
    const notDuty = await issueDutyPpe({ normSetId: NOM, warehouseId: 'w', actor: ACTOR });
    expect(notDuty.ok).toBe(false);
    if (!notDuty.ok) expect(notDuty.error).toContain('дежурн');
  });

  it('дежурному набору нужны подразделение и строки', async () => {
    state.queue.push([{ id: NOM, isDuty: true, departmentId: null }]);
    expect((await issueDutyPpe({ normSetId: NOM, warehouseId: 'w', actor: ACTOR })).ok).toBe(false);
    state.queue.push([{ id: NOM, isDuty: true, departmentId: DEP }]);
    state.queue.push([]); // строк нет
    expect((await issueDutyPpe({ normSetId: NOM, warehouseId: 'w', actor: ACTOR })).ok).toBe(false);
  });

  it('выдача: документ на подразделение набора, без персональных следов', async () => {
    state.queue.push([{ id: NOM, isDuty: true, departmentId: DEP }]);
    state.queue.push([{ nomenclatureId: NOM, qty: 5 }]);
    const r = await issueDutyPpe({ normSetId: NOM, warehouseId: 'w', actor: ACTOR });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.documentId).toBe(DOC);
    const calls = vi.mocked(createWarehouseDocument).mock.calls;
    expect(calls[calls.length - 1]?.[0]).toMatchObject({
      docType: 'stock_issue',
      departmentId: DEP,
      header: { warehouseId: 'w' },
      lines: [{ nomenclatureId: NOM, qty: 5, warehouseId: 'w' }],
    });
  });

  it('проводка упала — черновик без следа', async () => {
    state.queue.push([{ id: NOM, isDuty: true, departmentId: DEP }]);
    state.queue.push([{ nomenclatureId: NOM, qty: 5 }]);
    state.postedDoc = { ok: false, error: 'склад пуст' };
    const r = await issueDutyPpe({ normSetId: NOM, warehouseId: 'w', actor: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('черновиком');
  });
});
