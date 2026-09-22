import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { applyEngineFacets, engineFacetOptions, type EngineListItem } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

// Ступенчатый фильтр списка двигателей: логика чистая и покрыта своими тестами, а рвётся провод —
// список может остаться на прежнем массиве, и тогда фильтр рисуется, считает, показывает числа
// и НИЧЕГО не отбирает. Сторож держит именно цепочку «отбор → сортировка → таблица».
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = src('./EnginesPage.tsx');
// Разметка ступеней общая для двигателей и контрактов; двигательный компонент — тонкая обёртка,
// подставляющая свои ступени. Сторожим обе половины: обёртка без ступеней рисует пустую панель.
const WRAPPER = src('../components/EngineFacetFilter.tsx');
const FILTER = src('../components/FacetFilter.tsx');
const TOOLBAR = src('../components/PageToolbar.tsx');

describe('ступенчатый фильтр доезжает до строк списка', () => {
  it('таблица строится по отфильтрованному ступенями массиву', () => {
    expect(PAGE).toContain('const facetFiltered = useMemo(() => applyEngineFacets(facetRows, facets, sheetTypes)');
    expect(PAGE, 'сортировка снова берёт список до ступеней').toContain('const items = [...facetFiltered];');
    expect(PAGE).toContain("if (String(query ?? '').trim()) return facetFiltered;");
  });

  it('печать этикеток печатает то же, что видно в списке', () => {
    expect(PAGE).toContain('facetFiltered.map((e) => ({');
  });

  it('старые одиночные фильтры тулбара сняты, а их значения переезжают в ступени', () => {
    expect(PAGE, 'два фильтра об одном и том же — один из них невидим').not.toContain('<option value="">Контрагент: все</option>');
    expect(PAGE).not.toContain('<option value="all">Акт компл.: все</option>');
    expect(PAGE, 'кнопка «Рекламационные» дублировала свою же ступень').not.toContain('>\n          Рекламационные\n        </Button>');
    for (const migration of [
      "if (customerFilter && !engineFacetIsActive(base, 'customer')) out.customer = [customerFilter];",
      "if (onlyReclamation && !engineFacetIsActive(base, 'reclamation')) out.reclamation = ['yes'];",
      "if (completenessFilter !== 'all' && !engineFacetIsActive(base, 'completenessAct')) out.completenessAct = [completenessFilter];",
    ]) {
      expect(PAGE).toContain(migration);
    }
    // Полей дат прихода в тулбаре нет вовсе (владелец 08.09.2026), и сохранённая граница
    // НЕ переезжает в ступень: снять её потом было бы нечем — поля, которое её показывало,
    // на экране больше не существует.
    expect(PAGE).not.toContain('contractDateFrom');
    expect(PAGE).not.toContain('contractDateTo');
  });

  it('ступень с выбранными значениями показывается всегда', () => {
    // Иначе отбор идёт, а чем именно — на экране не видно.
    expect(PAGE).toContain('Array.from(new Set([...known, ...active]))');
  });

  it('кнопка сброса чистит ступени, их значения и все легаси-поля', () => {
    for (const cleared of ['facets: {},', 'facetFields: [],', "customerFilter: '',", 'onlyReclamation: false,', "completenessFilter: 'all',"]) {
      expect(PAGE).toContain(cleared);
    }
    expect(FILTER).toContain('data-facet-reset');
  });

  it('тулбар очищен от кнопок, чью работу делает шапка столбцов и раздел «Отчёты»', () => {
    // Владелец 08.09.2026: колонку превью убирают в шапке, а отчёт «Двигатели» живёт в
    // каталоге отчётов (пресет engines) — вторые точки входа только дублировали.
    expect(PAGE).not.toContain('Отключить превью');
    // Ищем сам вызов, а не слова: упоминание отчёта осталось в комментарии — и это правильно,
    // он объясняет, куда делась кнопка.
    expect(PAGE).not.toContain('props.onOpenReport');
    expect(PAGE, 'мёртвый механизм видимости не должен остаться в коде').not.toContain('requireShowPreviews');
  });

  it('кнопка «Фильтры» стоит в тулбаре сразу после поиска и «Похожих»', () => {
    // Владелец 08.09.2026: свёрнутая панель не должна занимать полосу — кнопка живёт рядом
    // с поиском, а панель разворачивается ниже.
    const toolbar = PAGE.slice(PAGE.indexOf('<SearchModeToggle'), PAGE.indexOf('<SearchModeToggle') + 400);
    expect(toolbar).toContain('<EngineFacetToggleButton');
    expect(FILTER).toContain('export function FacetToggleButton');
    // Поиск и его спутники не уезжают в меню переполнения: без них список неуправляем.
    expect(PAGE).toContain('<ToolbarPin>');
    expect(FILTER).toContain("{props.open ? '▾' : '▸'} Фильтры{activeCount > 0 ? ` (${activeCount})` : ''}");
  });

  it('ряд кнопок — одна строка, лишнее уезжает в меню справа', () => {
    // Владелец 08.09.2026: перенос второй строкой съедал высоту у самого списка.
    expect(PAGE, 'перенос строкой вернул бы прежнюю беду').not.toContain("flexWrap: 'wrap'");
    expect(PAGE).toContain('<PageToolbar>');
    expect(TOOLBAR).toContain("flexWrap: 'nowrap'");
    expect(TOOLBAR).toContain('data-toolbar-overflow');
    expect(TOOLBAR, 'закреплённые элементы в меню не уезжают').toContain('if (!it || measured.pinned[it.key]) continue;');
    expect(TOOLBAR, 'уехавший элемент рисуется в ОДНОМ месте, иначе диалог раздвоится').toContain(
      '.filter((it) => !hiddenKeys.has(it.key))',
    );
  });

  it('выбор колонок называется словами и живёт в тулбаре', () => {
    // Владелец 16.09.2026 вернул кнопку в тулбар: панель фильтров сворачивается, и вместе с
    // ней пропадала настройка колонок — а она нужна и при закрытом фильтре.
    expect(PAGE).toContain('label="Колонки списка"');
    const toolbar = PAGE.slice(PAGE.indexOf('<PageToolbar>'), PAGE.indexOf('</PageToolbar>'));
    expect(toolbar, 'кнопка колонок живёт в тулбаре — она нужна и при свёрнутом фильтре').toContain('<ColumnSettingsButton');
    expect(PAGE, 'в панель фильтров кнопка больше не отдаётся').not.toContain('columnsControl={');
    expect(FILTER, 'слот колонок из панели убран — иначе останется мёртвая разметка').not.toContain('data-facet-columns');
  });

  // Владелец 16.09.2026: «Сбросить фильтр» — самой первой кнопкой панели, до ступеней.
  // Свойство, а не написание: сторож сравнивает ПОРЯДОК в разметке, поэтому переживёт и
  // смену стилей, и переименование подписи, но поймает возврат кнопки в хвост ряда.
  it('«Сбросить фильтр» стоит первым в ряду — до кнопок ступеней', () => {
    const reset = FILTER.indexOf('data-facet-reset');
    const firstFacet = FILTER.indexOf('data-facet-field');
    expect(reset, 'кнопка сброса на месте').toBeGreaterThan(0);
    expect(firstFacet, 'кнопки ступеней на месте').toBeGreaterThan(0);
    expect(reset, 'выход из фильтра ищут в начале панели, а не в её хвосте').toBeLessThan(firstFacet);
  });

  it('свёрнутая панель не занимает места, а отбор продолжает работать', () => {
    expect(FILTER, 'свёрнутая панель обязана исчезать целиком').toContain('if (!props.open) return null;');
    // Отбор живёт в `selection`, а не в раскрытости панели: сворачивание фильтры не снимает.
    expect(PAGE).toContain('const facetFiltered = useMemo(() => applyEngineFacets(facetRows, facets, sheetTypes)');
    expect(PAGE).toContain('open={facetsOpen}');
  });

  it('обёртка двигателей подставляет в общий фильтр именно свои ступени — со справочником видов работ', () => {
    // Владелец 16.09.2026: «обкатки нет в фильтре» — ряд этапов должен сеяться справочником,
    // а не собираться из строк; справочник доезжает до ступеней и до отбора одним и тем же путём.
    expect(WRAPPER).toContain('engineFacets(types) as readonly FacetDescriptor<EngineListItem>[]');
    expect(WRAPPER).toContain('rows={props.engines}');
    expect(PAGE).toContain('const sheetTypes = useWorkSheetTypeRefs();');
    expect(PAGE).toContain('types={sheetTypes}');
  });

  it('ступень по датам рисует две границы, а не список значений', () => {
    expect(FILTER).toContain("if (facet.kind === 'dateRange') {");
    expect(FILTER).toContain('data-facet-date={`${fieldId}:from`}');
    expect(FILTER).toContain('data-facet-date={`${fieldId}:to`}');
  });

  it('варианты считаются по отобранному, а имя цеха подставляется до подсчёта', () => {
    expect(PAGE).toContain('engines={facetRows}');
    expect(PAGE, 'цех приходит идентификатором — без имени ступень покажет UUID').toContain('workshopNameById[id]');
  });

  it('контроль на живых данных: отбор и варианты работают вместе', () => {
    // Строка списка несёт ещё служебные поля (updatedAt/syncStatus) — для отбора они не нужны,
    // поэтому фикстура частичная и приводится к типу строки явно.
    const engines = [
      { id: 'a', engineNumber: 'a', customerId: 'CP1', customerName: 'Первый', engineBrandId: 'BR1', engineBrand: 'Д-245' },
      { id: 'b', engineNumber: 'b', customerId: 'CP2', customerName: 'Второй', engineBrandId: 'BR2', engineBrand: 'ЯМЗ' },
    ] as unknown as EngineListItem[];
    expect(applyEngineFacets(engines, { customer: ['CP1'] }).map((e) => e.id)).toEqual(['a']);
    expect(engineFacetOptions(engines, { customer: ['CP1'] }, 'brand').map((o) => o.value)).toEqual(['BR1']);
  });
});

