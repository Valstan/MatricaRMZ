import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REPORT_PRESET_ALIASES, REPORT_PRESET_DEFINITIONS, REPORT_PRESET_THEMES, resolveReportPresetId } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { LIST_REPORT_PAGES } from './listReportPages.js';

// Отчёт «Двигатели» переведён в уклад списка (B3 программы осень-2026). Рвётся молча в тех же
// местах, что и «Этапы на заводе»: пресет есть, страница не зарегистрирована; старые ярлыки
// (`engines_list`, `engines_contracts_overview`) перестали резолвиться; сервис снова пробует
// строить отчёт по старому пути; отчёт нечаянно сужен до двигателей на заводе.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./EnginesReportPage.tsx');
const DISPATCH = src('../../../../../main/services/reports/dispatch.ts');

describe('отчёт-список «Двигатели»', () => {
  it('пресет объявлен списком, приписан к темам и зарегистрирован страницей', () => {
    const preset = REPORT_PRESET_DEFINITIONS.find((p) => p.id === 'engines');
    expect(preset?.presentation).toBe('list');
    expect(preset?.filters).toEqual([]);
    expect(preset?.columns).toEqual([]);
    expect(REPORT_PRESET_THEMES.engines).toContain('engines');
    expect(LIST_REPORT_PAGES.engines).toBeDefined();
  });

  it('старые ярлыки и история открывают его по прежним id', () => {
    expect(REPORT_PRESET_ALIASES.engines_list).toBe('engines');
    expect(REPORT_PRESET_ALIASES.engines_contracts_overview).toBe('engines');
    expect(resolveReportPresetId('engines_list')).toBe('engines');
    expect(resolveReportPresetId('engines_contracts_overview')).toBe('engines');
  });

  it('сервис отчёт не строит — ни по новому id, ни по алиасам', () => {
    expect(DISPATCH).toContain("case 'engines':");
    expect(DISPATCH).toContain("case 'engines_list':");
    expect(DISPATCH).toContain("case 'engines_contracts_overview':");
    expect(DISPATCH).not.toContain('buildEnginesReport');
    expect(DISPATCH).not.toContain('buildEnginesListReport');
    expect(DISPATCH).not.toContain('buildEnginesContractsOverviewReport');
  });

  it('строки — весь каталог, состояние и срок считает домен, ступени — полный набор списка двигателей', () => {
    expect(PAGE, 'универсальный отчёт: без isEngineAtPlant').not.toContain('isEngineAtPlant');
    expect(PAGE).toContain('props.engines.map((e) =>');
    expect(PAGE).toContain('engineStateLabel(e)');
    expect(PAGE).toContain('engineDaysOnSite(e, now)');
    expect(PAGE).toContain('engineFacets(types) as readonly FacetDescriptor<Row>[]');
  });

  it('страница — на общей обвязке списка: колонки, счётчик, «№», группировка, печать с заголовками', () => {
    expect(PAGE).toContain('<FacetFilter<Row>');
    expect(PAGE).toContain("useColumnLayout(\n    'report:engines:columns'");
    expect(PAGE).toContain('<ListCount');
    expect(PAGE).toContain('<RowNumberHeaderCell');
    expect(PAGE).toContain('flattenGrouped(sorted, levels)');
    expect(PAGE, 'заголовок группы без номера').toContain("it.kind === 'group' ? null : it.number");
    expect(PAGE).toContain('data-report-group-by');
    expect(PAGE).toContain('rowGroupLabel={(r) => groupLabelByRow.get(r.id) || null}');
    expect(PAGE, 'щелчок по строке — карточка двигателя').toContain('onClick: () => props.onOpenEngine(it.row.id)');
    for (const g of ["case 'contract':", "case 'brand':", "case 'customer':", "case 'customer_contract':"]) expect(PAGE).toContain(g);
  });
});
