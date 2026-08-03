import { describe, expect, it } from 'vitest';

import {
  TIMESHEET_PRINT_FONT_DEFAULTS,
  TIMESHEET_PRINT_PAGE_PX,
  TIMESHEET_PRINT_ROW_HEIGHT_MAX_PX,
  timesheetPrintRowHeightPx,
} from './timesheet.js';

const fonts = TIMESHEET_PRINT_FONT_DEFAULTS;

describe('timesheetPrintRowHeightPx', () => {
  it('отдаёт немногим сотрудникам максимально крупные клетки (под запись ручкой)', () => {
    const h = timesheetPrintRowHeightPx({ rowCount: 4, fonts, withHeader: true, legendLines: 1 });
    expect(h).toBe(TIMESHEET_PRINT_ROW_HEIGHT_MAX_PX);
  });

  it('на большом цехе сжимает строку, но не ниже натуральной высоты шрифта ячейки', () => {
    const natural = Math.round(fonts.cell * 1.25 + 4);
    const h = timesheetPrintRowHeightPx({ rowCount: 200, fonts, withHeader: true, legendLines: 2 });
    expect(h).toBe(natural);
  });

  it('таблица не выходит за лист: строки × высота помещаются в высоту листа', () => {
    for (const rowCount of [8, 12, 20, 30]) {
      const h = timesheetPrintRowHeightPx({ rowCount, fonts, withHeader: true, legendLines: 1 });
      expect(rowCount * h).toBeLessThanOrEqual(TIMESHEET_PRINT_PAGE_PX.height);
    }
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
