import { describe, expect, it } from 'vitest';

import {
  addWearMonths,
  matchEmployeeSizePosition,
  nextIssueDates,
  PPE_DAY_MS,
  ppeSizeKindForName,
  resolveEmployeeNorms,
  resolveGroupNorms,
  shiftByAbsences,
  upcomingIssues,
} from './ppe.js';

const NOM_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const NOM_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const T0 = Date.UTC(2026, 9, 11);

describe('ppe: слияние норм', () => {
  it('количества суммируются, срок — минимальный, порядок детерминирован', () => {
    const merged = resolveEmployeeNorms([
      { normSetId: 'ns-2', nomenclatureId: NOM_B, qty: 1, wearMonths: 24 },
      { normSetId: 'ns-1', nomenclatureId: NOM_A, qty: 2, wearMonths: 12 },
      { normSetId: 'ns-2', nomenclatureId: NOM_A, qty: 1, wearMonths: 6 },
    ]);
    expect(merged).toEqual([
      { nomenclatureId: NOM_A, qty: 3, wearMonths: 6 },
      { nomenclatureId: NOM_B, qty: 1, wearMonths: 24 },
    ]);
  });

  it('пустой вход — пустой выход', () => {
    expect(resolveEmployeeNorms([])).toEqual([]);
  });
});

describe('ppe: месяцы календарные', () => {
  it('12 мес от 11.10.2026 — 11.10.2027', () => {
    expect(addWearMonths(T0, 12)).toBe(Date.UTC(2027, 9, 11));
  });
});

describe('ppe: даты следующих выдач', () => {
  const merged = [
    { nomenclatureId: NOM_A, qty: 2, wearMonths: 12 },
    { nomenclatureId: NOM_B, qty: 1, wearMonths: 1 },
  ];

  it('без выдач — neverIssued, срок не тикает из пустоты', () => {
    const [a, b] = nextIssueDates(merged, [], T0);
    expect(a.status).toBe('neverIssued');
    expect(a.nextDueAt).toBeNull();
    expect(b.status).toBe('neverIssued');
  });

  it('свежая выдача — ok, старая — overdue', () => {
    const yearAgo = Date.UTC(2025, 9, 10);
    const [a] = nextIssueDates(merged, [{ nomenclatureId: NOM_A, qty: 2, issuedAt: yearAgo }], T0);
    expect(a.status).toBe('overdue');
    expect(a.nextDueAt).toBe(Date.UTC(2026, 9, 10));
    const [fresh] = nextIssueDates(merged, [{ nomenclatureId: NOM_A, qty: 2, issuedAt: T0 }], T0);
    expect(fresh.status).toBe('ok');
  });

  it('граница dueSoon: 10 дней до срока — dueSoon, 20 — ok', () => {
    const dueIn10 = T0 + 10 * PPE_DAY_MS;
    const last10 = new Date(dueIn10);
    const issued10 = Date.UTC(last10.getUTCFullYear(), last10.getUTCMonth() - 1, last10.getUTCDate());
    const [n10] = nextIssueDates(
      [{ nomenclatureId: NOM_B, qty: 1, wearMonths: 1 }],
      [{ nomenclatureId: NOM_B, qty: 1, issuedAt: issued10 }],
      T0,
    );
    expect(n10.status).toBe('dueSoon');
    const dueIn20 = T0 + 20 * PPE_DAY_MS;
    const last20 = new Date(dueIn20);
    const issued20 = Date.UTC(last20.getUTCFullYear(), last20.getUTCMonth() - 1, last20.getUTCDate());
    const [n20] = nextIssueDates(
      [{ nomenclatureId: NOM_B, qty: 1, wearMonths: 1 }],
      [{ nomenclatureId: NOM_B, qty: 1, issuedAt: issued20 }],
      T0,
    );
    expect(n20.status).toBe('ok');
  });

  it('берётся последняя выдача, а не первая', () => {
    const old = Date.UTC(2024, 0, 1);
    const [a] = nextIssueDates(merged, [
      { nomenclatureId: NOM_A, qty: 2, issuedAt: old },
      { nomenclatureId: NOM_A, qty: 2, issuedAt: T0 },
    ], T0);
    expect(a.lastIssuedAt).toBe(T0);
    expect(a.status).toBe('ok');
  });
});

