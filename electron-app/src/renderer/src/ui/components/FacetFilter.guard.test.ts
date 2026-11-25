import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Владелец 25.10.2026: «когда открыто много фильтров — каша, путаемся, где что лежит». Два
// свойства снимают эту кашу, и оба рвутся молча: панель фильтров работает, просто снова
// бесцветная и снова в исходном порядке.
//
// Перевод строки нормализуется: на копии с CRLF многострочные ожидания не совпали бы ни при
// какой вёрстке, и сторож краснел бы от настройки Git, а не от кода.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const FILTER = src('./FacetFilter.tsx');
const ENGINE_FILTER = src('./EngineFacetFilter.tsx');
const TOGGLE = src('./FacetPanelToggle.tsx');
const STORE = src('../hooks/facetPanelStore.ts');

const HOSTS: ReadonlyArray<{ name: string; source: string; usageKey: string }> = [
  { name: 'EnginesPage', source: src('../pages/EnginesPage.tsx'), usageKey: 'list:engines' },
  { name: 'ContractsPage', source: src('../pages/ContractsPage.tsx'), usageKey: 'list:contracts' },
  { name: 'EmployeesPage', source: src('../pages/EmployeesPage.tsx'), usageKey: 'list:employees' },
  { name: 'PpeCardsPage', source: src('../pages/PpeCardsPage.tsx'), usageKey: 'list:ppe-cards' },
  { name: 'WorkSheetsPage', source: src('../pages/WorkSheetsPage.tsx'), usageKey: 'list:workSheets:ui' },
  {
    name: 'EnginesReportPage',
    source: src('../pages/reports/EnginesReportPage.tsx'),
    usageKey: 'report:engines:ui',
  },
  {
    name: 'EnginesNowAtPlantReportPage',
    source: src('../pages/reports/EnginesNowAtPlantReportPage.tsx'),
    usageKey: 'report:enginesNowAtPlant:ui',
  },
  {
    name: 'WorkSheetsReportPage',
    source: src('../pages/reports/WorkSheetsReportPage.tsx'),
    usageKey: 'report:workSheets:ui',
  },
];

/** Экраны, где панель фильтров есть, а верхней панели управляющих кнопок — нет. */
const EXTRA_HOSTS: ReadonlyArray<{ name: string; source: string; usageKey: string }> = [
  { name: 'CounterpartiesPage', source: src('../pages/CounterpartiesPage.tsx'), usageKey: 'list:counterparties' },
  { name: 'ChildrenPage', source: src('../pages/ChildrenPage.tsx'), usageKey: 'list:children' },
  {
    name: 'OrganizationPage',
    source: src('../pages/OrganizationPage.tsx'),
    usageKey: 'organization:event-selection',
  },
];

describe('фильтры списков — цвет ступени', () => {
  it('оттенок каждой ступени приходит из палитры, а не из цвета «открыто/закрыто»', () => {
    expect(FILTER).toContain('facetTones(');
    expect(FILTER).toContain('tone.accent');
    expect(FILTER).toContain('tone.tint');
  });

  it('меню ступени помечено, фон непрозрачный, а цвет ступени виден по полосе слева', () => {
    // Владелец 12.11.2026: «прозрачность выпадающего меню фильтров убери» — сквозь
    // полупрозрачную выпадашку просвечивал список под ней. Фон теперь непрозрачный
    // (`var(--surface)`), а цвет ступени остался: полоса слева и синее выбранное значение.
    expect(FILTER).toContain('data-facet-menu={facet.id}');
    expect(FILTER).toContain("background: 'var(--surface)'");
    expect(FILTER, 'полупрозрачная подложка панели вернулась бы в меню').not.toContain('background: tone.panel');
    expect(FILTER).toContain('borderLeft: `3px solid ${tone.accent}`');
  });
});

