import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Обвязка списков после правок владельца 08.09.2026: тулбар в одну строку с меню переполнения,
// выбор колонок внутри панели фильтров, однострочные заголовки и ширина колонок по данным.
// Всё это рвётся молча — вёрстка «работает», просто снова занимает две строки или снова
// растягивает колонку под длинную подпись.
// Перевод строки нормализуется: на рабочей копии с CRLF многострочные ожидания
// («блок правила CSS целиком») не совпадали ни при какой вёрстке, и сторож краснел
// от настройки Git, а не от кода.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const TOOLBAR = src('./PageToolbar.tsx');
const COLUMNS = src('./ColumnSettingsButton.tsx');
const CSS = src('../global.css');
const WIDTHS = src('../hooks/useAdaptiveListTables.ts');
const CLAMP = src('../hooks/useViewportClamp.ts');
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

describe('выбор колонок', () => {
  it('называется словами', () => {
    expect(COLUMNS).toContain('label?: string;');
    expect(COLUMNS).toContain('{props.label ? <span>{props.label}</span> : null}');
    for (const [name, page] of PAGES) {
      expect(page, `${name}: кнопка колонок без подписи`).toContain('label="Колонки списка"');
    }
  });
});

describe('выпадающие панели остаются на экране', () => {
  it('меню тулбара и выбор колонок зажаты в границы окна', () => {
    // Владелец 09.09.2026: кнопка стоит у правого края, панель уезжала за экран, и выбрать
    // в ней было нечего. Зажим считается ПОСЛЕ отрисовки — ширина панели зависит от состава.
    expect(CLAMP).toContain('export function useViewportClamp');
    expect(CLAMP).toContain('if (rect.right > window.innerWidth - margin)');
    expect(CLAMP, 'без сброса прежнего сдвига поправка накапливается').toContain("node.style.transform = '';");
    expect(TOOLBAR).toContain('useViewportClamp(menuOpen)');
    expect(TOOLBAR).toContain('...clamp.style,');
    expect(COLUMNS).toContain('useViewportClamp(open)');
    expect(COLUMNS).toContain('...clamp.style,');
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
    expect(KINDS).toContain("return kind ? { 'data-col-kind': kind, title: label } : { title: label };");
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
    expect(VIRTUAL_TABLE).toContain('<RowNumberCell n={rowNumberOffset + vi.index + 1} />');
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
  'ServicePriceOrdersPage', 'TimesheetsPage',
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
