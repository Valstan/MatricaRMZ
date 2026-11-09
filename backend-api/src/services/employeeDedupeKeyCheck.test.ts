// Проверка карточки сотрудника по ПОЛНОМУ ключу личности на сервере.
//
// Сервер — место, где живёт полный срез сотрудников, поэтому сравнение ключа считается
// здесь. Проверяем главное: совпадение ключа находится, уровень связи верный, и
// блокируется только связь, которую создала ЭТА запись (старый дубль надо дать поправить).
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
const { findEmployeeDuplicatesByKey } = await import('./employeeDedupeService.js');

/** Атрибуты ключа: ФИО, табельный номер, должность, дата приёма, ДР. */
const DEFS = [
  { id: 'def-full', code: 'full_name' },
  { id: 'def-pers', code: 'personnel_number' },
  { id: 'def-role', code: 'role' },
  { id: 'def-hire', code: 'hire_date' },
  { id: 'def-birth', code: 'birth_date' },
];

function attr(entityId: string, defId: string, value: string) {
  return { entityId, defId, valueJson: JSON.stringify(value) };
}
/** Одна живая карточка e-1 и атрибуты. */
function seedSingleEmployee(rows: Array<{ entityId: string; defId: string; valueJson: string }>) {
  state.selectByTable.clear();
  state.selectByTable.set(entityTypes, [[{ id: 'type-1' }]]);
  state.selectByTable.set(attributeDefs, [DEFS]);
  state.selectByTable.set(entities, [[{ id: 'e-1' }]]);
  state.selectByTable.set(attributeValues, [rows]);
  state.selectByTable.set(users, [[{ id: 'e-1', login: 'kira' }]]);
}

beforeEach(() => {
  state.selectByTable.clear();
  vi.clearAllMocks();
});