describe('фильтры списков — рейтинг ступеней', () => {
  it('щелчок по ступени копит счёт и переживает перезапуск', () => {
    expect(FILTER).toContain('facetUsageBump(');
    expect(FILTER).toContain('localStorage');
  });

  it('ряд кнопок строится по рейтингу на момент появления панели, а не под курсором', () => {
    // Порядок и состав ряда считаются по СНИМКУ счёта: щелчок внутри панели счёт копит, но
    // ряд под курсором не перетасовывается. Снимок снимается при появлении панели и при смене
    // набора ступеней.
    expect(FILTER).toMatch(
      /const at = Date\.now\(\);\n\s*setRating\(\{ usage: usageRef\.current, at \}\);/,
    );
    expect(FILTER).toContain('facetUsageScore(rating.usage, facet.id, rating.at)');
  });

  it('частые ступени идут левее редких: ряд ячеек строится тем же порядком', () => {
    expect(FILTER).toContain('rankedFields.map(renderFacetColumn)');
    // Отдельного списка панелей больше нет (владелец 12.11.2026) — порядок один: и ячейки, и
    // плашки под ними.
    expect(FILTER).not.toContain('orderedFields.map(');
  });

  it('спойлера больше нет: видны все ступени сразу (владелец 12.11.2026)', () => {
    // Панель после компактной переделки перестала быть «стеной из двух десятков кнопок»,
    // и владелец снял ограничение: «можно убрать спойлер и показывать сразу все кнопки
    // фильтров без скрытия». Рейтинг при этом по-прежнему задаёт порядок.
    expect(FILTER).not.toContain('data-facet-more="fields"');
    // Кнопки спойлера в разметке нет — слово «Ещё» осталось только в комментариях.
    expect(FILTER).not.toContain('<summary');
    expect(FILTER).toContain('rankedFields');
  });

  it('в меню ступени — все варианты, отсортированные по рейтингу', () => {
    // Владелец 12.11.2026: меню показывает всё, что ступень предлагает, — рейтинг задаёт
    // лишь порядок (частые выше), но ничего не отсекает.
    expect(FILTER).toContain('facetValueScore(rating.usage, openFacetId, option.value, rating.at)');
    // Щелчок по значению копит свой счёт, отдельный от счёта ступени.
    expect(FILTER).toContain('bumpFacet(fieldId, option.value)');
  });

  it('ступень с выбором видна в ряду, а выбранное — в меню', () => {
    // Спрятанная ступень с выбором отбирала бы втихую: снять выбор нечем, а плашки висели бы
    // без ячейки. Спойлера больше нет — но и выбор в меню остаётся видимым.
    expect(FILTER).toContain('if (option.selected) return true;');
    expect(FILTER).toContain('data-facet-field={facet.id}');
  });

  it('в меню показываются все совпавшие значения, а не пять', () => {
    expect(FILTER).toContain('const shown = options.filter((option) => matchValueOption(option, query));');
    expect(FILTER).toContain('shown.map(valueButton)');
  });

  it('у каждого списка свой ключ рейтинга', () => {
    for (const host of HOSTS) {
      expect(host.source, `${host.name}: usageKey не передан — ряд кнопок не будет сортироваться`).toContain(
        `usageKey="${host.usageKey}"`,
      );
    }
  });

  it('двигатели идут через обёртку — она обязана прокинуть ключ дальше', () => {
    expect(ENGINE_FILTER).toContain('usageKey?: string;');
    expect(ENGINE_FILTER).toContain('usageKey: props.usageKey');
  });
});

// Вид панели по заказу владельца 12.11.2026: «пусть это будут просто надписи на квадратных
// ячейках, практически без полей», по наведению — меню со всеми вариантами и сбросом этой
// ветки, выбранные значения — плашками под своей кнопкой и цветом той же ступени.
describe('панель фильтров — вид по заказу владельца 12.11.2026', () => {
  it('ячейка ступени — надпись без полей и без рамки, цветом своей ступени', () => {
    expect(FILTER).toContain('background: tone.tint');
    expect(FILTER).toContain("border: 'none'");
    expect(FILTER).toContain("padding: '2px 4px'");
  });

  it('меню ступени открывается по наведению и прикалывается щелчком', () => {
    expect(FILTER).toContain('onMouseEnter={() => openMenu(facet.id,');
    expect(FILTER).toContain('onMouseLeave={closeMenuOnLeave}');
    expect(FILTER).toContain('togglePin(facet.id,');
  });

  it('в меню первая строка — сброс этой ветки, а в ряду — сброс всего', () => {
    expect(FILTER).toContain('data-facet-menu-reset={facet.id}');
    expect(FILTER).toContain('Сбросить фильтр');
    expect(FILTER).toContain('Сбросить фильтры');
    // Сброс ветки снимает ТОЛЬКО свою ступень.
    expect(FILTER).toContain('clearFacet(props.selection, facetId)');
  });

  it('выбранное значение — плашка в ряду панели, цветом той же ступени', () => {
    expect(FILTER).toContain('data-facet-chip={`${facet.id}:${option.value}`}');
    expect(FILTER).toContain('background: tone.tint');
    expect(FILTER).toContain('data-facet-chip-group={facet.id}');
    expect(FILTER).toContain('data-facet-column={facet.id}');
  });

  it('выбранное в меню — синее с белыми буквами, под курсором — серое', () => {
    expect(FILTER).toContain("const MENU_SELECTED = 'hsl(221 83% 53%)'");
    expect(FILTER).toContain("const MENU_HOVER = 'rgba(127, 127, 127, 0.18)'");
    expect(FILTER).toContain("color: option.selected ? '#ffffff' : 'var(--text)'");
  });
});

