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
    // набора ступеней (раньше — в момент «открытия» по кнопке «Фильтры», которой больше нет).
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

  it('выбранное значение — плашка под своей ячейкой, цветом той же ступени', () => {
    expect(FILTER).toContain('data-facet-chip={`${facet.id}:${option.value}`}');
    expect(FILTER).toContain('background: tone.tint');
    // Плашка и ячейка стоят в одной колонке — плашка под своей кнопкой.
    expect(FILTER).toContain('data-facet-column={facet.id}');
  });

  it('плашки висят плавающим слоем и не раздвигают кнопку родителя (владелец 12.11.2026)', () => {
    // Длинное название выбранного значения разводило соседние кнопки, и общий ряд
    // фильтров «расползался в ширину». Теперь плашка вне потока колонки (absolute) и
    // прижата к центру своей кнопки; место под неё резервируется высотой, а не шириной.
    expect(FILTER).toContain("position: 'absolute'");
    expect(FILTER).toContain("transform: 'translateX(-50%)'");
    expect(FILTER).toContain('FACET_CHIP_ROW_HEIGHT');
    // Поток по ширине у плашек закрыт — все плашки ступени в одну строку.
    expect(FILTER).toContain("flexWrap: 'nowrap'");
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
describe('панель фильтров — по заказу владельца 12.11.2026 (третья правка)', () => {
  it('кнопки «Фильтры» нет ни в компоненте, ни на восьми экранах', () => {
    expect(FILTER, 'кнопка «Фильтры» вернулась бы в тулбар').not.toContain('FacetToggleButton');
    expect(FILTER).not.toContain('data-facet-toggle');
    expect(ENGINE_FILTER, 'кнопка «Фильтры» вернулась бы в тулбар').not.toContain('EngineFacetToggleButton');
    for (const host of HOSTS) {
      expect(host.source, `${host.name}: кнопка «Фильтры» вернулась в тулбар`).not.toContain('FacetToggleButton');
      expect(host.source, `${host.name}: кнопка «Фильтры» вернулась в тулбар`).not.toContain('data-facet-toggle');
    }
  });

  it('панель всегда на виду: свернуть её нечем', () => {
    // Проп `open` ушёл из компонента, а вместе с ним и ранний выход из рендера.
    expect(FILTER, 'панель снова прячется').not.toContain('if (!props.open) return null;');
    expect(FILTER, 'у панели не должно быть пропа раскрытости').not.toContain('open: boolean;');
    expect(ENGINE_FILTER, 'у обёртки не должно быть пропа раскрытости').not.toContain('open: boolean;');
    // Панель стоит под тулбаром на всех восьми экранах.
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
