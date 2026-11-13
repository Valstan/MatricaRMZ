import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Обвязка списков после правок владельца 08.09.2026: тулбар в одну строку с меню переполнения,
// выбор колонок рядом плашек под шапкой списка (12.11.2026), однострочные заголовки и ширина
// колонок по данным.
// Всё это рвётся молча — вёрстка «работает», просто снова занимает две строки или снова
// растягивает колонку под длинную подпись.
// Перевод строки нормализуется: на рабочей копии с CRLF многострочные ожидания
// («блок правила CSS целиком») не совпадали ни при какой вёрстке, и сторож краснел
// от настройки Git, а не от кода.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const TOOLBAR = src('./PageToolbar.tsx');
const COLUMNS = src('./ListColumnChips.tsx');
const CSS = src('../global.css');
const WIDTHS = src('../hooks/useAdaptiveListTables.ts');
const POPUP = src('./PopupLayer.tsx');
const KINDS = src('../utils/listColumnKinds.ts');
const PAGES = [
  'EnginesPage',
  'ContractsPage',
  'WorkOrdersPage',
  'CounterpartiesPage',
  'EmployeesPage',
  'StockDocumentsPage',
  'SupplyRequestsPage',
  'NomenclaturePage',
  'NomenclatureDirectoryPage',
  'WorkSheetsPage',
  'PpeCardsPage',
  'reports/EnginesNowAtPlantReportPage',
  'reports/EnginesReportPage',
  'reports/WorkSheetsReportPage',
].map((name) => [name, src(`../pages/${name}.tsx`)] as const);

describe('тулбар списка — одна строка', () => {
  it('ряд не переносится, а лишнее уезжает в меню справа', () => {
    expect(TOOLBAR).toContain("flexWrap: 'nowrap'");
    expect(TOOLBAR).toContain("overflow: 'hidden'");
    expect(TOOLBAR).toContain('data-toolbar-overflow');
  });
  it('ширины замеряются один раз на состав ряда', () => {
    // Повторный замер по спрятанным элементам дал бы нули и схлопнул ряд в одну кнопку.
    expect(TOOLBAR).toContain('const measuring = measured?.signature !== signature;');
    expect(TOOLBAR).toContain('useLayoutEffect(');
  });

  it('замер повторяется, когда вкладка оживает (иначе кнопки срезает краем окна)', () => {
    // Ряд, смонтированный в скрытой вкладке, отдаёт нулевые ширины — кэш не пишется. Пока
    // вкладка не открылась, лишнее уезжает за край и до него не добраться: на узком окне
    // кнопки просто пропадали. Ряд ожил — значит, меряем заново.
    expect(TOOLBAR).toContain('const measureItems = useCallback(');
    expect(TOOLBAR).toContain('measureRef.current();');
    expect(TOOLBAR).toContain('if (measuredRef.current?.signature === signature) return;');
    // Наблюдатель пересоздаётся вместе с замером: тот же ряд, то же правило.
    expect(TOOLBAR).toContain('const observer = new ResizeObserver(');
  });

  it('закреплённое в меню не уезжает', () => {
    expect(TOOLBAR).toContain('export function ToolbarPin');
    // Признак «не убирать» читается из РАЗМЕТКИ: сравнение по типу компонента ломается на
    // горячей перезагрузке, и тогда в меню уезжает даже поиск.
    expect(TOOLBAR).toContain('if (!it || measured.pinned[it.key]) continue;');
    expect(TOOLBAR).toContain('data-toolbar-pin');
  });

  it('уехавший элемент рисуется ровно в одном месте', () => {
    // Иначе диалог печати, живущий внутри кнопки, оказался бы на экране в двух копиях.
    expect(TOOLBAR).toContain('.filter((it) => !hiddenKeys.has(it.key))');
  });

  it('все списки с тулбаром переведены на общий ряд', () => {
    for (const [name, page] of PAGES) {
      expect(page, `${name}: тулбар не на PageToolbar`).toContain('<PageToolbar>');
    }
  });
});

