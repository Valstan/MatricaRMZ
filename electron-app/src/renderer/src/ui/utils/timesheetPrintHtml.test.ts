import { describe, expect, it } from 'vitest';

import {
  resolveTimesheetPrintInk,
  TIMESHEET_DEFAULT_CODES,
  TIMESHEET_PRINT_FONT_DEFAULTS,
  TIMESHEET_PRINT_ROW_HEIGHT_MAX_PX,
  type TimesheetPrintSettings,
} from '@matricarmz/shared';

import {
  buildTimesheetPrintSections,
  timesheetPrintCss,
  type TimesheetPrintBlocks,
  type TimesheetPrintCell,
  type TimesheetPrintInput,
} from './timesheetPrintHtml.js';

const fonts = TIMESHEET_PRINT_FONT_DEFAULTS;
const defaultInk = resolveTimesheetPrintInk({});
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

function gridHtml(inp: TimesheetPrintInput = input(), blocks: TimesheetPrintBlocks = allBlocks, settings: TimesheetPrintSettings = {}): string {
  const section = buildTimesheetPrintSections(inp, fonts, 'full', blocks, resolveTimesheetPrintInk(settings)).find((s) => s.id === 'grid');
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

  it('печатает ФИО жирным — тонкое начертание принтер почти не тянет', () => {
    expect(gridHtml()).toMatch(/font-size:\d+px;font-weight:700">Асхатов Р\.З\./);
  });
});

describe('печатная форма табеля — дробные часы', () => {
  const halfDay = (hours: number) =>
    input({
      rows: [{ id: 'r1', fullName: 'Асхатов Рамиль Зулкафирович' }],
      getCell: (_rowId, day) => (day === 3 ? { code: 'Я', hours, comment: null } : { code: null, hours: null, comment: null }),
    });

  it('половинки печатаются через запятую', () => {
    expect(gridHtml(halfDay(9.5))).toContain('>9,5<');
    expect(gridHtml(halfDay(9.5))).not.toContain('>9.5<');
  });

  it('длинное число печатается мельче — но только когда перестаёт влезать в колонку', () => {
    const sizeOf = (html: string, text: string) => Number(/font-size:(\d+)px;font-weight:800/.exec(html.slice(html.indexOf(`>${text}<`) - 90))?.[1]);
    // При дефолтном кегле «9,5» помещается — мельчить незачем; «11,5» упирается в край колонки
    // и ужимается на считаные пиксели, а не в полтора раза.
    expect(sizeOf(gridHtml(halfDay(9.5)), '9,5')).toBe(fonts.cell);
    expect(sizeOf(gridHtml(halfDay(11.5)), '11,5')).toBeGreaterThanOrEqual(fonts.cell - 2);
    // При крупном кегле — уменьшается, чтобы колонка осталась прежней ширины.
    const bigFonts = { ...fonts, cell: 18 };
    const html = buildTimesheetPrintSections(halfDay(11.5), bigFonts, 'full', allBlocks, defaultInk).find((x) => x.id === 'grid')?.html ?? '';
    expect(sizeOf(html, '11,5')).toBeLessThan(18);
    expect(sizeOf(html, '11,5')).toBeGreaterThanOrEqual(6);
  });

  it('в итог за строку дробные часы попадают полностью', () => {
    // 9,5 в один день — итог строки 9,5, а не 9 и не 10.
    expect(gridHtml(halfDay(9.5))).toContain('>9,5</td>');
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
    expect(html).toContain(`background:${defaultInk.weekendBg}`);
    // Светлая экранная заливка на бумагу больше не идёт.
    expect(html).not.toContain('#f1f5f9');
  });

  it('рабочие дни не заливает: при 6-дневке суббота становится рабочей', () => {
    const five = gridHtml();
    const six = gridHtml(input({ weekMode: 6 }));
    const count = (s: string) => s.split(`background:${defaultInk.weekendBg}`).length - 1;
    // Август 2026: 5 суббот и 5 воскресений → 10 выходных при 5-дневке, 5 при 6-дневке (на строку).
    expect(count(five)).toBeGreaterThan(count(six));
    expect(count(six)).toBe(5 * 2);
  });

  it('градация черноты доходит до почти чёрного, и цифры на ней становятся белыми', () => {
    const dark = resolveTimesheetPrintInk({ weekendInk: 10 });
    const html = gridHtml(input(), allBlocks, { weekendInk: 10 });
    expect(html).toContain(`background:${dark.weekendBg}`);
    expect(html).toContain(`color:${dark.weekendText}`);
    expect(dark.weekendText).toBe('#ffffff');
  });

  it('нулевая чернота убирает заливку совсем', () => {
    expect(gridHtml(input(), allBlocks, { weekendInk: 0 })).not.toContain('background:');
  });

  it('толщина линий сетки берётся из настроек', () => {
    expect(timesheetPrintCss(resolveTimesheetPrintInk({ lineWidth: 3 }))).toContain('border: 3px solid');
    expect(timesheetPrintCss(resolveTimesheetPrintInk({}))).toContain('border: 1px solid');
  });
});

describe('печатная форма табеля — блоки', () => {
  it('снятая галочка убирает блок с листа', () => {
    const ids = buildTimesheetPrintSections(input(), fonts, 'full', { header: false, grid: true, legend: false, decode: false }, defaultInk).map((s) => s.id);
    expect(ids).toEqual(['grid']);
  });

  it('половинки месяца режут колонки дней', () => {
    const first = buildTimesheetPrintSections(input(), fonts, 'first', allBlocks, defaultInk).find((s) => s.id === 'grid')?.html ?? '';
    const second = buildTimesheetPrintSections(input(), fonts, 'second', allBlocks, defaultInk).find((s) => s.id === 'grid')?.html ?? '';
    expect(first).toContain('>15<');
    expect(first).not.toContain('>16<');
    expect(second).toContain('>16<');
    expect(second).toContain('>31<');
  });
});