describe('ppe: ближайшие выдачи', () => {
  it('в горизонт попадают просрочка и близкие сроки, сортировка по дате', () => {
    const merged = [
      { nomenclatureId: NOM_A, qty: 2, wearMonths: 12 },
      { nomenclatureId: NOM_B, qty: 1, wearMonths: 12 },
    ];
    const rows = upcomingIssues(
      merged,
      [
        { nomenclatureId: NOM_B, qty: 1, issuedAt: Date.UTC(2025, 9, 11) },
        { nomenclatureId: NOM_A, qty: 2, issuedAt: Date.UTC(2020, 0, 1) },
      ],
      T0,
      30,
    );
    expect(rows.map((r) => r.nomenclatureId)).toEqual([NOM_A, NOM_B]);
    expect(rows.every((r) => r.status === 'overdue')).toBe(true);
  });

  it('далёкие сроки в короткий горизонт не попадают', () => {
    const rows = upcomingIssues(
      [{ nomenclatureId: NOM_A, qty: 2, wearMonths: 12 }],
      [{ nomenclatureId: NOM_A, qty: 2, issuedAt: T0 }],
      T0,
      30,
    );
    expect(rows).toEqual([]);
  });
});

describe('ppe фаза 2: фильтр норм по условиям', () => {
  const lines = [
    { normSetId: 'ns-m-win', nomenclatureId: NOM_A, qty: 1, wearMonths: 12, setGender: 'M', setSeason: 'winter' },
    { normSetId: 'ns-all', nomenclatureId: NOM_B, qty: 2, wearMonths: 6, setGender: null, setSeason: null },
    { normSetId: 'ns-f', nomenclatureId: NOM_A, qty: 1, wearMonths: 24, setGender: 'F', setSeason: null },
  ];

  it('мужчина зимой: мужской зимний + всесезонный, женский отрезан', () => {
    const merged = resolveEmployeeNorms(lines, { gender: 'M', season: 'winter' });
    expect(merged).toEqual([
      { nomenclatureId: NOM_A, qty: 1, wearMonths: 12 },
      { nomenclatureId: NOM_B, qty: 2, wearMonths: 6 },
    ]);
  });

  it('женщина летом: женский всесезонный + общий, зимний отрезан', () => {
    const merged = resolveEmployeeNorms(lines, { gender: 'F', season: 'summer' });
    expect(merged).toEqual([
      { nomenclatureId: NOM_A, qty: 1, wearMonths: 24 },
      { nomenclatureId: NOM_B, qty: 2, wearMonths: 6 },
    ]);
  });

  it('без второго аргумента — ровно поведение MVP (ничего не режется)', () => {
    const merged = resolveEmployeeNorms(lines);
    expect(merged).toEqual([
      { nomenclatureId: NOM_A, qty: 2, wearMonths: 12 },
      { nomenclatureId: NOM_B, qty: 2, wearMonths: 6 },
    ]);
  });

  it('строки без условий (старые данные) проходят любой контекст', () => {
    const merged = resolveEmployeeNorms(
      [{ normSetId: 'ns-old', nomenclatureId: NOM_A, qty: 1, wearMonths: 12 }],
      { gender: 'F', season: 'winter' },
    );
    expect(merged).toEqual([{ nomenclatureId: NOM_A, qty: 1, wearMonths: 12 }]);
  });
});

