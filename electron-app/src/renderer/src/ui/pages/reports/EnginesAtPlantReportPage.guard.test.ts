import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REPORT_PRESET_DEFINITIONS, REPORT_PRESET_THEMES } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { LIST_REPORT_PAGES } from './listReportPages.js';

// Отчёт «Двигатели на заводе» (заявка владельца 07.10.2026) — обстановка по заводу:
// только двигатели на заводе, разрезы — по этапу / заказчику / дате прихода /
// дням на заводе / утилю. Рвётся молча в тех же местах, что его родственник
// «Двигатели на заводе: этапы ремонта»: пресет без страницы, страница без каталога
// двигателей, печать без заголовков групп.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./EnginesAtPlantReportPage.tsx');
const PRESET_PAGE = src('../ReportPresetPage.tsx');
const DISPATCH = src('../../../../../main/services/reports/dispatch.ts');

describe('отчёт-список «двигатели на заводе»', () => {
  it('пресет объявлен списком, приписан к теме и зарегистрирован страницей', () => {
    const preset = REPORT_PRESET_DEFINITIONS.find((p) => p.id === 'engines_at_plant');
    expect(preset?.title).toBe('Двигатели на заводе');
    expect(preset?.presentation).toBe('list');
    expect(preset?.filters).toEqual([]);
    expect(preset?.columns).toEqual([]);
    expect(REPORT_PRESET_THEMES.engines_at_plant).toContain('engines');
    expect(LIST_REPORT_PAGES.engines_at_plant).toBeDefined();
  });

  it('сервис отчёт не строит — только экран (как у остальных списков)', () => {
    expect(DISPATCH).toContain("case 'engines_at_plant':");
    expect(PRESET_PAGE).toContain('const ListPage = LIST_REPORT_PAGES[');
  });

  it('страница — на общей обвязке списка: ступени, колонки, счётчик, «№», группировка, печать с заголовками', () => {
    expect(PAGE).toContain('<FacetFilter<Row>');
    expect(PAGE).toContain("useColumnLayout(\n    'report:enginesAtPlant:columns'");
    expect(PAGE).toContain('<ListCount');
    expect(PAGE).toContain('<RowNumberHeaderCell');
    expect(PAGE).toContain('flattenGrouped(sorted, levels)');
    expect(PAGE, 'заголовок группы без номера').toContain("it.kind === 'group' ? null : it.number");
    expect(PAGE).toContain('data-report-group-by');
    expect(PAGE).toContain('rowGroupLabel={(r) => groupLabelByRow.get(r.id) || null}');
    expect(PAGE, 'только двигатели на заводе').toContain('props.engines.filter(isEngineAtPlant)');
    expect(PAGE, 'этап считает домен, не страница').toContain('engineFactoryStage(e, types, stageTemplates)');
    expect(PAGE, 'щелчок по строке — карточка двигателя').toContain('onClick: () => props.onOpenEngine(it.row.id)');
    expect(PAGE, 'отступ вложенной группы — span, не paddingLeft у td (!important в global.css)').toContain('data-report-group-depth={it.depth}');
  });

  it('разрезы владельца на месте: этап, заказчик, дата прихода, дни на заводе, утиль', () => {
    for (const label of ['По этапу', 'По заказчику', 'По дате прихода', 'По дням на заводе', 'По утилю', 'Без группировки']) {
      expect(PAGE, `нет разреза «${label}»`).toContain(label);
    }
    expect(PAGE, 'группировка по месяцу прихода не заведена').toContain('arrivalMonthGroup(r.arrivalDate)');
    expect(PAGE, 'группировка по дням не заведена').toContain('daysOnSiteGroup(r.daysOnSite)');
    expect(PAGE, 'группировка по утилю не заведена').toContain('plantScrapGroup(r.isScrap === true)');
  });

  it('колонки обстановки: дни на заводе и утиль видны, договор — тоже сразу', () => {
    expect(PAGE).toContain("{ id: 'daysOnSite', label: 'Дней на заводе'");
    expect(PAGE).toContain("{ id: 'scrap', label: 'Утиль'");
    // Владелец 07.10.2026: «Договор» виден сразу всем без включения — фильтр по договору
    // («сколько движков по договору и в каком статусе») не должен требовать настройки колонок.
    expect(PAGE, 'договор снова спрятан — оператор его не увидит').toContain("const REPORT_HIDDEN_BY_DEFAULT = ['state'];");
  });

  it('ступени — те же смыслы, что в списке двигателей; этапы выбираются для показа', () => {
    // Владелец 07.10.2026: ступень «Последний этап» убрана везде — она берёт одну последнюю
    // строку этапов и рядом с «Этапом на заводе» читалась вторым ответом на тот же вопрос.
    const facetIds = PAGE.match(/const FACET_IDS = \[([^\]]*)\]/)?.[1] ?? '';
    expect(facetIds, 'ступень «Последний этап» вернулась — путаница с «Этапом на заводе» тоже').not.toContain('lastStage');
    expect(facetIds).toContain("'factoryStage'");
    expect(facetIds, 'ступень «Есть этап» потеряна — отбор по прохождению этапов не сделать').toContain("'hasStage'");
    expect(PAGE).toContain("'scrap'");
  });
});
