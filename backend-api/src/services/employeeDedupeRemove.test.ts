// Дубли сотрудников: правило «один человек или двое разных» и «удалить дубль» = слияние.
//
// План владельца 09.11.2026 («Дубли сотрудников — запрет создания, починка слияния
// для троих, доступ оператору»):
//  - блокер слияния — РАСХОЖДЕНИЕ ЗНАЧЕНИЙ, а не «меньше заполненных полей»;
//  - тройка дублей одного человека обязана сливаться;
//  - двое РАЗНЫХ людей с разными табельными — не сливаются, внятный отказ;
//  - удаление карточки-дубля = слияние: ссылки перевешиваются, карточка гаснет.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ selectByTable: new Map<unknown, unknown[][]>() }));

vi.mock('../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
  };
  return { db };
});

vi.mock('./adminMasterdataService.js', () => ({
  setEntityAttribute: vi.fn(async () => ({ ok: true })),
  softDeleteEntity: vi.fn(async () => ({ ok: true })),
  upsertAttributeDef: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./employeeAuthService.js', () => ({ setEmployeeAuth: vi.fn(async () => ({ ok: true })) }));
vi.mock('./employeeReferenceRepoint.js', () => ({
  repointEmployeeReferences: vi.fn(async () => ({ moved: 0, byStore: [], blockers: [], notes: [] })),
}));
vi.mock('./userDeletionService.js', () => ({ reassignUserReferences: vi.fn(async () => undefined) }));
vi.mock('./criticalEventsService.js', () => ({ ingestServerCriticalEvent: vi.fn() }));

const { entities, entityTypes, attributeDefs, attributeValues, users } = await import('../database/schema.js');
const { mergeEmployeeGroup, removeDuplicateEmployee, __testables } = await import('./employeeDedupeService.js');

const ACTOR = { id: 'a-1', username: 'operator', role: 'storekeeper' };

const DEFS = [
  { id: 'def-full', code: 'full_name' },
  { id: 'def-pers', code: 'personnel_number' },
  { id: 'def-role', code: 'role' },
];

/** Атрибуты карточки в виде строк attribute_values. */
function attrsOf(
  id: string,
  full: string,
  personnel: string,
  role: string,
): Array<{ entityId: string; defId: string; attributeDefId: string; valueJson: string }> {
  // `defId` — как в `loadAllEmployeeAttrs` (алиас выбора), `attributeDefId` — как в
  // `loadAttrs` (выбор без алиаса): обе читают одни и те же строки.
  const row = (defId: string, value: string) => ({
    entityId: id,
    defId,
    attributeDefId: defId,
    valueJson: JSON.stringify(value),
  });
  const rows: Array<{ entityId: string; defId: string; attributeDefId: string; valueJson: string }> = [
    row('def-full', full),
    row('def-role', role),
  ];
  if (personnel) rows.push(row('def-pers', personnel));
  return rows;
}

function seed(tables: Array<[unknown, unknown[][]]>) {
  state.selectByTable.clear();
  for (const [table, rows] of tables) state.selectByTable.set(table, rows);
}

beforeEach(() => {
  state.selectByTable.clear();
  vi.clearAllMocks();
});

describe('отношение двух карточек: один человек или двое разных', () => {
  const { employeeRelation } = __testables;

  const card = (personnel: string, role: string) =>
    new Map([
      ['personnel_number', personnel],
      ['role', role],
    ]);

  it('один человек: совпал табельный номер', () => {
    expect(employeeRelation(card('818', 'кладовщик'), card('818', 'кладовщик'))).toBe('same');
  });

  it('один человек: номер не заполнен у одной карточки, должность совпала', () => {
    expect(employeeRelation(card('818', 'кладовщик'), card('', 'кладовщик'))).toBe('same');
  });

  it('спорный случай: табельные разные, должность одна — решает оператор', () => {
    expect(employeeRelation(card('818', 'кладовщик'), card('819', 'кладовщик'))).toBe('disputed');
  });

  it('разные люди: табельные и должности разные', () => {
    expect(employeeRelation(card('818', 'кладовщик'), card('819', 'электрик'))).toBe('different');
  });
});

describe('расхождения между карточками', () => {
  const { collectConflicts } = __testables;

  it('пустое поле расхождением не считается — «не заполнено» ≠ «по-разному»', () => {
    const conflicts = collectConflicts([
      { id: 'e-1', attrs: new Map([['personnel_number', '818'], ['role', 'кладовщик']]) },
      { id: 'e-2', attrs: new Map([['role', 'кладовщик']]) },
    ]);
    expect(conflicts).toEqual([]);
  });

  it('разные табельные номера — расхождение, и оно видно оператору', () => {
    const conflicts = collectConflicts([
      { id: 'e-1', attrs: new Map([['personnel_number', '818']]) },
      { id: 'e-2', attrs: new Map([['personnel_number', '819']]) },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.code).toBe('personnel_number');
    expect(conflicts[0]?.values.map((v) => v.value)).toEqual(['818', '819']);
  });
});

describe('слияние группы: блокер — расхождение, а не счёт заполненных полей', () => {
  it('двое разных людей с разными табельными не сливаются — внятный отказ', async () => {
    seed([
      [entityTypes, [[{ id: 'type-1' }]]],
      [attributeDefs, [DEFS]],
      [
        attributeValues,
        [
          attrsOf('e-1', 'Иванов Иван Иванович', '818', 'кладовщик'),
          attrsOf('e-2', 'Иванов Иван Иванович', '819', 'электрик'),
        ],
      ],
    ]);
    const r = await mergeEmployeeGroup({ survivorId: 'e-1', loserIds: ['e-2'], actor: ACTOR });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('разные люди');
  });

  it('тройка дублей одного человека сливается целиком, а расхождение попадает в отчёт', async () => {
    // Один табельный номер у всех — значит один человек; должности расходятся (оператор
    // увидит это в отчёте, но слияние не встанет).
    const e1 = attrsOf('e-1', 'Иванов Иван Иванович', '818', 'кладовщик');
    const e2 = attrsOf('e-2', 'Иванов Иван Иванович', '818', 'кладовщик');
    const e3 = attrsOf('e-3', 'Иванов Иван Иванович', '818', 'электрик');
    seed([
      // getEmployeeTypeId + loadCodeByDefId в группе, затем то же в каждом слиянии.
      [entityTypes, [[{ id: 'type-1' }], [{ id: 'type-1' }], [{ id: 'type-1' }]]],
      [attributeDefs, [DEFS, DEFS, DEFS]],
      // Атрибуты: три карточки для проверки конфликтов, затем по две на каждое слияние.
      [attributeValues, [e1, e2, e3, e1, e2, e1, e3]],
      [entities, [[{ id: 'e-1' }, { id: 'e-2' }], [{ id: 'e-1' }, { id: 'e-3' }]]],
      [users, [[], []]],
    ]);
    const r = await mergeEmployeeGroup({ survivorId: 'e-1', loserIds: ['e-2', 'e-3'], actor: ACTOR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.merged).toHaveLength(2);
    expect(r.report.failed).toBeNull();
    expect(r.report.conflicts.map((c) => c.code)).toContain('role');
  });
});

describe('удаление карточки-дубля = слияние с настоящей карточкой', () => {
  it('дубль без входа гасится слиянием в карточку, где вход есть', async () => {
    const e1 = attrsOf('e-1', 'Иванов Иван Иванович', '', 'кладовщик');
    const e2 = attrsOf('e-2', 'Иванов Иван Иванович', '818', 'кладовщик');
    seed([
      [entityTypes, [[{ id: 'type-1' }], [{ id: 'type-1' }]]],
      [attributeDefs, [DEFS, DEFS]],
      // Срез всех атрибутов, затем по карточке в самом слиянии.
      [attributeValues, [[...e1, ...e2], e2, e1]],
      [entities, [[{ id: 'e-1' }, { id: 'e-2' }], [{ id: 'e-2' }, { id: 'e-1' }]]],
      [users, [[{ id: 'e-2', login: 'kira' }], [{ id: 'e-2', login: 'kira' }]]],
    ]);
    const r = await removeDuplicateEmployee({ employeeId: 'e-1', actor: ACTOR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.survivorId).toBe('e-2');
  });

  it('карточка без дубля — отказ: удалять кадровую карточку может администратор', async () => {
    const e1 = attrsOf('e-1', 'Иванов Иван Иванович', '818', 'кладовщик');
    const e2 = attrsOf('e-2', 'Петров Пётр Петрович', '900', 'электрик');
    seed([
      [entityTypes, [[{ id: 'type-1' }]]],
      [attributeDefs, [DEFS]],
      [attributeValues, [[...e1, ...e2]]],
      [entities, [[{ id: 'e-1' }, { id: 'e-2' }]]],
      [users, [[]]],
    ]);
    const r = await removeDuplicateEmployee({ employeeId: 'e-1', actor: ACTOR });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_duplicate');
  });

  it('у карточки есть вход, а у найденной — нет: удаление отключило бы человеку доступ', async () => {
    const e1 = attrsOf('e-1', 'Иванов Иван Иванович', '818', 'кладовщик');
    const e2 = attrsOf('e-2', 'Иванов Иван Иванович', '', 'кладовщик');
    seed([
      [entityTypes, [[{ id: 'type-1' }]]],
      [attributeDefs, [DEFS]],
      [attributeValues, [[...e1, ...e2]]],
      [entities, [[{ id: 'e-1' }, { id: 'e-2' }]]],
      [users, [[{ id: 'e-1', login: 'kira' }]]],
    ]);
    const r = await removeDuplicateEmployee({ employeeId: 'e-1', actor: ACTOR });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('login');
  });
});
