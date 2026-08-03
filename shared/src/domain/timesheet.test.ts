import { describe, expect, it } from 'vitest';

import {
  formatTimesheetHours,
  resolveTimesheetPrintInk,
  timesheetCellFontPx,
  TIMESHEET_PRINT_FONT_DEFAULTS,
  TIMESHEET_PRINT_INK_DEFAULT,
  TIMESHEET_PRINT_PAGE_PX,
  TIMESHEET_PRINT_ROW_HEIGHT_MAX_PX,
  timesheetPrintRowHeightPx,
  timesheetTextWidthPx,
} from './timesheet.js';

const fonts = TIMESHEET_PRINT_FONT_DEFAULTS;

describe('timesheetPrintRowHeightPx', () => {
  it('отдаёт немногим сотрудникам максимально крупные клетки (под запись ручкой)', () => {
    const h = timesheetPrintRowHeightPx({ rowCount: 4, fonts, withHeader: true, legendLines: 1 });
    expect(h).toBe(TIMESHEET_PRINT_ROW_HEIGHT_MAX_PX);
  });

  it('на большом цехе сжимает строку, но не ниже натуральной высоты шрифта ячейки', () => {
    const natural = Math.floor(fonts.cell * 1.25 + 4);
    const h = timesheetPrintRowHeightPx({ rowCount: 200, fonts, withHeader: true, legendLines: 2 });
    expect(h).toBe(natural);
  });

  it('снятая легенда не выталкивает табель на вторую страницу', () => {
    // Регрессия 03.08: рамки строк и отступы секций не учитывались, и БЕЗ легенды строки
    // становились выше ровно настолько, чтобы лист перестал помещаться на страницу.
    for (const rowCount of [8, 15, 22, 28]) {
      for (const legendLines of [0, 1, 2]) {
        const line = 1;
        const h = timesheetPrintRowHeightPx({ rowCount, fonts, withHeader: true, legendLines, lineWidth: line });
        const headerPx = fonts.header * 1.15 + fonts.header * 0.7 * 1.2;
        const legendPx = legendLines > 0 ? fonts.legend * 1.35 * legendLines : 0;
        const theadPx = fonts.dayNum * 1.05 + fonts.weekday * 1.05 + 4;
        const gaps = (1 + 1 + (legendLines > 0 ? 1 : 0)) * 6;
        const borders = (rowCount + 2) * line;
        const total = rowCount * h + headerPx + legendPx + theadPx + gaps + borders;
        expect(total).toBeLessThanOrEqual(TIMESHEET_PRINT_PAGE_PX.height);
      }
    }
  });

  it('толстые линии съедают высоту: строка становится не выше, чем при тонких', () => {
    const thin = timesheetPrintRowHeightPx({ rowCount: 25, fonts, withHeader: true, legendLines: 1, lineWidth: 1 });
    const thick = timesheetPrintRowHeightPx({ rowCount: 25, fonts, withHeader: true, legendLines: 1, lineWidth: 3 });
    expect(thick).toBeLessThanOrEqual(thin);
  });

  it('без шапки и легенды строка не ниже, чем с ними', () => {
    const withBlocks = timesheetPrintRowHeightPx({ rowCount: 25, fonts, withHeader: true, legendLines: 2 });
    const bare = timesheetPrintRowHeightPx({ rowCount: 25, fonts, withHeader: false, legendLines: 0 });
    expect(bare).toBeGreaterThanOrEqual(withBlocks);
  });

  it('пустой табель не делит на ноль', () => {
    expect(Number.isFinite(timesheetPrintRowHeightPx({ rowCount: 0, fonts, withHeader: true, legendLines: 1 }))).toBe(true);
  });
});

describe('часы в ячейке', () => {
  // Ширина клетки дня на печатном листе при 31 колонке (см. timesheetPrintHtml).
  const DAY_CELL = (TIMESHEET_PRINT_PAGE_PX.width * 0.92) / 31 - 6;

  it('пишутся по-русски через запятую, целые — без хвоста', () => {
    expect(formatTimesheetHours(9.5)).toBe('9,5');
    expect(formatTimesheetHours(8)).toBe('8');
    expect(formatTimesheetHours(11.5)).toBe('11,5');
    expect(formatTimesheetHours(null)).toBe('');
  });

  it('пока значение помещается в колонку — кегль полный (зря не мельчим)', () => {
    expect(timesheetCellFontPx('8', 12, DAY_CELL)).toBe(12);
    expect(timesheetCellFontPx('11', 12, DAY_CELL)).toBe(12);
    expect(timesheetCellFontPx('9,5', 12, DAY_CELL)).toBe(12);
  });

  it('что в колонку не влезает — уменьшается ровно до её ширины', () => {
    const base = 18;
    const size = timesheetCellFontPx('11,5', base, DAY_CELL);
    expect(size).toBeLessThan(base);
    expect(timesheetTextWidthPx('11,5', size)).toBeLessThanOrEqual(DAY_CELL);
  });

  it('чем длиннее значение, тем мельче — при одной и той же колонке', () => {
    expect(timesheetCellFontPx('11,5', 18, DAY_CELL)).toBeLessThanOrEqual(timesheetCellFontPx('9,5', 18, DAY_CELL));
  });

  it('мельчит до читаемого предела, а не до нуля', () => {
    expect(timesheetCellFontPx('11,5', 40, 3)).toBeGreaterThanOrEqual(4);
  });
});

describe('чернота печати', () => {
  it('уровень 0 — заливки нет вовсе', () => {
    const ink = resolveTimesheetPrintInk({ weekendInk: 0 });
    expect(ink.weekendBg).toBe('transparent');
  });

  it('чем выше уровень, тем темнее заливка', () => {
    const gray = (level: number) => parseInt(resolveTimesheetPrintInk({ weekendInk: level }).weekendBg.slice(1, 3), 16);
    expect(gray(10)).toBeLessThan(gray(5));
    expect(gray(5)).toBeLessThan(gray(1));
    // Максимум — почти чёрный, но не абсолютный чёрный.
    expect(gray(10)).toBeLessThan(0x40);
    expect(gray(10)).toBeGreaterThan(0);
  });

  it('на тёмной заливке цифры печатаются белым', () => {
    expect(resolveTimesheetPrintInk({ weekendInk: 10 }).weekendText).toBe('#ffffff');
    expect(resolveTimesheetPrintInk({ weekendInk: 2 }).weekendText).toBe('#000000');
  });

  it('шапка выходной колонки темнее тела', () => {
    const ink = resolveTimesheetPrintInk({ weekendInk: 4 });
    expect(parseInt(ink.weekendHeadBg.slice(1, 3), 16)).toBeLessThan(parseInt(ink.weekendBg.slice(1, 3), 16));
  });

  it('мусор в настройках падает на умолчания и клампится', () => {
    expect(resolveTimesheetPrintInk({}).level).toBe(TIMESHEET_PRINT_INK_DEFAULT);
    expect(resolveTimesheetPrintInk({ weekendInk: 99 }).level).toBe(10);
    expect(resolveTimesheetPrintInk({ weekendInk: -5 }).level).toBe(0);
    expect(resolveTimesheetPrintInk({ lineWidth: 99 }).lineWidth).toBe(3);
    expect(resolveTimesheetPrintInk(null).lineWidth).toBe(1);
  });
});
