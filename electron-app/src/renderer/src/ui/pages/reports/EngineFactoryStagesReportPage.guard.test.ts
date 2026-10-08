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
    expect(PAGE, 'этап считает домен, не страница').toContain('engineFactoryStage(e, types, stageTemplates)');
    expect(PAGE, 'щелчок по строке — карточка двигателя').toContain('onClick: () => props.onOpenEngine(it.row.id)');
    expect(PAGE, 'отступ вложенной группы — span, не paddingLeft у td (!important в global.css)').toContain('data-report-group-depth={it.depth}');
  });

  // Этап на заводе считается по последнему этапу работ, а каталог двигателей App перечитывался
  // только при заходе на «Двигатели»: сохранённый этап работ не менял отчёт (стенд, 15.09.2026).
  // Шаг 8 плана unified-repair-stages: список этапов работ — read-only сводка, записи из него
  // убраны вместе с инлайн-редактором. Писать там нечему — и оповещать нечего: вернулась бы
  // запись, dispatch обязан вернуться вместе с ней, иначе отчёт молчит о вчерашней стадии.
  it('список read-only не пишет и не оповещает; пишут карточки — и они будят каталог', () => {
    const SHEETS = src('../WorkSheetsPage.tsx');
    const CARD = src('../WorkSheetDetailsPage.tsx');
    const HISTORY = src('../../components/EngineHistoryFeedPanel.tsx');
    const ENGINE_PAGE = src('../EngineDetailsPage.tsx');
    expect(APP).toContain("window.addEventListener('matrica:engines-changed', onEnginesChanged);");
    expect(SHEETS, 'список не пишет этапы').not.toMatch(/stages\.(save|delete)/);
    expect(
      SHEETS.split("window.dispatchEvent(new Event('matrica:engines-changed'));").length - 1,
      'список: писать нечему — dispatch не должно быть',
    ).toBe(0);
    expect(CARD.split("window.dispatchEvent(new Event('matrica:engines-changed'));").length - 1, 'карточка: после сохранения и после удаления').toBe(2);
    // Главный путь записи этапов — секция в карточке двигателя: её onChanged доходит до App.
    expect(HISTORY, 'этапы пишутся из ленты истории').toContain('window.matrica.workSheets.stages.save(');
    expect(HISTORY, 'onChanged ленты пробрасывается наружу').toContain('props.onChanged?.()');
    expect(ENGINE_PAGE, 'панель истории будит каталог двигателей').toContain('void props.onEngineUpdated();');
    expect(ENGINE_PAGE, 'панель истории освежает место двигателя в карточке').toContain('void reloadLastStage();');
  });
});

describe('PR5: строка «Возвраты» (проход ≥ 2, решение владельца 05.10.2026)', () => {
  it('колонка «Этап на заводе» показывает этап с суффиксом возврата, а не название группы', () => {
    // У строки «Возвраты» `label` занят группой. Без `stageLabel` весь раздел отчёта
    // выглядел бы одинаково — и колонка перестала бы отвечать на свой вопрос.
    // Суффикс «· возврат» — решение владельца 09.10.2026 (раскатка пилота #1195);
    // поведение держит `formatEngineFactoryStageLabel`, здесь только проводка.
    expect(PAGE, 'колонка отдаёт название группы вместо этапа — раздел «Возвраты» не читается').toContain(
      'formatEngineFactoryStageLabel(e.stage)',
    );
    expect(PAGE, 'группировка по-прежнему по stage.key — иначе возвраты не соберутся в раздел').toContain(
      'keyOf: (r) => ({ key: r.stage.key, label: r.stage.label, rank: r.stage.rank })',
    );
  });

  it('поиск по отчёту находит двигатель и по названию этапа, и по «Возвраты»', () => {
    expect(PAGE, 'в индекс поиска не входит этап строки — по названию этапа возврат не найдётся').toContain(
      "r.stage.stageLabel ?? ''",
    );
  });

  it('все отчёты двигателей ведут себя так же — иначе три списка показывают разное', () => {
    const ENGINES = src('./EnginesReportPage.tsx');
    const AT_PLANT = src('./EnginesAtPlantReportPage.tsx');
    for (const [name, text] of [['Двигатели', ENGINES] as const, ['на заводе', AT_PLANT] as const]) {
      expect(text, `в отчёте «${name}» колонка отдаёт группу вместо этапа с суффиксом`).toContain(
        'formatEngineFactoryStageLabel(e.stage)',
      );
    }
  });
});

describe('PR-G: отчёт без дублей колонок + Android-синк', () => {
  it('колонки-дублей нет: «Последнее событие», «Дата события», «Последний этап»', () => {
    expect(PAGE).not.toContain('Последнее событие');
    expect(PAGE).not.toContain('Дата события');
    // Владелец 08.10.2026: колонка «Последний этап» убрана — «Этап на заводе» уже показывает,
    // где двигатель по последней записи (и учитывает больше: утиль, возвраты, акты).
    expect(PAGE, 'колонка «Последний этап» вернулась — два ответа на один вопрос').not.toContain("label: 'Последний этап'");
    expect(PAGE, 'колонка с id снятой ступени вернулась').not.toContain("id: 'lastStage'");
    expect(PAGE).toContain("label: 'Этап на заводе'");
  });

  // Владелец 08.10.2026: колонка «Дата этапа» показывала дату того события, которым двигатель
  // пришёл в группу (акт, приход, утиль — не только этап), а ступень «Дата этапа» отбирает
  // по последней строке этапов — одно имя меряло разное. Колонка зовётся «Дата операции».
  it('колонка даты зовётся «Дата операции», а не «Дата этапа»', () => {
    expect(PAGE).toContain("{ id: 'stageAt', label: 'Дата операции'");
    expect(PAGE, 'подпись колонки снова меряет одно, а читается как другое').not.toContain("label: 'Дата этапа'");
  });

  // Владелец 07.10.2026: ступень «Последний этап» снята во всех фильтрах и отчётах —
  // на панели она рядом с «Этапом на заводе» читалась вторым ответом на тот же вопрос,
  // причём молча другим (не видит ни утиль, ни возвраты, ни акты). Отбор по прохождению
  // этапов остаётся у «Есть этап», место двигателя — у «Этапа на заводе».
  it('ступени «Последний этап» в отчёте нет — снята везде (см. engineListFacets.ts)', () => {
    const facetIds = PAGE.match(/const FACET_IDS = \[([^\]]*)\]/)?.[1] ?? '';
    expect(facetIds, 'ступень вернулась — оператор снова выберет неверный отбор').not.toContain('lastStage');
    expect(facetIds).toContain("'factoryStage'");
    expect(facetIds).toContain("'hasStage'");
  });

  it('Android: интервал автосинка — 15 секунд', () => {
    const BOOT = src('../../../../../../../android-app/src/core/boot.ts');
    expect(BOOT).toContain('startAuto(15_000)');
  });
});
