// Гейт дублей сотрудников: точечная проверка (ФИО и табельный номер) и слияние ГРУППОЙ.
//
// Прежние проверки этого сервиса гоняют `mergeEmployees` (пару). Здесь — то, что владелец
// попросил 07.11.2026: (1) дубль не должен появиться молча, (2) сливать можно сразу
// несколько записей, а не только две.
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

const { entities, entityTypes, attributeDefs, attributeValues, users } = await import(
  '../database/schema.js'
);
const { findEmployeeDuplicates, mergeEmployeeGroup } = await import('./employeeDedupeService.js');

const ACTOR = { id: 'a-1', username: 'admin', role: 'admin' };

/** Засыпать ответы по таблицам в порядке, в котором сервис их спрашивает. */
function seed(tables: Array<[unknown, unknown[][]]>) {
  state.selectByTable.clear();
  for (const [table, rows] of tables) state.selectByTable.set(table, rows);
}

beforeEach(() => {
  state.selectByTable.clear();
  vi.clearAllMocks();
});

describe('точечная проверка дубля', () => {
  it('находит совпадение по ФИО (регистр и «ё» не важны)', async () => {
    seed([
      [entityTypes, [[{ id: 'type-1' }]]],
      [
        attributeDefs,
        [
          [
            { id: 'def-full', code: 'full_name' },
            { id: 'def-pers', code: 'personnel_number' },
          ],
        ],
      ],
      [entities, [[{ id: 'e-1' }, { id: 'e-2' }]]],
      [users, [[{ id: 'e-1', login: 'kira', systemRole: 'worker', accessEnabled: true }]]],
      [
        attributeValues,
        [
          [
            { entityId: 'e-1', defId: 'def-full', valueJson: '"Хапикова Ирина Сергеевна"' },
            { entityId: 'e-1', defId: 'def-pers', valueJson: '"818"' },
            { entityId: 'e-2', defId: 'def-full', valueJson: '"Хапикова Ирина Сергеевна"' },
          ],
        ],
      ],
    ]);

    const r = await findEmployeeDuplicates({ fullName: 'хапикова ирина сергеевна' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Обе записи группы носят одно ФИО — находятся обе, и это ровно то, что оператор
    // потом выбирает галочками для слияния.
    expect(r.matches).toHaveLength(2);
    expect(r.matches.map((m) => m.id).sort()).toEqual(['e-1', 'e-2']);
    for (const m of r.matches) expect(m.matchedBy).toEqual(['name']);
  });

  it('находит совпадение по табельному номеру, даже если ФИО другое', async () => {
    seed([
      [entityTypes, [[{ id: 'type-1' }]]],
      [
        attributeDefs,
        [[{ id: 'def-full', code: 'full_name' }, { id: 'def-pers', code: 'personnel_number' }]],
      ],
      [entities, [[{ id: 'e-1' }, { id: 'e-2' }]]],
      [users, [[{ id: 'e-1', login: 'kira', systemRole: 'worker', accessEnabled: true }]]],
      [
        attributeValues,
        [
          [
            { entityId: 'e-1', defId: 'def-full', valueJson: '"Иванов Иван Иванович"' },
            { entityId: 'e-1', defId: 'def-pers', valueJson: '"818"' },
            { entityId: 'e-2', defId: 'def-full', valueJson: '"Петров Пётр Петрович"' },
          ],
        ],
      ],
    ]);

    const r = await findEmployeeDuplicates({ personnelNumber: '818' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.id).toBe('e-1');
    expect(r.matches[0]?.matchedBy).toEqual(['personnel']);
  });

  it('саму проверяемую запись в совпадения не выдаёт (правка ФИО у себя)', async () => {
    seed([
      [entityTypes, [[{ id: 'type-1' }]]],
      [attributeDefs, [[{ id: 'def-full', code: 'full_name' }]]],
      [entities, [[{ id: 'e-1' }]]],
      [users, [[]]],
      [
        attributeValues,
        [[{ entityId: 'e-1', defId: 'def-full', valueJson: '"Иванов Иван Иванович"' }]],
      ],
    ]);

    const r = await findEmployeeDuplicates({ fullName: 'Иванов Иван Иванович', excludeId: 'e-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toEqual([]);
  });

  it('пустое имя и пустой номер — проверять нечего', async () => {
    const r = await findEmployeeDuplicates({ fullName: '   ', personnelNumber: '' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matches).toEqual([]);
  });
});

describe('слияние группы дублей', () => {
  it('без выбранных дублей — отказ, а не пустое «успешно»', async () => {
    const r = await mergeEmployeeGroup({ survivorId: 'e-1', loserIds: [], actor: ACTOR });
    expect(r.ok).toBe(false);
  });

  it('основная запись не может быть дублем', async () => {
    const r = await mergeEmployeeGroup({ survivorId: 'e-1', loserIds: ['e-1'], actor: ACTOR });
    expect(r.ok).toBe(false);
  });

  it('обрыв на первом дубле останавливает слияние — следующие не трогаем', async () => {
    // Основной записи среди действующих нет → первое же слияние откажется.
    // Тип сущности спрашивается дважды: проверкой конфликтов перед слиянием и самим
    // слиянием (первый запрос — у группы, второй — у пары).
    seed([
      [entityTypes, [[{ id: 'type-1' }], [{ id: 'type-1' }]]],
      [entities, [[]]],
    ]);
    const r = await mergeEmployeeGroup({ survivorId: 'e-1', loserIds: ['e-2', 'e-3'], actor: ACTOR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.merged).toHaveLength(0);
    expect(r.report.failed?.loserId).toBe('e-2');
    expect(r.report.failed?.error).toContain('основная запись не найдена');
  });
});
