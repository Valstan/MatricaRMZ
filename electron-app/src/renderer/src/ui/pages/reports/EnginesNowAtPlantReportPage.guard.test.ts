import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REPORT_PRESET_DEFINITIONS, REPORT_PRESET_THEMES, resolveReportPresetId } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { LIST_REPORT_PAGES } from './listReportPages.js';

// Отчёт «Сейчас на заводе» (владелец 14.10.2026) — обстановка по заводу, поглотил прежние
// «Двигатели на заводе» и «Двигатели на заводе: этапы ремонта». Рвётся молча в тех же
// местах, что родственники: пресет без страницы, страница без каталога двигателей,
// печать без заголовков групп, старый id без алиаса.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./EnginesNowAtPlantReportPage.tsx');
const PRESET_PAGE = src('../ReportPresetPage.tsx');
const DISPATCH = src('../../../../../main/services/reports/dispatch.ts');

describe('отчёт-список «сейчас на заводе»', () => {
  it('пресет объявлен списком, приписан к теме и зарегистрирован страницей', () => {
    const preset = REPORT_PRESET_DEFINITIONS.find((p) => p.id === 'engines_now_at_plant');
    expect(preset?.title).toBe('Сейчас на заводе');
    expect(preset?.presentation).toBe('list');
    expect(preset?.filters).toEqual([]);
    expect(preset?.columns).toEqual([]);
    expect(REPORT_PRESET_THEMES.engines_now_at_plant).toContain('engines');
    expect(LIST_REPORT_PAGES.engines_now_at_plant).toBeDefined();
  });

  it('старые id остались алиасами на ту же страницу — ярлыки и история живут', () => {
    expect(resolveReportPresetId('engine_factory_stages')).toBe('engines_now_at_plant');
    expect(resolveReportPresetId('engines_at_plant')).toBe('engines_now_at_plant');
    expect(LIST_REPORT_PAGES.engine_factory_stages).toBe(LIST_REPORT_PAGES.engines_now_at_plant);
    expect(LIST_REPORT_PAGES.engines_at_plant).toBe(LIST_REPORT_PAGES.engines_now_at_plant);
    // Каталог показывает только новый: старых дефиниций в реестре нет.
    const catalogIds = REPORT_PRESET_DEFINITIONS.map((p) => String(p.id));
    expect(catalogIds.includes('engine_factory_stages')).toBe(false);
    expect(catalogIds.includes('engines_at_plant')).toBe(false);
  });

  it('каждый пресет с presentation=list имеет страницу, и наоборот (алиасы не в счёт)', () => {
    const listPresets = REPORT_PRESET_DEFINITIONS.filter((p) => p.presentation === 'list').map((p) => p.id).sort();
    const pages = Object.keys(LIST_REPORT_PAGES).filter((id) => resolveReportPresetId(id) === id).sort();
    expect(pages).toEqual(listPresets);
  });

  it('сервис отчёт не строит — только экран (как у остальных списков)', () => {
    expect(DISPATCH).toContain("case 'engines_now_at_plant':");
    expect(PRESET_PAGE).toContain('const ListPage = LIST_REPORT_PAGES[');
  });

  it('страница — на общей обвязке списка: ступени, колонки, счётчик, «№», группировка, печать с заголовками', () => {
    expect(PAGE).toContain('<FacetFilter<Row>');
    expect(PAGE).toContain("useColumnLayout(\n    'report:enginesNowAtPlant:columns'");
    expect(PAGE).toContain('<ListCount');
    expect(PAGE).toContain('<RowNumberHeaderCell');
    expect(PAGE).toContain('flattenGrouped(sorted, levels)');
    expect(PAGE, 'заголовок группы без номера').toContain("it.kind === 'group' ? null : it.number");
    expect(PAGE).toContain('data-report-group-by');
    expect(PAGE).toContain('rowGroupLabel={(r) => groupLabelByRow.get(r.id) || null}');
    expect(PAGE, 'только двигатели на заводе').toContain('.filter(isEngineAtPlant)');
    expect(PAGE, 'этап считает домен, не страница').toContain('engineFactoryStage(withName, types, stageTemplates)');
    expect(PAGE, 'щелчок по строке — карточка двигателя').toContain('onClick: () => props.onOpenEngine(it.row.id)');
    expect(PAGE, 'отступ вложенной группы — span, не paddingLeft у td (!important в global.css)').toContain('data-report-group-depth={it.depth}');
  });

  it('все разрезы на месте: этап, заказчик, заказчик → этап, приход, дни, утиль', () => {
    for (const label of ['По этапу', 'По заказчику', 'Заказчик → этап', 'По дате прихода', 'По дням на заводе', 'По утилю', 'Без группировки']) {
      expect(PAGE, `нет разреза «${label}»`).toContain(label);
    }
    expect(PAGE, 'группировка по месяцу прихода не заведена').toContain('arrivalMonthGroup(r.arrivalDate)');
    expect(PAGE, 'группировка по дням не заведена').toContain('daysOnSiteGroup(r.daysOnSite)');
    expect(PAGE, 'группировка по утилю не заведена').toContain('plantScrapGroup(r.isScrap === true)');
  });

  it('колонки обстановки: «Где сейчас?», дни на заводе, утиль, состояние, договор', () => {
    expect(PAGE).toContain("label: 'Где сейчас?'");
    expect(PAGE).toContain("{ id: 'daysOnSite', label: 'Дней на заводе'");
    expect(PAGE).toContain("{ id: 'scrap', label: 'Утиль'");
    expect(PAGE, 'метка «Рекламация» потеряна — признак виден только ступенью').toContain("id: 'reclamation'");
    expect(PAGE).toContain("{ id: 'state', label: 'Состояние'");
    expect(PAGE).toContain("{ id: 'stageAt', label: 'Дата операции'");
    expect(PAGE, 'колонка и ступень снова меряют разное под одним именем').not.toContain("label: 'Дата этапа'");
  });

  it('ступени — те же смыслы, что в списке двигателей; этапы выбираются для показа', () => {
    const facetIds = PAGE.match(/const FACET_IDS = \[([^\]]*)\]/)?.[1] ?? '';
    expect(facetIds, 'ступень «Последний этап» вернулась — путаница с «Текущим состоянием» тоже').not.toContain('lastStage');
    expect(facetIds).toContain("'factoryStage'");
    expect(facetIds, 'ступень «История» потеряна — отбор по прохождению этапов не сделать').toContain("'hasStage'");
    expect(PAGE).toContain("'scrap'");
    expect(PAGE, 'ступень «Дата приёмки рекламации» потеряна').toContain("'reclamationAccepted'");
  });

  it('точные срезы «Истории»; «Текущее состояние» гасит период (владелец 14.10.2026)', () => {
    expect(PAGE, 'строка-проход снова несёт все этапы двигателя — срез неточный').toContain('stageCodes: [entry.code]');
    expect(PAGE).toContain('stageDates: { [entry.code]: entry.at }');
    // Без проходов в едином списке (старая история) двигатель с пройденным этапом
    // показывается строкой НА ВЫБРАННЫЙ этап, а не с текущим местом.
    expect(PAGE, 'срез снова показывает чужое текущее место вместо выбранного этапа').toContain('stageCodes: [code], // для фасета hasStage — точный срез');
    expect(PAGE, 'раскрытие строится вопросом не про движение').toContain('isStageEntriesActive(');
    expect(PAGE, 'ступень периода осталась в ряду при активном «Текущем состоянии»').toContain(
      "whereNowActive ? FACET_IDS.filter((id) => id !== 'stageDate') : FACET_IDS",
    );
    expect(PAGE, 'скрытый период продолжает отбирать втихую').toContain('stripStageDateWhenWhereNow(');
  });

  it('колонки-дублей нет: «Последнее событие», «Дата события», «Последний этап»', () => {
    expect(PAGE).not.toContain('Последнее событие');
    expect(PAGE).not.toContain('Дата события');
    expect(PAGE, 'колонка «Последний этап» вернулась — два ответа на один вопрос').not.toContain("label: 'Последний этап'");
    expect(PAGE, 'колонка с id снятой ступени вернулась').not.toContain("id: 'lastStage'");
  });

  it('цех резолвится тем же справочником, что список двигателей — иначе колонка пустая', () => {
    expect(PAGE, 'отчёт не резолвит цеха — колонка снова пустая').toContain('useWorkshopNames()');
    expect(PAGE).toContain('resolveWorkshopName(workshopNameById, e.workshopId, e.workshopName)');
  });
});