// Бирки на двигатель (владелец 22.09.2026) — единственная печать списка, которая идёт от
// ВЫДЕЛЕНИЯ, а не от фильтра. Соседние кнопки («Печать этикеток») берут отфильтрованное, и
// стоит перепутать источник — оператор молча получит пачку листов на весь парк.
describe('бирки печатаются по выделенным строкам, а не по фильтру', () => {
  it('набор бирок собирается из выделения списка', () => {
    expect(PAGE).toContain('displayRows.filter((e) => selection.selectedIds.has(String(e.id)))');
    expect(PAGE, 'диалогу бирок отдаётся выделение, а не отфильтрованный список').toContain('setTagRows(selectedEngines)');
    expect(PAGE).toContain('engines={tagRows ?? []}');
  });

  it('этикетки по-прежнему берут отфильтрованное — источники не перепутаны', () => {
    expect(PAGE).toContain('facetFiltered.map((e) => ({');
    const tagDialog = PAGE.slice(PAGE.indexOf('<EngineTagPrintDialog'), PAGE.indexOf('<EngineTagPrintDialog') + 260);
    expect(tagDialog, 'бирки не должны питаться списком этикеток').not.toContain('labelTargets');
    expect(tagDialog).not.toContain('facetFiltered');
  });

  it('пустое выделение проговаривается словами, а не печатает весь список', () => {
    expect(PAGE).toContain('if (selectedEngines.length === 0) {');
    expect(PAGE).toContain('setTagHintVisible(true);');
    expect(PAGE, 'подсказка должна называть, что делать').toContain('Бирки печатаются на выделенные двигатели');
  });

  it('пункт ПКМ-меню для пачки выделенных строк есть и не зависит от наряда на сборку', () => {
    expect(PAGE).toContain('Бирки на выбранные (${menuRows.length})');
    // Раньше меню вовсе не открывалось без onCreateAssemblyOrder — тогда пункт был бы недостижим.
    expect(PAGE).not.toContain('if (!result.openMenu || !props.onCreateAssemblyOrder) return;');
  });
});