describe('ppe фаза 2: сдвиг срока на отпуска', () => {
  const DUE = Date.UTC(2026, 9, 11);

  it('отпуск целиком до срока сдвигает на его длину', () => {
    expect(shiftByAbsences(DUE, [{ fromMs: DUE - 10 * PPE_DAY_MS, toMs: DUE - 3 * PPE_DAY_MS }])).toBe(
      DUE + 7 * PPE_DAY_MS,
    );
  });

  it('пересекающиеся отпуска считаются по объединению, а не дважды', () => {
    expect(
      shiftByAbsences(DUE, [
        { fromMs: DUE - 10 * PPE_DAY_MS, toMs: DUE - 3 * PPE_DAY_MS },
        { fromMs: DUE - 5 * PPE_DAY_MS, toMs: DUE - 1 * PPE_DAY_MS },
      ]),
    ).toBe(DUE + 9 * PPE_DAY_MS);
  });

  it('отпуск после срока и пустой список ничего не сдвигают', () => {
    expect(shiftByAbsences(DUE, [{ fromMs: DUE + PPE_DAY_MS, toMs: DUE + 10 * PPE_DAY_MS }])).toBe(DUE);
    expect(shiftByAbsences(DUE, [])).toBe(DUE);
  });

  it('nextIssueDates принимает отсутствия пятым аргументом', () => {
    const issued = Date.UTC(2025, 9, 11);
    const [plain] = nextIssueDates([{ nomenclatureId: NOM_A, qty: 1, wearMonths: 12 }], [
      { nomenclatureId: NOM_A, qty: 1, issuedAt: issued },
    ], T0);
    expect(plain.nextDueAt).toBe(Date.UTC(2026, 9, 11));
    const [shifted] = nextIssueDates(
      [{ nomenclatureId: NOM_A, qty: 1, wearMonths: 12 }],
      [{ nomenclatureId: NOM_A, qty: 1, issuedAt: issued }],
      T0,
      14,
      [{ fromMs: Date.UTC(2026, 5, 1), toMs: Date.UTC(2026, 5, 11) }],
    );
    expect(shifted.nextDueAt).toBe(Date.UTC(2026, 9, 11) + 10 * PPE_DAY_MS);
  });
});

describe('ppe фаза 2: групповые нормы', () => {
  it('личные + нормы своих групп, дедуп, чужие группы мимо', () => {
    expect(
      resolveGroupNorms({
        personalNormSetIds: ['ns-1', 'ns-2'],
        memberGroupIds: ['g-1'],
        groupNorms: [
          { groupId: 'g-1', normSetId: 'ns-2' },
          { groupId: 'g-1', normSetId: 'ns-3' },
          { groupId: 'g-9', normSetId: 'ns-4' },
        ],
      }),
    ).toEqual(['ns-1', 'ns-2', 'ns-3']);
  });

  it('без групп — только личные', () => {
    expect(resolveGroupNorms({ personalNormSetIds: ['ns-1'], memberGroupIds: [], groupNorms: [] })).toEqual(['ns-1']);
  });
});

describe('ppe: подсказка размера сотрудника при выдаче', () => {
  const row = (id: string, name: string) => ({ id, name });
  const костюм = [row('n-46', 'Костюм зимний р.46'), row('n-48', 'Костюм зимний р.48'), row('n-50', 'Костюм зимний р.50')];

  it('размер совпадает целым словом в имени позиции', () => {
    expect(matchEmployeeSizePosition({ children: костюм, size: '48' })).toBe('n-48');
  });

  it('однозначная цифра не совпадает с чужим числом: «8» — это не «р. 48»', () => {
    expect(matchEmployeeSizePosition({ children: костюм, size: '8' })).toBeNull();
  });

  it('размер из карточки может быть записан как «р. 48» — берём числовую часть', () => {
    expect(matchEmployeeSizePosition({ children: [row('n-48', 'Костюм зимний р.48')], size: 'р. 48' })).toBe('n-48');
  });

  it('два совпадения по размеру — неоднозначно, подсказки нет', () => {
    expect(
      matchEmployeeSizePosition({
        children: [row('n-176', 'Брюки 48/176'), row('n-182', 'Брюки 48/182')],
        size: '48',
      }),
    ).toBeNull();
  });

  it('рост разводит «размер + рост» у брюк и комбинезонов', () => {
    expect(
      matchEmployeeSizePosition({
        children: [row('n-176', 'Брюки 48/176'), row('n-182', 'Брюки 48/182')],
        size: '48',
        height: '182',
      }),
    ).toBe('n-182');
  });

  it('пустой размер — без подсказки', () => {
    expect(matchEmployeeSizePosition({ children: [row('n-48', 'Костюм р.48')], size: '' })).toBeNull();
  });

  it('обувь и одежда опознаются по названию, прочее — нет', () => {
    expect(ppeSizeKindForName('Ботинки рабочие 42')).toBe('shoes');
    expect(ppeSizeKindForName('Костюм зимний р.48')).toBe('clothes');
    expect(ppeSizeKindForName('Перчатки комбинированные р.9')).toBeNull();
    expect(ppeSizeKindForName('Каска защитная')).toBeNull();
  });
});
