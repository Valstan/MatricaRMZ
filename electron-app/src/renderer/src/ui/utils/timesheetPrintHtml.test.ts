import { describe, expect, it } from 'vitest';

import { TIMESHEET_DEFAULT_CODES, TIMESHEET_PRINT_FONT_DEFAULTS, TIMESHEET_PRINT_ROW_HEIGHT_MAX_PX } from '@matricarmz/shared';

import {
  buildTimesheetPrintSections,
  TIMESHEET_PRINT_WEEKEND_BG,
  type TimesheetPrintBlocks,
  type TimesheetPrintCell,
  type TimesheetPrintInput,
} from './timesheetPrintHtml.js';

const fonts = TIMESHEET_PRINT_FONT_DEFAULTS;
const allBlocks: TimesheetPrintBlocks = { header: true, grid: true, legend: true, decode: false };
// Август 2026: 1 и 2 — сб и вс; 3 августа — понедельник.
const YEAR = 2026;
const MONTH = 8;
const DAYS = 31;

function input(overrides: Partial<TimesheetPrintInput> = {}): TimesheetPrintInput {
  const cells: Record<string, TimesheetPrintCell> = {};
  return {
    year: YEAR,
    month: MONTH,
    weekMode: 5,
    days: DAYS,
    dayList: Array.from({ length: DAYS }, (_, i) => i + 1),
    rows: [
      { id: 'r1', fullName: 'Асхатов Рамиль Зулкафирович', position: 'Слесарь-ремонтник 5 разряда' },
      { id: 'r2', fullName: 'Иванова Мария Петровна', position: 'Мастер участка' },
    ],
    codes: [...TIMESHEET_DEFAULT_CODES],
    getCell: (rowId, day) => cells[`${rowId}:${day}`] ?? { code: null, hours: null, comment: null },
    workshopName: 'Цех №1',
    ...overrides,
  };
}

function gridHtml(inp: TimesheetPrintInput = input(), blocks: TimesheetPrintBlocks = allBlocks): string {
  const section = buildTimesheetPrintSections(inp, fonts, 'full', blocks).find((s) => s.id === 'grid');
  expect(section).toBeTruthy();
  return section?.html ?? '';
}

describe('печатная форма табеля — ФИО', () => {
  it('печатает фамилию целиком и инициалы с точками, без имени и отчества', () => {
    const html = gridHtml();
    expect(html).toContain('Асхатов Р.З.');
    expect(html).not.toContain('Рамиль');
    expect(html).not.toContain('Зулкафирович');
    expect(html).toContain('Иванова М.П.');
  });

  it('однословную фамилию оставляет как есть', () => {
    const html = gridHtml(input({ rows: [{ id: 'r1', fullName: 'Асхатов' }] }));
    expect(html).toContain('>Асхатов<');
  });

  it('не печатает должность — место отдано клеткам под запись ручкой', () => {
    const html = gridHtml();
    expect(html).not.toContain('Слесарь-ремонтник');
    expect(html).not.toContain('Мастер участка');
  });
});

describe('печатная форма табеля — место под ручной ввод', () => {
  it('строка занимает весь остаток листа: у небольшой бригады клетки максимальной высоты', () => {
    expect(gridHtml()).toContain(`<tr style="height:${TIMESHEET_PRINT_ROW_HEIGHT_MAX_PX}px">`);
  });

  it('на большом цехе строка сжимается, но высота всё равно задана явно', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, fullName: `Фамилия${i} Имя Отчество` }));
    const html = gridHtml(input({ rows }));
    const m = /<tr style="height:(\d+)px">/.exec(html);
    expect(m).toBeTruthy();
    const h = Number(m?.[1]);
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(TIMESHEET_PRINT_ROW_HEIGHT_MAX_PX);
  });

  it('служебные колонки сжаты по содержимому, ширину листа забирают дни', () => {
    const html = gridHtml();
    expect(html).toContain('width:1%;white-space:nowrap">№<');
    // 31 колонка дня делит между собой 92% ширины листа.
    expect(html).toContain(`width:${Math.floor(92 / DAYS)}%`);
  });
});

describe('печатная форма табеля — выходные', () => {
  it('заливает выходные тёмным серым, который пропечатывается принтером', () => {
    const html = gridHtml();
    expect(html).toContain(`background:${TIMESHEET_PRINT_WEEKEND_BG}`);
    // Светлая экранная заливка на бумагу больше не идёт.
    expect(html).not.toContain('#f1f5f9');
  });

  it('рабочие дни не заливает: при 6-дневке суббота становится рабочей', () => {
    const five = gridHtml();
    const six = gridHtml(input({ weekMode: 6 }));
    const count = (s: string) => s.split(`background:${TIMESHEET_PRINT_WEEKEND_BG}`).length - 1;
    // Август 2026: 5 суббот и 5 воскресений → 10 выходных при 5-дневке, 5 при 6-дневке (на строку).
    expect(count(five)).toBeGreaterThan(count(six));
    expect(count(six)).toBe(5 * 2);
  });
});

describe('печатная форма табеля — блоки', () => {
  it('снятая галочка убирает блок с листа', () => {
    const ids = buildTimesheetPrintSections(input(), fonts, 'full', { header: false, grid: true, legend: false, decode: false }).map((s) => s.id);
    expect(ids).toEqual(['grid']);
  });

  it('половинки месяца режут колонки дней', () => {
    const first = buildTimesheetPrintSections(input(), fonts, 'first', allBlocks).find((s) => s.id === 'grid')?.html ?? '';
    const second = buildTimesheetPrintSections(input(), fonts, 'second', allBlocks).find((s) => s.id === 'grid')?.html ?? '';
    expect(first).toContain('>15<');
    expect(first).not.toContain('>16<');
    expect(second).toContain('>16<');
    expect(second).toContain('>31<');
  });
});