describe('проверка по полному ключу личности', () => {
  it('совпадение по ФИО + должности + дате приёма — совпал полный ключ', async () => {
    seedSingleEmployee([
      attr('e-1', 'def-full', 'Иванов Иван Иванович'),
      attr('e-1', 'def-role', 'Слесарь'),
      attr('e-1', 'def-hire', '1715904000000'),
    ]);

    const r = await findEmployeeDuplicatesByKey({
      before: {},
      after: {
        full_name: 'Иванов Иван Иванович',
        role: 'Слесарь',
        hire_date: 1715904000000,
      },
      excludeId: 'e-2',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relation).toBe('exact');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.id).toBe('e-1');
    expect(r.matches[0]?.isNew).toBe(true);
    expect(r.matches[0]?.matchedBy).toContain('hire_date');
  });

  it('совпал табельный номер — запрет без обхода', async () => {
    seedSingleEmployee([
      attr('e-1', 'def-full', 'Иванов Иван Иванович'),
      attr('e-1', 'def-pers', '818'),
    ]);

    const r = await findEmployeeDuplicatesByKey({
      before: {},
      after: { full_name: 'Иванов Иван Иванович', personnel_number: '818' },
      excludeId: 'e-2',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relation).toBe('personnel');
  });

  it('совпало только ФИО — однофамильцы, связь слабая', async () => {
    seedSingleEmployee([attr('e-1', 'def-full', 'Иванов Иван Иванович')]);

    const r = await findEmployeeDuplicatesByKey({
      before: {},
      after: { full_name: 'Иванов Иван Иванович' },
      excludeId: 'e-2',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relation).toBe('disputed');
  });

  it('разные ФИО — разные люди, совпадений нет', async () => {
    seedSingleEmployee([attr('e-1', 'def-full', 'Петров Пётр Петрович')]);

    const r = await findEmployeeDuplicatesByKey({
      before: {},
      after: { full_name: 'Иванов Иван Иванович' },
      excludeId: 'e-2',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relation).toBe('different');
    expect(r.matches).toEqual([]);
  });

  it('дубль, который был ДО записи, новой связью не считается — его надо дать поправить', async () => {
    // Карточка e-1 уже совпадала с e-2 по полному ключу. Оператор правит ФИО — и
    // совпадение осталось прежним: блокировать правку нельзя, иначе дубль не исправить.
    seedSingleEmployee([
      attr('e-1', 'def-full', 'Иванов Иван Иванович'),
      attr('e-1', 'def-role', 'Слесарь'),
      attr('e-1', 'def-hire', '1715904000000'),
    ]);

    const r = await findEmployeeDuplicatesByKey({
      before: {
        full_name: 'Иванов Иван Иванович',
        role: 'Слесарь',
        hire_date: 1715904000000,
      },
      after: {
        full_name: 'Иванов Иван Иванович',
        role: 'Токарь',
        hire_date: 1715904000000,
      },
      excludeId: 'e-2',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Связь стала «спорной» (должность разошлась) — но она не выросла, поэтому
    // новой связью не считается и запрета не возникает.
    expect(r.relation).toBe('different');
    expect(r.matches[0]?.isNew).toBe(false);
  });

  it('новый табельный номер, занятый у другого, — новая связь', async () => {
    seedSingleEmployee([
      attr('e-1', 'def-full', 'Иванов Иван Иванович'),
      attr('e-1', 'def-pers', '818'),
    ]);

    const r = await findEmployeeDuplicatesByKey({
      before: { full_name: 'Иванов Иван Иванович' },
      after: { full_name: 'Иванов Иван Иванович', personnel_number: '818' },
      excludeId: 'e-2',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relation).toBe('personnel');
    expect(r.matches[0]?.isNew).toBe(true);
  });

  it('карточка исключается из сравнения сама с собой', async () => {
    seedSingleEmployee([
      attr('e-1', 'def-full', 'Иванов Иван Иванович'),
      attr('e-1', 'def-pers', '818'),
    ]);

    const r = await findEmployeeDuplicatesByKey({
      before: {},
      after: { full_name: 'Иванов Иван Иванович', personnel_number: '818' },
      excludeId: 'e-1',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relation).toBe('different');
    expect(r.matches).toEqual([]);
  });

  it('дописывание последнего поля ключа — новая связь: гейт срабатывает (главный случай ПДО)', async () => {
    // Приходит штатка с датами приёма и ДР: ключ дописывается на глазах у оператора.
    // Уровень связи до и после один и тот же — поймать это может только множество
    // совпавших полей.
    seedSingleEmployee([
      attr('e-1', 'def-full', 'Иванов Иван Иванович'),
      attr('e-1', 'def-role', 'Слесарь'),
      attr('e-1', 'def-hire', '1715904000000'),
      attr('e-1', 'def-birth', '631152000000'),
    ]);

    const r = await findEmployeeDuplicatesByKey({
      before: {
        full_name: 'Иванов Иван Иванович',
        role: 'Слесарь',
        hire_date: 1715904000000,
      },
      after: {
        full_name: 'Иванов Иван Иванович',
        role: 'Слесарь',
        hire_date: 1715904000000,
        birth_date: 631152000000,
      },
      excludeId: 'e-2',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.relation).toBe('exact');
    expect(r.matches[0]?.isNew).toBe(true);
  });

  it('сервер дополняет «до» своим состоянием: даты, которых у оператора нет, видны', async () => {
    // Даты приёма и ДР — HR-чувствительные поля: оператору в чужой карточке они не
    // приезжают (`pullReadFilter`). Без слияния с состоянием сервера дописывание ДР
    // выглядело бы новым совпадением (ложный запрет).
    seedSingleEmployee([
      attr('e-1', 'def-full', 'Иванов Иван Иванович'),
      attr('e-1', 'def-role', 'Слесарь'),
      attr('e-1', 'def-birth', '631152000000'),
    ]);

    const r = await findEmployeeDuplicatesByKey({
      // Оператор прислал только ФИО и должность — даты у него нет.
      before: { full_name: 'Иванов Иван Иванович', role: 'Слесарь' },
      after: { full_name: 'Иванов Иван Иванович', role: 'Слесарь' },
      excludeId: 'e-2',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Ключ сервера уже полон и совпадает — но запись ничего не меняла, значит новая
    // связь не возникла: править старый дубль можно.
    expect(r.matches[0]?.isNew).toBe(false);
  });
});
