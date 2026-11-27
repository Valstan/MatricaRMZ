import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REPORT_PRESET_DEFINITIONS, REPORT_PRESET_THEMES, engineFacets, resolveReportPresetId } from '@matricarmz/shared';
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
const LIST_PAGES = src('./listReportPages.ts');
const DISPATCH = src('../../../../../main/services/reports/dispatch.ts');
const SHARED_FACETS = src('../../../../../../../shared/src/domain/engineListFacets.ts');

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

  // P9 (19.10.2026): отчёт открывают и кнопкой из «Этапов ремонта» — тогда возврат
  // называется по месту («К этапам ремонта»); из меню и каталога остаётся прежнее.
  it('возврат называет место: из этапов — к этапам, из меню — к каталогу', () => {
    expect(LIST_PAGES, 'подписи возврата нет в рамке отчётов-списков').toContain('backLabel?: string;');
    expect(PAGE).toContain("props.backLabel ?? 'К списку Отчётов'");
    expect(PRESET_PAGE, 'подпись возврата не доходит до страницы-списка').toContain('{...(props.backLabel ? { backLabel: props.backLabel } : {})}');
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
    // Промт КАРМАНА #181: в отчёте этап ремонта — одна ступень «Этап ремонта». Ступени
    // «История» в отчёте больше нет: она несла тот же список этапов, и в выпадающем списке
    // этап выводился дважды — второй раз нерабочим нулём.
    expect(facetIds, 'ступень «История» вернулась — этап снова задвоится в списке').not.toContain("'hasStage'");
    expect(facetIds).toContain("'repairStage'");
    expect(PAGE).toContain("'scrap'");
    expect(PAGE, 'ступень «Дата приёмки рекламации» потеряна').toContain("'reclamationAccepted'");
  });

  it('ряд этапов в отчёте один: «Текущее состояние» этапов не предлагает (промт КАРМАНА #181)', () => {
    // Сторож стоит на СВОЙСТВЕ: этап ремонта не должен попадать в ряд «Текущего состояния»
    // (вместе с видами работ и состояниями карточки) — иначе он снова выведется рядом с
    // «Этапом ремонта», то есть дважды.
    expect(SHARED_FACETS, 'в «Текущем состоянии» снова появились этапы ремонта').toContain("if (s.key.startsWith('stage:')) return NO_VALUE;");
    expect(SHARED_FACETS).toContain("id: 'repairStage',");
    expect(SHARED_FACETS).toContain("label: 'Этап ремонта',");
  });

  it('этапы предлагает РОВНО одна ступень отчёта — задвоения в выпадающем списке нет', () => {
    // Поведенческая проверка, а не сверка строки исходника: берём настоящий ряд ступеней
    // из домена и считаем, сколько из них предлагают значения этапов. Их должен быть
    // ровно один — иначе в выпадающем списке один и тот же этап появится дважды
    // (жалоба владельца: «этапы задвоены»).
    const raw = PAGE.match(/const FACET_IDS = \[([^\]]*)\]/)?.[1] ?? '';
    const facetIds = (raw.match(/'[^']+'/g) ?? []).map((s) => s.slice(1, -1));
    const all = engineFacets(undefined, undefined, {});
    const stageSteps = facetIds.filter((id) => {
      const facet = all.find((f) => f.id === id);
      if (!facet || facet.kind !== 'values') return false;
      return (facet.options ?? []).some((o) => o.value.startsWith('stage:') || o.value.startsWith('repair:'));
    });
    expect(stageSteps, 'этапы предлагают несколько ступеней — в списке они задвоятся').toEqual(['repairStage']);
  });

  it('отбор по этапу в отчёте раскрывает строки-проходы и берёт этап САМОЙ строки', () => {
    // Прежний отбор по этапу («История») давал строки-проходы выбранного этапа. Ступень
    // «Этап ремонта» должна давать тот же результат: раскрыть отчёт в проходы и отбирать
    // их по своему этапу, а не по последнему этапу двигателя.
    expect(PAGE, 'отчёт не читает выбранные этапы ремонта').toContain('repairStageCodesFromSelection(');
    expect(PAGE, 'срез по этапу потерян — двигатель без проходов не показывается').toContain('rowStageCode: code,');
    expect(PAGE, 'строка-проход снова несёт все этапы двигателя — срез неточный').toContain('stageCodes: [entry.code]');
    expect(PAGE, 'у прохода нет своего этапа — ступень «Этап ремонта» отбирала бы по последнему этапу двигателя').toContain('rowStageCode: entry.code');
    expect(PAGE).toContain('stageDates: { [entry.code]: entry.at }');
    // Раскрытие — вопрос не про движение.
    expect(PAGE).toContain('isStageEntriesActive(');
    expect(PAGE, 'ступень периода осталась в ряду при активном «Текущем состоянии»').toContain(
      "whereNowActive ? FACET_IDS.filter((id) => id !== 'stageDate') : FACET_IDS",
    );
    expect(PAGE, 'скрытый период продолжает отбирать втихую').toContain('stripStageDateWhenWhereNow(');
  });

  it('отбор по этапу в отчёте раскрывает ленту проходов — как прежняя ступень «История»', () => {
    // Критерий приёмки #181: выбор этапа в отчёте отбирает двигателей, ПРОХОДИВШИХ этот
    // этап (как прежняя ступень «История»), а не «двигателей, которые сейчас на этом этапе».
    // Для этого отчёт раскрывается в строки-проходы, и каждая несёт свой этап.
    expect(PAGE, 'выбор этапа не раскрывает ленту проходов — отбор по этапу изменился').toContain(
      'const expand = !whereNowActive && (entriesActive || pickedCodes.length > 0);',
    );
    expect(PAGE).toContain(
      'const pickedCodes = repairStageCodesFromSelection((activeFacets as EngineFacetSelection).repairStage);',
    );
    expect(PAGE, 'при активном «Текущем состоянии» ленты быть не должно').toContain('!whereNowActive &&');
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
