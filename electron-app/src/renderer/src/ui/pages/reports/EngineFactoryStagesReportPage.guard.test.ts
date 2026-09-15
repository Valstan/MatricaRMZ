import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REPORT_PRESET_DEFINITIONS, REPORT_PRESET_THEMES } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { LIST_REPORT_PAGES } from './listReportPages.js';

// Отчёт «Двигатели на заводе: этапы ремонта» (владелец 15.09.2026) — первый отчёт в укладе
// списка и рамка для остальных. Рвётся молча в трёх местах: пресет есть в реестре, а страница
// не зарегистрирована (плитка открывает пустой предпросмотр); App не отдаёт каталог двигателей
// (список пуст без ошибки); печать теряет заголовки групп.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./EngineFactoryStagesReportPage.tsx');
const PRESET_PAGE = src('../ReportPresetPage.tsx');
const APP = src('../../App.tsx');
const PRINT = src('../../components/ListPrintDialog.tsx');
const DISPATCH = src('../../../../../main/services/reports/dispatch.ts');

describe('отчёт-список «этапы на заводе» и рамка «отчёт как список»', () => {
  it('пресет объявлен списком, приписан к теме и зарегистрирован страницей', () => {
    const preset = REPORT_PRESET_DEFINITIONS.find((p) => p.id === 'engine_factory_stages');
    expect(preset?.presentation).toBe('list');
    expect(preset?.filters).toEqual([]);
    expect(preset?.columns).toEqual([]);
    expect(REPORT_PRESET_THEMES.engine_factory_stages).toContain('engines');
    expect(LIST_REPORT_PAGES.engine_factory_stages).toBeDefined();
  });

  it('каждый пресет с presentation=list имеет страницу, и наоборот', () => {
    const listPresets = REPORT_PRESET_DEFINITIONS.filter((p) => p.presentation === 'list').map((p) => p.id).sort();
    expect(Object.keys(LIST_REPORT_PAGES).sort()).toEqual(listPresets);
  });

  it('страница пресета делегирует списковым отчётам ДО пресетной механики; сервис их не строит', () => {
    expect(PRESET_PAGE).toContain("import { LIST_REPORT_PAGES } from './reports/listReportPages.js';");
    expect(PRESET_PAGE).toContain('const ListPage = LIST_REPORT_PAGES[');
    expect(PRESET_PAGE.indexOf('const ListPage = LIST_REPORT_PAGES['), 'делегирование раньше хуков состояния').toBeLessThan(PRESET_PAGE.indexOf('useState<ReportPresetDefinition[]>'));
    expect(DISPATCH).toContain("case 'engine_factory_stages':");
  });

  it('App отдаёт каталог двигателей и переход в карточку обоим местам, где рисуется страница пресета', () => {
    const sites = APP.split('<ReportPresetPage').length - 1;
    expect(sites).toBeGreaterThanOrEqual(2);
    expect(APP.split('engines={engines}').length - 1, 'engines у каждого <ReportPresetPage').toBeGreaterThanOrEqual(sites + 1); // +1 — WorkSheetsPage
    expect(APP).toMatch(/<ReportPresetPage[\s\S]{0,700}onOpenEngine=\{\(id: string\) => void openEngine\(id\)\}/);
  });

  it('страница — на общей обвязке списка: ступени, колонки, счётчик, «№», группировка, печать с заголовками', () => {
    expect(PAGE).toContain('<FacetFilter<Row>');
    expect(PAGE).toContain("useColumnLayout(\n    'report:engineFactoryStages:columns'");
    expect(PAGE).toContain('<ListCount');
    expect(PAGE).toContain('<RowNumberHeaderCell');
    expect(PAGE).toContain('flattenGrouped(sorted, levels)');
    expect(PAGE, 'заголовок группы без номера').toContain("it.kind === 'group' ? null : it.number");
    expect(PAGE).toContain('data-report-group-by');
    expect(PAGE).toContain('rowGroupLabel={(r) => groupLabelByRow.get(r.id) || null}');
    expect(PRINT).toContain('rowGroupLabel?: (row: T) => string | null;');
    expect(PAGE, 'только двигатели на заводе').toContain('props.engines.filter(isEngineAtPlant)');
    expect(PAGE, 'этап считает домен, не страница').toContain('engineFactoryStage(e, types)');
    expect(PAGE, 'щелчок по строке — карточка двигателя').toContain('onClick: () => props.onOpenEngine(it.row.id)');
  });
});