// Панель кнопок над списком (владелец 13.11.2026, промты КАРМАНА #9 и #13): длинные подписи
// сокращены, поле поиска раздвигается при фокусе и сжимается обратно. Ломается молча: панель
// «работает», просто поле осталось узким, а кнопка с длинным текстом отжала соседей.
const SEARCH_FIELD = src('./ToolbarSearchField.tsx');
const TOGGLE = src('./SearchModeToggle.tsx');
/** Список, который тоже панель над списком, но в общий перечень выше не входит. */
const REPAIR_FUND_PAGE = src('../pages/RepairFundAuditPage.tsx');
const EXTRA_LIST_PAGES = [['RepairFundAuditPage', REPAIR_FUND_PAGE] as const];

/** Блок панели кнопок на странице — всё, что внутри `PageToolbar`. */
function toolbarOf(page: string): string {
  return page.slice(page.indexOf('<PageToolbar>'), page.indexOf('</PageToolbar>'));
}

describe('панель кнопок: общее поле поиска и короткие подписи', () => {
  it('поле одно на все списки и раздвигается поверх кнопок', () => {
    expect(SEARCH_FIELD).toContain('export function ToolbarSearchField');
    expect(SEARCH_FIELD).toContain('data-toolbar-search');
    expect(SEARCH_FIELD).toContain('data-toolbar-search-expanded');
    // Накладка, а не перестройка ряда: пересчёт ширин по спрятанным элементам отдал бы нули
    // и схлопнул ряд в одну кнопку (см. комментарий в PageToolbar).
    expect(SEARCH_FIELD).toContain("position: 'relative'");
    expect(SEARCH_FIELD).toContain("position: 'absolute'");
    expect(SEARCH_FIELD).toContain('zIndex: 5');
  });

  it('без фокуса поле возвращается к базовой ширине, текст обрезается, а не исчезает', () => {
    expect(SEARCH_FIELD).toContain('onBlur={() => setExpandedWidth(null)}');
    expect(SEARCH_FIELD).toContain('const BASE_WIDTH = 280;');
    // Ширина базовая — фиксированная: от окна она не зависит, иначе кэш ширин ряда
    // (меряется один раз на состав) после изменения размера окна врал бы.
    expect(SEARCH_FIELD).not.toMatch(/BASE_WIDTH = .*vw/);
  });

  it('кнопка «≈ Похожие» остаётся доступной под раздвинутым полем', () => {
    // Накладка закрывает соседние кнопки, а переключить режим, не убирая курсор из поиска,
    // оператор должен иметь возможность.
    expect(TOGGLE).toContain('zIndex: 6');
  });

  it('ни один список не заводит своё поле поиска в тулбаре', () => {
    for (const [name, page] of [...PAGES, ...EXTRA_LIST_PAGES]) {
      const toolbar = toolbarOf(page);
      if (!toolbar.includes('placeholder="Поиск') && !toolbar.includes('searchPlaceholder')) continue;
      expect(toolbar, `${name}: в тулбаре своё поле вместо общего`).toContain('<ToolbarSearchField');
      // Прочие поля в тулбаре (дата, месяц) — можно; нельзя только голое поле поиска.
      expect(toolbar, `${name}: в тулбаре осталось голое поле поиска`).not.toMatch(/<Input[^>]*placeholder="Поиск/);
    }
  });

  it('длинные подписи сокращены, полная осталась в подсказке', () => {
    const engines = PAGES.find(([name]) => name === 'EnginesPage')![1];
    const toolbar = toolbarOf(engines);
    expect(toolbar).toContain('Бирки');
    expect(toolbar, 'длинная подпись «Бирки на двигатели» вернулась бы').not.toContain('Бирки на двигатели');
    expect(toolbar).toContain('Печать');
    expect(toolbar, 'длинная подпись «Печать списка» вернулась бы').not.toContain('Печать списка');
    // Подсказка по наведению остаётся полной — по ней оператор понимает, что печатает.
    expect(toolbar).toContain('title="Печать текущего списка');
  });

  it('кнопка печати помечена меткой — смоук ищет её по метке, а не по тексту', () => {
    // Подписи у списков разные («Печать списка», «Печать») и меняются; смоук обязан находить
    // кнопку по метке, иначе гейт падает от переименования, а не от поломки.
    for (const [name, page] of [...PAGES, ...EXTRA_LIST_PAGES]) {
      if (!page.includes('Печать текущего списка')) continue;
      expect(page, `${name}: кнопка печати без метки data-list-print`).toContain('data-list-print');
    }
  });

  it('список ревизии фонда стоит на общей панели', () => {
    // Свой flex-ряд переполнения не умеет: кнопки уезжали за правый край окна.
    expect(REPAIR_FUND_PAGE).toContain('<PageToolbar>');
  });
});

describe('выбор колонок', () => {
  it('живёт рядом плашек под шапкой списка, а не кнопкой в тулбаре', () => {
    // Владелец 12.11.2026: «кнопку колонки списка убрать полностью из панели кнопок
    // управления списками… теперь этими колонками управляют плашки». Ряд плашек стоит между
    // панелью фильтров и шапкой списка: белая плашка — колонка выключена, тёмно-серая —
    // включена (видна в списке и идёт на печать).
    expect(COLUMNS).toContain('export function ListColumnChips');
    expect(COLUMNS).toContain('data-list-column-chip={column.id}');
    expect(COLUMNS).toContain("data-list-column-chip-state={on ? 'on' : 'off'}");
    expect(COLUMNS, 'белая плашка — колонка не включена').toContain("const CHIP_OFF_BACKGROUND = '#ffffff';");
    expect(COLUMNS, 'тёмно-серая плашка — колонка включена').toContain('const CHIP_ON_BACKGROUND =');
    for (const [name, page] of PAGES) {
      expect(page, `${name}: ряд плашек колонок на месте`).toContain('<ListColumnChips');
      expect(page, `${name}: кнопка колонок вернулась бы в тулбар`).not.toContain('ColumnSettingsButton');
    }
  });

  it('плашки стоят в одной строке со статистикой — справа от «Всего/Показано»', () => {
    // Владелец 12.11.2026: «помести эти плашки на строку "Всего/Показано" справа от
    // статистики — там много пустого места». Значит, плашки и счётчик — соседи в одном
    // флекс-ряду: между ними не должно закрываться ни одного `</div>`.
    for (const [name, page] of PAGES) {
      const chipsAt = page.indexOf('<ListColumnChips');
      expect(chipsAt, `${name}: ряд плашек не найден`).toBeGreaterThan(0);
      const countAt = page.lastIndexOf('<ListCount', chipsAt);
      expect(countAt, `${name}: счётчик «Всего/Показано» не найден рядом с плашками`).toBeGreaterThan(0);
      const between = page.slice(countAt, chipsAt);
      expect(between, `${name}: плашки уехали в отдельную строку от статистики`).not.toContain('</div>');
    }
  });

  it('включённая колонка уходит и в список, и в печать', () => {
    // Печать и выгрузка берут по умолчанию ровно те колонки, что видны на экране.
    expect(COLUMNS).toContain('onToggleVisible(column.id, !on)');
    const PRINT_SELECTION = src('../utils/listColumnSelection.ts');
    expect(PRINT_SELECTION).toContain('config.visibleColumnIds.filter((id) => known.has(id))');
  });
});

describe('выпадающие панели остаются на экране', () => {
  it('меню тулбара и выбор колонок зажаты в границы окна', () => {
    // Владелец 09.09.2026: кнопка стоит у правого края, панель уезжала за экран, и выбрать
    // в ней было нечего. Зажим считается ПОСЛЕ отрисовки — ширина панели зависит от состава.
    // С 18.09.2026 зажим живёт в `useAnchoredPopup`: панели уехали порталом в body
    // (иначе их перекрывал интерфейс на планшете), и координаты считаются от кнопки.
    expect(POPUP).toContain('export function useAnchoredPopup');
    expect(POPUP).toContain('if (left + width > window.innerWidth - margin)');
    expect(POPUP, 'без запасного края панель прилипает к самой кромке').toContain('const margin = 8;');
    expect(TOOLBAR).toContain('useAnchoredPopup(menuOpen, menuAnchor');
    expect(TOOLBAR).toContain('...popup.style,');
  });

  it('панель, не влезающая вниз, открывается вверх (низкий экран планшета)', () => {
    expect(POPUP).toContain('const putAbove =');
  });
});

describe('шапка колонки — одна строка', () => {
  it('заголовок обрезается, а не переносится', () => {
    // Сравниваем блок целиком: подстрока «table.list-table th {» встречается и в планшетном
    // правиле, и срез по ней захватил бы чужие объявления.
    const NL = String.fromCharCode(10);
    expect(CSS).toContain(
      ['table.list-table th {', '  white-space: nowrap;', '  overflow: hidden;', '  text-overflow: ellipsis;', '}'].join(NL),
    );
    expect(CSS, 'перенос заголовков съедал по две строки высоты у каждого списка').not.toContain(
      `table.list-table th {${NL}  white-space: normal;`,
    );
  });

  it('ширину колонки задают данные строк, а не длина подписи', () => {
    expect(WIDTHS, 'подпись снова раздувала бы колонку').not.toContain('lengths.push(headerText.length);');
    expect(WIDTHS).toContain('headerCell.setAttribute(\'title\', headerText);');
  });

  it('полная подпись доступна по наведению у любой колонки', () => {
    // title у ЛЮБОГО вида колонки (значок data-emoji — рядом, подпись не трогает).
    expect(KINDS).toContain("const base = kind ? { 'data-col-kind': kind, title: label } : { title: label };");
  });
});

// Счётчик и нумерация (владелец 15.09.2026): над каждым списком «Всего: N · Показано: M»,
// слева колонка «№», собираемая при каждом построении. Оба ломаются молча — список
// «работает», просто снова не видно, сколько строк осталось после фильтра.
const VIRTUAL_TABLE = src('./VirtualTable.tsx');
const PRINT_DIALOG = src('./ListPrintDialog.tsx');
const COUNTED_PAGES = [
  ...PAGES,
  ...['EngineBrandsPage', 'ChangesPage', 'StockBalancesPage', 'EngineAssemblyBomPage'].map(
    (name) => [name, src(`../pages/${name}.tsx`)] as const,
  ),
];

describe('счётчик и нумерация строк', () => {
  it('у каждого списка счётчик «Всего · Показано» и колонка «№»', () => {
    for (const [name, page] of COUNTED_PAGES) {
      expect(page, `${name}: нет счётчика ListCount`).toContain('<ListCount');
      expect(page, `${name}: нет заголовка колонки №`).toContain('<RowNumberHeaderCell');
    }
  });

  it('виртуальные списки нумеруют строки через VirtualTable', () => {
    expect(VIRTUAL_TABLE).toContain('rowNumbers?: boolean | { offset?: number }');
    // Сквозная нумерация по умолчанию; `rowNumberOf` отдаёт свой номер или null (черновик,
    // заголовок группы) — ячейка «№» при этом остаётся, чтобы колонки не съезжали.
    expect(VIRTUAL_TABLE).toContain('<RowNumberCell n={rowNumberOf ? rowNumberOf(vi.index) : rowNumberOffset + vi.index + 1} />');
    // Спейсеры и пустое состояние обязаны накрыть и колонку «№», иначе шапка съезжает.
    expect(VIRTUAL_TABLE).toContain('baseColCount + 1');
    for (const [name, page] of COUNTED_PAGES) {
      if (!page.includes('<VirtualTable')) continue;
      expect(page, `${name}: VirtualTable без rowNumbers`).toContain('rowNumbers');
    }
  });

  it('колонка «№» схлопнута CSS и не меряется хуком ширин', () => {
    expect(CSS).toContain("table.list-table td[data-col-kind='rownum']");
    expect(WIDTHS).toContain("getAttribute('data-col-kind') === 'rownum'");
    expect(KINDS).toContain("'rownum'");
  });

  it('старый счётчик двигателей, знавший только текстовый поиск, снят', () => {
    // Он показывал «M из N» лишь при непустом запросе; сужение фасетами выглядело как полный список.
    const engines = COUNTED_PAGES.find(([name]) => name === 'EnginesPage')![1];
    expect(engines).not.toContain('`${displayRows.length} из ${props.engines.length}`');
  });

  it('печать списка ведёт колонку «№» первой', () => {
    expect(PRINT_DIALOG).toContain('<th style="text-align:right">№</th>');
  });
});

// Sweep подтаблиц (владелец 15.09.2026: «вообще все таблицы»): карточки, диалоги, панели.
const SUBTABLE_PAGES = [
  'AdminPage', 'ContractDetailsPage', 'EngineBrandGroupsPage', 'MasterdataWorkshopsPage', 'NomenclatureDetailsPage',
  'RepairFundAuditPage', 'ReportPresetPage', 'ServicesByBrandPage', 'StockDocumentDetailsPage', 'StockInventoryPage',
  'SuperadminAuditPage', 'SupplyRequestDetailsPage', 'SupplyToolMovementsPage', 'ToolDetailsPage', 'ToolPropertiesPage',
  'WarehouseLocationsAdminPage', 'WarehouseLocationsPage', 'WorkOrderDetailsPage', 'WorkOrderTemplatesPage',
  'ServicePriceOrdersPage', 'TimesheetsPage', 'PpeNormsPage', 'PpeStockPage',
].map((name) => [name, src(`../pages/${name}.tsx`)] as const);
const SUBTABLE_COMPONENTS = [
  'AssemblyReturnDialog', 'DocumentHistoryPanel', 'EngineDismantlePreviewDialog', 'NomenclatureTemplateCompositionEditor',
  'RepairChecklistPanel', 'WorkOrderTemplateEditorDialog', 'WorkshopTemplateDialog', 'AttachmentsPanel',
].map((name) => [name, src(`./${name}.tsx`)] as const);

describe('счётчик и нумерация — подтаблицы карточек и диалогов', () => {
  it('каждая таблица карточки/диалога несёт ListCount и колонку «№»', () => {
    for (const [name, text] of [...SUBTABLE_PAGES, ...SUBTABLE_COMPONENTS]) {
      expect(text, `${name}: нет ListCount`).toContain('<ListCount');
      expect(text, `${name}: нет RowNumberHeaderCell`).toContain('<RowNumberHeaderCell');
      expect(text, `${name}: нет RowNumberCell в строках`).toContain('<RowNumberCell');
    }
  });

  it('старые самодельные «№» и счётчики «Показано … из» сняты', () => {
    // Самодельные `<th>№</th>` остались только в print-HTML строках (шаблонные литералы), не в JSX.
    for (const [name, text] of [...SUBTABLE_PAGES, ...SUBTABLE_COMPONENTS]) {
      const jsxOnly = text.replace(/`[\s\S]*?`/g, '');
      expect(jsxOnly, `${name}: самодельная колонка № в JSX`).not.toMatch(/<th[^>`]*>№<\/th>/);
    }
    expect(SUBTABLE_COMPONENTS.find(([n]) => n === 'AttachmentsPanel')![1]).not.toContain('Показано: {filteredList.length}');
    expect(SUBTABLE_PAGES.find(([n]) => n === 'ServicesByBrandPage')![1]).not.toContain('Услуг в списке:');
  });
});

const HANDLE = src('./ColumnResizeHandle.tsx');
const LAYOUT_STORE = src('../hooks/columnLayoutStore.ts');
const LAYOUT_HOOK = src('../hooks/useColumnLayout.ts');

// Ресайз колонок мышью (владелец 01.10.2026): тянуть за правый край шапки.
// Ручка одна на всех, ширины — в том же LWW-хранилище, что порядок и скрытые.
describe('ширина колонки тянется мышью', () => {
  it('ручка: drag пишет ширину, клик после drag не тогглит сортировку, двойной клик — авто', () => {
    expect(HANDLE).toContain('data-col-resize={props.columnId}');
    expect(HANDLE).toContain("cursor: 'col-resize'");
    expect(HANDLE).toContain('setPointerCapture');
    expect(HANDLE).toContain('commitWidths()');
    expect(HANDLE).toContain('props.layout.clearWidth(props.columnId)');
    expect(HANDLE).toContain('swallowNextClick');
  });

  it('ручка A1: тяга не вешает программу — дроссель и конец по всем путям', () => {
    // Живые ширины — не чаще кадра (шторм pointermove не громоздит рендеры).
    expect(HANDLE).toContain('requestAnimationFrame');
    expect(HANDLE).toContain('cancelAnimationFrame');
    // Чистая машина тяги: порог, идемпотентный finish, пусто после конца.
    expect(HANDLE).toContain('columnResizeDrag');
    expect(HANDLE).toContain('drag().finish()');
    // Конец тяги един на все пути: up, cancel, потеря capture, blur окна.
    expect(HANDLE).toContain('onPointerCancel=');
    expect(HANDLE).toContain('onLostPointerCapture=');
    expect(HANDLE).toContain("addEventListener('blur'");
    expect(HANDLE).toContain("removeEventListener('blur'");
    // Capture отпускается явно, взятие — под страховкой от бросающего pointer.
    expect(HANDLE).toContain('releasePointerCapture');
    expect(HANDLE).toContain('hasPointerCapture');
  });

  it('хранилище и хук несут ширины: нормализация, персист, сброс', () => {
    expect(LAYOUT_STORE).toContain('widths: normalizeColumnWidths(');
    expect(LAYOUT_STORE).toContain('widths: Record<string, number>');
    expect(LAYOUT_HOOK).toContain('widthOf');
    expect(LAYOUT_HOOK).toContain('setWidthLive');
    expect(LAYOUT_HOOK).toContain('commitWidths');
    expect(LAYOUT_HOOK).toContain('clearWidth');
  });

  it('все списки рисуют ручку и отдают ширины в таблицу', () => {
    for (const [name, text] of PAGES) {
      expect(text, `${name}: нет ручки ресайза в шапке`).toContain('<ColumnResizeHandle columnId={col.id} layout={columnLayout} />');
      expect(text, `${name}: шапка не якорь для ручки`).toContain('manualThAnchor()');
      // Ширина прибивается <col> внутри таблицы: в automatic-раскладке min/max
      // на ячейках резина игнорирует (поймано смоуком: 339px рисовались как 512),
      // а fixed делит остаток поровну и уродует соседей — поэтому auto + colgroup.
      expect(text, `${name}: ширины не едут в таблицу`).toContain('columnLayout.widthOf(col.id)');
    }
  });
});

const PRINT_PREVIEW = src('../utils/printPreview.ts');
const PRINT_LAYOUT = src('../utils/listPrintLayout.ts');

// Печать списка (владелец 15.09.2026, план batch-pain-print-and-filters-2026-10): лист не
// обрезает колонки и не молчит об отборе. Контракт проверяем по исходникам — вёрсткой он не
// проверяется, а рвётся молча: список «печатается», просто снова уезжает за правый край.
describe('печать списка', () => {
  it('диалог печати считает раскладку сам, а не отдаёт её браузеру', () => {
    expect(PRINT_DIALOG).toContain('planListPrintLayout({ columns: columnSpecs, orientation })');
    expect(PRINT_DIALOG).toContain('<colgroup>');
    expect(PRINT_DIALOG).toContain('table-layout: fixed');
    // Обрезанным колонкам оператор назван поимённо, а не оставлен догадываться по листу.
    expect(PRINT_DIALOG).toContain('layout.clippedLabels');
    expect(PRINT_DIALOG).toContain('Не хватает места колонкам');
  });

  it('каждая страница со списком называет отбор в шапке печати', () => {
    for (const [name, text] of PAGES) {
      expect(text, `${name}: нет диалога печати`).toContain('<ListPrintDialog');
      expect(text, `${name}: шапка листа не узнает, что отобрано`).toContain('filtersSummary={');
      expect(text, `${name}: отбор собран руками вместо общего описания`).toContain('describeFacetSelection');
    }
  });

  it('окно предпросмотра печатает лист той ориентации, что выбрал оператор', () => {
    expect(PRINT_PREVIEW).toContain('@page { size: A4 ');
    expect(PRINT_PREVIEW).toContain('orientationSwitch');
    expect(PRINT_PREVIEW).toContain('fontSizeSwitch');
    expect(PRINT_PREVIEW).toContain('renderPrintHeader');
  });

  it('переключатели в окне предпросмотра пересчитывают раскладку, а не только CSS', () => {
    // Ширины колонок живут в `<colgroup>` внутри разметки: без пересборки разделов и разметки
    // альбомный лист остался бы с колонками книжного, а крупный кегль — с прежними ширинами.
    expect(PRINT_PREVIEW).toContain("typeof opts.extraCss === 'function'");
    expect(PRINT_PREVIEW).toContain("typeof opts.sections === 'function'");
    expect(PRINT_PREVIEW).toContain("typeof opts.printHeader === 'function'");
    expect(PRINT_PREVIEW).toContain('resolvePlan');
    expect(PRINT_DIALOG).toContain('extraCss: (state) => listPrintCss(planFor(state))');
    expect(PRINT_DIALOG).toContain('sections: (state) => [');
    expect(PRINT_DIALOG).toContain('orientation: state.orientation,');
  });

  it('кегль остаётся «авто», пока оператор не тронул переключатель', () => {
    // Иначе на книжном листе остались бы колонки от альбомных 12 pt и обрезались бы все —
    // при том что раскладка для того же листа сама подобрала бы 10 pt.
    expect(PRINT_DIALOG).toContain('...(state.fontSizePinned ? { fontSizePt: state.fontSizePt } : {})');
    expect(PRINT_DIALOG).toContain('plan: planFor,');
    expect(PRINT_PREVIEW).toContain('fontSizePinned = true');
  });

  it('планировщик держит печатную ширину, колонку «№» и ступени кегля', () => {
    expect(PRINT_LAYOUT).toContain('printableWidthMm');
    expect(PRINT_LAYOUT).toContain('ROW_NUMBER_COLUMN_MM');
    expect(PRINT_LAYOUT).toContain('PRINT_FONT_STEPS');
    // Шапка жирная, значение — нет: без поправки слово шапки вылезало из своей колонки.
    expect(PRINT_LAYOUT).toContain('HEADER_BOLD_FACTOR');
    expect(PRINT_DIALOG).toContain('table.list-print th { white-space: normal; overflow-wrap: anywhere; }');
  });
});

const EXPORT_BUTTONS = src('./ListExportButtons.tsx');

// Выгрузка списка в Word и Excel (владелец 19.10.2026, план batch-pain-print-and-filters-2026-10):
// файл собирается из ТОГО ЖЕ модельного слоя, что печать, — колонки, строки и отбор одни и те же,
// иначе Excel расходится с листом, который владелец только что настроил. Проверяем по исходникам:
// разъехавшиеся пропсы видно только глазами, а в списке выгрузка «работает» — просто не с теми
// колонками, и обнаружится это у оператора в файле.
describe('выгрузка списка в Word и Excel', () => {
  it('кнопки стоят на всех списках, где есть печать', () => {
    for (const [name, text] of PAGES) {
      expect(text, `${name}: нет кнопок выгрузки`).toContain('<ListExportButtons');
    }
  });

  it('печать и выгрузка помнят один и тот же набор колонок', () => {
    for (const [name, text] of PAGES) {
      const keys = [...text.matchAll(/storageKey=(\{[^}]*\}?"[^"]*"|\{[^}]*\}|"[^"]*")/g)].map((m) => m[1]);
      expect(keys.length, `${name}: ключей памяти колонок не два`).toBe(2);
      expect(new Set(keys).size, `${name}: печать и выгрузка помнят колонки порознь`).toBe(1);
    }
  });

  it('строки, колонки и отбор выгрузка берёт те же, что печать', () => {
    for (const [name, text] of PAGES) {
      const exportBlock = text.slice(text.indexOf('<ListExportButtons'));
      const block = exportBlock.slice(0, exportBlock.indexOf('/>') + 2);
      expect(block, `${name}: колонки выгрузки собраны мимо модельного слоя печати`).toMatch(
        /columns=\{(?:printColumns|buildListPrintColumns\(columns\))\}/,
      );
      expect(block, `${name}: выгрузка не знает, какие строки выгружать`).toContain('rows={');
      expect(block, `${name}: выгрузка игнорирует выделение, а печать его уважает`).toContain('selectedRows={');
      expect(block, `${name}: колонки на экране у выгрузки свои`).toContain('visibleColumnIds=');
      expect(block, `${name}: выгрузка не называет отбор`).toContain('filtersSummary={describeFacetSelection');
    }
  });

  it('на страницах отчётов выгрузка под тем же правом, что печать', () => {
    for (const [name, text] of PAGES) {
      if (!name.startsWith('reports/')) continue;
      expect(text, `${name}: выгрузка отчёта без права reports.export`).toContain('enabled={props.canExport}');
    }
  });

  it('кнопки не показываются там, где выгрузка не работает', () => {
    expect(EXPORT_BUTTONS).toContain('isAndroidPlatform()');
    expect(EXPORT_BUTTONS).toContain('props.enabled === false');
  });

  it('файл собирает main, а рендерер отдаёт только спецификацию', () => {
    // Сборщики (exceljs, docx) живут в main: их место у файловой системы, а не в окне.
    expect(EXPORT_BUTTONS).toContain('window.matrica.exports.list');
    expect(EXPORT_BUTTONS).toContain('buildListExportSpec');
  });

  it('о большом файле спрашивают до сборки', () => {
    expect(EXPORT_BUTTONS).toContain('BIG_EXPORT_ROWS');
    expect(EXPORT_BUTTONS).toContain('Всё равно выгрузить');
  });
});

const MISMATCH = src('../utils/printColumnMismatch.ts');

// Печать и выгрузка помнят СВОЙ набор колонок, и он разъезжается с тем, что на экране
// (владелец 12.11.2026): «надо тут вопрос задавать оператору о том, что просмотр и шаблон
// печати расходятся в наличии столбцов, и предлагать включить или отключить их, показать
// разницу». Молчаливый файл читают как «вот что в списке» — и это ловушка.
describe('печать спрашивает оператора, когда колонки разошлись', () => {
  it('разница считается отдельным модулем (у него есть свои тесты)', () => {
    expect(MISMATCH).toContain('export function printColumnMismatch');
    expect(MISMATCH).toContain('export function printColumnIdsWithMissing');
    expect(MISMATCH).toContain('export function printColumnIdsWithoutExtra');
  });

  it('в диалоге печати — вопрос с разницей и двумя кнопками', () => {
    expect(PRINT_DIALOG).toContain('data-print-column-mismatch');
    expect(PRINT_DIALOG).toContain('Включить недостающие');
    expect(PRINT_DIALOG).toContain('Отключить лишние');
    expect(PRINT_DIALOG, 'разница показывается словами').toContain('В списке, но не в печати');
    expect(PRINT_DIALOG, 'разница показывается словами').toContain('В печати, но не в списке');
  });

  it('в выгрузке в файл — тот же вопрос, и кнопки помечены', () => {
    expect(EXPORT_BUTTONS).toContain('data-list-export-column-question');
    expect(EXPORT_BUTTONS).toContain('data-list-export-column-add');
    expect(EXPORT_BUTTONS).toContain('data-list-export-column-drop');
    expect(EXPORT_BUTTONS).toContain("data-list-export-columns={mismatchVisible ? 'mismatch' : 'same'}");
  });

  it('выравнивание набора запоминается: печать и файл держат один и тот же список', () => {
    expect(PRINT_DIALOG).toContain('persistPrintColumnIds(props.storageKey, next)');
    expect(EXPORT_BUTTONS).toContain('persistPrintColumnIds(props.storageKey, next)');
  });
});