import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CUSTOM_REPORT_SOURCE_PRESET_IDS, REPORT_PRESET_DEFINITIONS, REPORT_PRESET_THEMES } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { LIST_REPORT_PAGES } from './listReportPages.js';

// Отчёт «Этапы работ» переведён в уклад списка (B5 программы осень-2026). Особенность: его
// builder в main-процессе ЖИВ — он источник конструктора отчётов, — поэтому сторож держит обе
// стороны: каталог открывает список, конструктор по-прежнему получает строки от сервиса.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./WorkSheetsReportPage.tsx');
const DISPATCH = src('../../../../../main/services/reports/dispatch.ts');
const BUILDER = src('../../../../../main/services/reports/presets/workSheets.ts');

describe('отчёт-список «Этапы работ»', () => {
  it('пресет объявлен списком, приписан к теме и зарегистрирован страницей', () => {
    const preset = REPORT_PRESET_DEFINITIONS.find((p) => p.id === 'work_sheets');
    expect(preset?.presentation).toBe('list');
    expect(preset?.filters).toEqual([]);
    expect(preset?.columns).toEqual([]);
    expect(REPORT_PRESET_THEMES.work_sheets?.length).toBeGreaterThan(0);
    expect(LIST_REPORT_PAGES.work_sheets).toBeDefined();
  });

  it('конструктор отчётов по-прежнему берёт строки у сервиса: builder жив и несёт свои колонки', () => {
    expect(CUSTOM_REPORT_SOURCE_PRESET_IDS).toContain('work_sheets');
    expect(DISPATCH).toContain("case 'work_sheets':\n        return buildWorkSheetsReport(db, args.filters, ctx);");
    expect(BUILDER, 'колонки пресета пусты — базовые колонки источника живут в builder').toContain('const WORK_SHEETS_SOURCE_COLUMNS: ReportColumn[]');
    expect(BUILDER).not.toContain('preset.columns');
  });

  it('строки читаются тем же мостом, что и экран, за всё время, и подхватывают живые изменения', () => {
    expect(PAGE).toContain('window.matrica.workSheets.rows.list({ sinceMs: null })');
    expect(PAGE).toContain('useLiveDataRefresh(refreshRows)');
    expect(PAGE, 'поля видов работ — по справочнику, объединением').toContain('unionWorkSheetColumns(res.rows)');
    expect(PAGE).toContain('workSheetFacets(fieldColumns)');
  });

  it('страница — на общей обвязке списка: колонки, счётчик, «№», группировка с итогами, печать с заголовками', () => {
    expect(PAGE).toContain('<FacetFilter<WorkSheetRow>');
    expect(PAGE).toContain("useColumnLayout(\n    'report:workSheets:columns'");
    expect(PAGE).toContain('<ListCount');
    expect(PAGE).toContain('<RowNumberHeaderCell');
    expect(PAGE).toContain('flattenGrouped(sorted, levels)');
    expect(PAGE, 'заголовок группы без номера').toContain("it.kind === 'group' ? null : it.number");
    expect(PAGE, 'итог группы — в её заголовке').toContain('· {it.count}');
    expect(PAGE).toContain('data-report-group-by');
    expect(PAGE).toContain('rowGroupLabel={(r) => groupLabelByRow.get(r.id) || null}');
    expect(PAGE, 'щелчок по строке — карточка двигателя').toContain('onClick: () => props.onOpenEngine(it.row.engineId)');
    for (const g of ["case 'type':", "case 'contract':", "case 'workshop':", "case 'customer':", "case 'customer_type':"]) expect(PAGE).toContain(g);
  });
});