// Владелец 12.11.2026 (третья правка панели): «убери кнопку „Фильтры“ отовсюду, пусть панель
// фильтров будет всегда открыта и активна и видна под панелью управляющих кнопок карточки или
// списка… прозрачность выпадающего меню фильтров убери… при нажатии на плашку фильтра он
// активировался и деактивировался».
//
// ⚠️ **Разворот 25.11.2026 (промт КАРМАНА #151):** кнопка «Фильтры» ВЕРНУЛАСЬ в верхнюю панель
// управляющих кнопок и открывает/сворачивает панель; свёрнутая панель исчезает с экрана целиком.
// Ниже сторож держит новое решение — старое запрещение снято решением владельца, а не «на всякий
// случай».
describe('панель фильтров — кнопка «Фильтры» в тулбаре (владелец 25.11.2026)', () => {
  it('кнопка есть в верхней панели управляющих кнопок на всех экранах с панелью', () => {
    // Панель фильтров стоит на одиннадцати экранах: девять с верхней панелью управляющих
    // кнопок и два без неё (дети, организационный модуль). Кнопка нужна везде: свёрнутая панель
    // исчезает целиком, и добраться до неё иначе нечем.
    expect(TOGGLE).toContain('data-facet-toggle');
    expect(TOGGLE).toContain('export function FacetPanelToggle(');
    for (const host of [...HOSTS, ...EXTRA_HOSTS]) {
      expect(host.source, `${host.name}: кнопки «Фильтры» нет`).toContain('<FacetPanelToggle');
      expect(host.source, `${host.name}: ключ панели не тот`).toContain(`usageKey="${host.usageKey}"`);
    }
  });

  it('кнопка закреплена: в меню переполнения «⋯» она не уедет', () => {
    // Закрепление — обёрткой `ToolbarPin` (признак ставится разметкой, а не типом компонента).
    for (const host of HOSTS) {
      const at = host.source.indexOf('<FacetPanelToggle');
      expect(at, `${host.name}: кнопки «Фильтры» нет`).toBeGreaterThan(-1);
      const before = host.source.slice(Math.max(0, at - 200), at);
      expect(before, `${host.name}: кнопка «Фильтры» не закреплена`).toContain('<ToolbarPin>');
    }
  });

  it('кнопка и панель читают ОДНО состояние — свой у каждой не заводим', () => {
    // `useListUiState` читает состояние один раз при монтировании и на внешние изменения не
    // подписан: кнопка переключила бы своё, панель — своё, и они разошлись бы. Общий стор с
    // подпиской — единственный способ, при котором нажатие «Фильтры» открывает панель.
    expect(STORE).toContain('export function useFacetPanelState(');
    expect(STORE).toContain('export function subscribeFacetPanel(');
    expect(STORE).toContain('export function toggleFacetPanel(');
    expect(FILTER).toContain("from '../hooks/facetPanelStore.js'");
    expect(TOGGLE).toContain("from '../hooks/facetPanelStore.js'");
    expect(FILTER).toContain('const panel = useFacetPanelState(props.usageKey);');
    expect(TOGGLE).toContain('useFacetPanelState(props.usageKey)');
    // Своего состояния раскрытости ни у страницы, ни у компонента.
    expect(FILTER, 'панель вернулась к состоянию списка без подписки').not.toContain(
      "import { useListUiState }",
    );
    for (const host of [...HOSTS, ...EXTRA_HOSTS]) {
      expect(host.source, `${host.name}: у экрана своё состояние раскрытости панели`).not.toContain('facetsOpen');
      expect(host.source, `${host.name}: у экрана своё состояние раскрытости панели`).not.toContain(
        'facetPanelExpanded',
      );
    }
  });

  it('счётчик активных ступеней — на кнопке: свёрнутая панель исчезает, а признак отбора остаётся', () => {
    // Ловушка «почему тут не все?» (письмо владельцу 12.11.2026): без числа на кнопке оператор
    // не поймёт, почему список короче.
    expect(TOGGLE).toContain('Фильтры{activeCount > 0 ? ` (${activeCount})` : \'\'}');
    expect(FILTER).toContain('setFacetPanelActiveCount(props.usageKey, activeCount);');
    expect(STORE).toContain('export function setFacetPanelActiveCount(');
  });

  it('панель стоит под тулбаром на всех восьми экранах с верхней панелью', () => {
    expect(FILTER, 'у панели не должно быть пропа раскрытости').not.toContain('open: boolean;');
    expect(ENGINE_FILTER, 'у обёртки не должно быть пропа раскрытости').not.toContain('open: boolean;');
    for (const host of HOSTS) {
      expect(host.source, `${host.name}: панель фильтров не отрисована`).toMatch(/<(FacetFilter|EngineFacetFilter)/);
    }
  });

  it('щелчок по плашке снимает значение из отбора — без захода в выпадашку', () => {
    // Владелец: «наводишь мышку, хочешь отключить данный фильтр, а он не отключается, а только
    // выпадашка меню выпала и в ней можно только его выбрать и отключить — это лишнее движение».
    expect(FILTER).toContain('function toggleChip(');
    expect(FILTER).toContain('toggleFacetValue(props.selection, facetId, value)');
    expect(FILTER).toContain('onClick={() => toggleChip(facet.id, option.value)}');
    // Приколотое меню плашки закрывается: плашка могла исчезнуть, и меню осталось бы висеть
    // на несуществующем элементе.
    expect(FILTER).toContain('setPinned((prev) => (prev && prev.facetId === facetId && prev.anchor === value ? null : prev))');
    // Плашка периода снимает период тем же щелчком.
    expect(FILTER).toContain('function clearRangeChip(');
    expect(FILTER).toContain('onClick={() => clearRangeChip(facet.id)}');
  });

  it('выпадашка по наведению осталась как была', () => {
    // Владелец: «выпадашка работает хорошо, пусть так и будет».
    expect(FILTER).toContain('onMouseEnter={() => openMenu(facet.id,');
    expect(FILTER).toContain('onMouseLeave={closeMenuOnLeave}');
    expect(FILTER).toContain('togglePin(facet.id,');
  });
});

// Владелец 25.11.2026 (промт КАРМАНА #151): «кнопка „Фильтры“ в верхней панели управляющих
// кнопок; кнопка „Сбросить фильтры“ уезжает вместе с панелью; свёрнутая панель исчезает совсем».
//
// Это СОЗНАТЕЛЬНЫЙ разворот решений 12.11.2026 («панель всегда открыта, кнопки „Фильтры“ нет
// нигде») и 24.11.2026 («при свёрнутой панели отбор остаётся видимым»). Сторож ниже держит новое
// поведение.
describe('панель фильтров — сворачивается кнопкой в тулбаре (владелец 25.11.2026)', () => {
  it('кнопка сворачивания есть, со знаком-треугольником и подсказкой', () => {
    expect(FILTER).toContain('data-facet-collapse');
    expect(FILTER).toContain('aria-expanded={expanded}');
    // Знак — треугольник вверх: «нажмёшь — свернётся» (владелец 25.11.2026).
    expect(FILTER).toContain('▲');
    expect(FILTER).not.toContain("'▼'");
    expect(FILTER).toContain('title="Свернуть панель фильтров — освободит место под список"');
  });

  it('кнопка сворачивания НЕ разворачивает обратно: обратно — кнопка «Фильтры» в тулбаре', () => {
    expect(FILTER).toContain('onClick={() => panel.setExpanded(false)}');
    expect(FILTER, 'разворачивание осталось бы в панели — а её нет').not.toContain('setExpanded(!expanded)');
    expect(FILTER, 'старое состояние списка вернулось бы').not.toContain('patchPanelState');
  });

  it('свёрнутая панель исчезает с экрана ЦЕЛИКОМ', () => {
    // Ни рамки, ни кнопки «Сбросить фильтры», ни плашек выбранных значений — иначе панель
    // занимала бы место под себя, но ничего не говорила бы (владелец 25.11.2026).
    expect(FILTER).toContain('if (!expanded) return null;');
    expect(FILTER, 'панель пряталась бы атрибутом, а не исчезала').not.toContain('hidden={!expanded}');
    // Ранний выход — после всех хуков, иначе React ругался бы на разное число вызовов.
    const early = FILTER.indexOf('if (!expanded) return null;');
    const hooks = FILTER.lastIndexOf('React.useEffect', early);
    expect(hooks, 'ранний выход встал перед хуками').toBeGreaterThan(-1);
  });

  it('отбор сворачивание не теряет: он живёт в состоянии списка, а не в панели', () => {
    // Панель исчезает, но выбор ступеней — в состоянии списка (его держит страница), поэтому
    // после обратного открытия те же ступени и значения.
    expect(FILTER).toContain('props.selection');
    expect(FILTER).toContain('props.onChangeSelection');
    // Сворачивание не трогает отбор: кнопка сворачивания меняет только раскрытость.
    expect(FILTER).toContain('onClick={() => panel.setExpanded(false)}');
    const collapseBlock = FILTER.slice(
      FILTER.indexOf('data-facet-collapse'),
      FILTER.indexOf('data-facet-collapse') + 400,
    );
    expect(collapseBlock, 'кнопка сворачивания не должна сбрасывать отбор').not.toContain('onReset');
  });

  it('открытая панель — один ряд: сворачивание, сброс, плашки', () => {
    const markup = FILTER.slice(FILTER.indexOf('data-engine-facets'));
    const collapse = markup.indexOf('{renderCollapseButton()}');
    const reset = markup.indexOf('{renderResetButton()}');
    const chips = markup.indexOf('{renderChipRow()}');
    expect(collapse, 'кнопка сворачивания в разметке не найдена').toBeGreaterThan(-1);
    expect(reset, 'кнопка сброса в разметке не найдена').toBeGreaterThan(-1);
    expect(chips, 'ряд плашек в разметке не найден').toBeGreaterThan(-1);
    // Порядок в РАЗМЕТКЕ: сперва сворачивание, потом «Сбросить фильтры», потом плашки
    // (владелец 25.11.2026).
    expect(collapse, 'сворачивание должно быть первым в ряду').toBeLessThan(reset);
    expect(reset, 'сброс — вторым в ряду').toBeLessThan(chips);
    // Все три — в одном ряду панели (`data-facet-panel-bar`), а плашки не стоят отдельной
    // строкой под ступенями.
    const bar = markup.slice(markup.indexOf('data-facet-panel-bar'));
    expect(bar.indexOf('{renderCollapseButton()}')).toBeGreaterThan(-1);
    expect(bar.indexOf('{renderResetButton()}')).toBeGreaterThan(-1);
    expect(bar.indexOf('{renderChipRow()}')).toBeGreaterThan(-1);
    expect(markup.indexOf('{renderChipRow()}')).toBeLessThan(markup.indexOf('data-facet-panel-body'));
  });

  it('ряд переносится, если не влезает в экран', () => {
    expect(FILTER).toContain("flexWrap: 'wrap'");
    const bar = FILTER.slice(FILTER.indexOf('data-facet-panel-bar'), FILTER.indexOf('data-facet-panel-bar') + 400);
    expect(bar).toContain("flexWrap: 'wrap'");
  });

  it('сброс по-прежнему снимает ВСЕ ступени, счётчик активных — на месте', () => {
    expect(FILTER).toContain('onClick={props.onReset}');
    expect(FILTER).toContain('Сбросить фильтры{activeCount > 0 ? ` (${activeCount})` : \'\'}');
    // Сброс одной ступени живёт в её меню.
    expect(FILTER).toContain('data-facet-menu-reset={facet.id}');
  });
});
