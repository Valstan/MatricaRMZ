import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// «Везде одинаково» — это правило ОДНОГО кита, а не копий по спискам (промт КАРМАНА #67,
// D-248). Сторож держит именно это: список отдаёт киту свои данные и объявление
// действий, а правила (лассо, клавиатура, перетаскивание, меню) берёт из общего
// источника. Расхождение правил между списками — это ровно тот класс поломок,
// который эта нитка закрывает.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const KIT_PAGES = [
  './pages/EnginesPage.tsx',
  './pages/ContractsPage.tsx',
  './pages/EmployeesPage.tsx',
  './pages/WorkOrdersPage.tsx',
  './pages/CounterpartiesPage.tsx',
  './pages/ToolPropertiesPage.tsx',
  // Справочники: начало фазы «остальные модули» — те же правила, тот же кит.
  './pages/EngineBrandGroupsPage.tsx',
  './pages/EngineBrandsPage.tsx',
  // Партия 1 «склад и справочники» (25.11.2026): цеха, инвентаризация, остатки по локациям.
  './pages/MasterdataWorkshopsPage.tsx',
  './pages/StockInventoryPage.tsx',
  './pages/WarehouseLocationsPage.tsx',
  // Табели и номера РМЗ — переведены на кит 25.11.2026 (реестр отставал, сторож — нет).
  './pages/TimesheetsPage.tsx',
  './pages/EngineRmzNumbersPage.tsx',
  // Список карточек СИЗ — тоже страница верхнего уровня: список сотрудников, а не пикер.
  // До 23.11.2026 он стоял мимо кита (корневой маркер был, а выделения, контура и меню — нет).
  './pages/PpeCardsPage.tsx',
];

/**
 * Списки КАРТОЧЕК, которые умеют менять порядок строк (фаза «карточки» нитки).
 *
 * Правило одно на всю программу: перестановка строк идёт через кит — ручка «⠿» с
 * перетаскиванием и стрелками. Кнопки ↑/↓ (`RowReorderButtons`) — это вторая механика,
 * и именно её эта фаза закрывает.
 */
const REORDER_CARD_PAGES = [
  './pages/ContractDetailsPage.tsx',
  './pages/WorkOrderDetailsPage.tsx',
  './pages/ToolDetailsPage.tsx',
  './pages/StockDocumentDetailsPage.tsx',
  './pages/SupplyRequestDetailsPage.tsx',
  './pages/TimesheetGridPage.tsx',
  './pages/EmployeeDetailsPage.tsx',
];

/**
 * Отчётные списки — те же три страницы, что в `pages/reports/`. Объём шага «отчёты»
 * зафиксирован в плане нитки (`docs/plans/unified-list-rules-2026-11.md`): по D-248 ③
 * в объём входят только таблицы-страницы, а пресетные таблицы и конструктор отчётов —
 * нет. Проверка границы объёма — в `pages/reports/reportListKit.guard.test.ts`.
 */
const REPORT_PAGES = [
  './pages/reports/EnginesReportPage.tsx',
  './pages/reports/EnginesNowAtPlantReportPage.tsx',
  './pages/reports/WorkSheetsReportPage.tsx',
];

/**
 * Диалоги-редакторы, в которых строки тоже умеют менять порядок (шаг «карточки» нитки).
 *
 * Правило то же: перестановка строк идёт через кит — ручка «⠿» с перетаскиванием и
 * стрелками. Кнопки ↑/↓ были второй механикой рядом с китом — их больше нет нигде.
 */
const REORDER_DIALOGS = [
  './components/WorkSheetTypeEditorDialog.tsx',
  './components/WorkOrderTemplateEditorDialog.tsx',
  './components/RepairStageTemplateDialog.tsx',
  './components/NomenclatureTemplateCompositionEditor.tsx',
];

const MENU_BUILDER = src('./utils/listContextActions.ts');
const SELECTION_HOOK = src('./hooks/useListSelection.ts');
const BEHAVIOR_HOOK = src('./hooks/useListBehaviorSettings.ts');
const SHARED_CONTROL = src('../../../../../shared/src/domain/uiControl.ts');
const SHARED_LIST_BEHAVIOR = src('../../../../../shared/src/domain/listBehavior.ts');
const REPORT_KIT = src('./pages/reports/reportListKit.ts');

describe('списки верхнего уровня живут по одному киту', () => {
  it('каждый список берёт правила из общего источника, а не из своих настроек', () => {
    for (const page of KIT_PAGES) {
      const text = src(page);
      expect(text, `${page}: правила поведения списков взяты не из общего источника`).toContain(
        'useListBehaviorSettings',
      );
      expect(text, `${page}: слой выделения контуром не подключён`).toContain('ListLassoLayer');
    }
  });

  it('строки помечены для выделения контуром — правило одно на программу', () => {
    for (const page of KIT_PAGES) {
      expect(src(page), `${page}: у строк нет маркера data-list-row-key`).toContain('data-list-row-key');
    }
  });

  it('меню собирается из объявления действий: старого жёсткого шаблона больше нет', () => {
    expect(MENU_BUILDER, 'в ките снова появился пункт «удалить», который только гасится').not.toContain(
      'disabled: !args.canDelete',
    );
    expect(MENU_BUILDER).toContain('available');
    expect(MENU_BUILDER).toContain('scope');
    for (const page of KIT_PAGES) {
      expect(src(page), `${page}: меню ещё собирается по старому шаблону`).not.toContain('canDelete: props.canDelete');
    }
  });

  it('выделение контуром живёт в ките и включается общей настройкой', () => {
    expect(src('./hooks/useListLasso.ts')).toContain('data-list-row="true"');
    expect(src('./components/ListLassoLayer.tsx')).toContain('useListLasso');
    expect(BEHAVIOR_HOOK).toContain('setListBehaviorSettings');
  });

  it('перетаскивание сбрасывается само — состояние не залипает после отмены', () => {
    const dragHook = src('./hooks/useListDrag.ts');
    expect(dragHook).toContain("addEventListener('dragend'");
    expect(dragHook).toContain("addEventListener('drop'");
  });

  it('клик мимо списка гасит выделение — правило прежнее, но единое', () => {
    expect(SELECTION_HOOK).toContain("target.closest('[data-list-root=\"true\"]')");
  });

  it('настройка правил — одна на программу и не перекрывается личными настройками', () => {
    expect(SHARED_LIST_BEHAVIOR).toContain('DEFAULT_LIST_BEHAVIOR_SETTINGS');
    expect(SHARED_CONTROL).toContain('listBehavior: { ...b.listBehavior }');
  });
});

describe('списки карточек, которые умеют менять порядок, живут по одному киту', () => {
  it('перестановка идёт через кит — общий хук и общая ручка', () => {
    for (const page of REORDER_CARD_PAGES) {
      const text = src(page);
      expect(text, `${page}: перестановка строк идёт мимо кита`).toContain('useListReorder');
      expect(text, `${page}: ручка перемещения не из кита`).toContain('ListReorderHandle');
    }
  });

  it('кнопок ↑/↓ в списках карточек больше нет — это была вторая механика', () => {
    for (const page of REORDER_CARD_PAGES) {
      expect(src(page), `${page}: остались кнопки ↑/↓ — вторая механика рядом с китом`).not.toContain(
        'RowReorderButtons',
      );
    }
  });

  it('строки помечены — по ним кит находит строки и считает место вставки', () => {
    for (const page of REORDER_CARD_PAGES) {
      const text = src(page);
      expect(text, `${page}: у строк нет маркера data-list-row`).toContain('data-list-row');
      expect(text, `${page}: у строк нет маркера data-list-row-key`).toContain('data-list-row-key');
    }
  });

  it('у каждого списка своя граница — перетаскивание не целит в чужой список', () => {
    for (const page of REORDER_CARD_PAGES) {
      expect(src(page), `${page}: у списка нет границы (scopeRef) — перетаскивание целилось бы в соседний список`).toContain(
        'scopeRef',
      );
    }
  });

  it('ручка одна на программу, а не по копии в каждой карточке', () => {
    const handle = src('./components/ListReorderHandle.tsx');
    expect(handle).toContain('ListRowHandle');
    expect(handle, 'ручка карточек не из кита').toContain("from './ListRowHandle.js'");
  });
});

describe('диалоги-редакторы, где строки меняют порядок, живут по одному киту', () => {
  it('перестановка идёт через кит — общий хук и общая ручка', () => {
    for (const dialog of REORDER_DIALOGS) {
      const text = src(dialog);
      expect(text, `${dialog}: перестановка строк идёт мимо кита`).toContain('useListReorder');
      expect(text, `${dialog}: ручка перемещения не из кита`).toContain('ListReorderHandle');
    }
  });

  it('кнопок ↑/↓ в диалогах больше нет — это была вторая механика', () => {
    for (const dialog of REORDER_DIALOGS) {
      expect(src(dialog), `${dialog}: остались кнопки ↑/↓ — вторая механика рядом с китом`).not.toContain(
        'RowReorderButtons',
      );
    }
  });

  it('строки помечены — по ним кит находит строки и считает место вставки', () => {
    for (const dialog of REORDER_DIALOGS) {
      const text = src(dialog);
      expect(text, `${dialog}: у строк нет маркера data-list-row`).toContain('data-list-row');
      expect(text, `${dialog}: у строк нет маркера data-list-row-key`).toContain('data-list-row-key');
    }
  });

  it('у каждого списка своя граница — перетаскивание не целит в чужой список', () => {
    for (const dialog of REORDER_DIALOGS) {
      expect(src(dialog), `${dialog}: у списка нет границы (scopeRef) — перетаскивание целилось бы в соседний список`).toContain(
        'scopeRef',
      );
    }
  });

  it('кнопок ↑/↓ в программе не осталось — компонент удалён, а не забыт', () => {
    expect(
      existsSync(fileURLToPath(new URL('./components/RowReorderButtons.tsx', import.meta.url))),
      'компонент кнопок ↑/↓ снова в программе — вторая механика рядом с китом',
    ).toBe(false);
  });
});

describe('отчётные списки живут по тому же киту', () => {
  it('каждый отчётный список подключён к киту: контур, маркеры строк, корень списка', () => {
    for (const page of REPORT_PAGES) {
      const text = src(page);
      expect(text, `${page}: отчётный список не подключён к киту`).toContain('useReportListKit');
      expect(text, `${page}: слой выделения контуром не подключён`).toContain('ListLassoLayer');
      expect(text, `${page}: нет маркера корня списка — клик мимо не гасит выделение`).toContain(
        'data-list-root="true"',
      );
      expect(text, `${page}: у строк нет маркера data-list-row-key`).toContain('data-list-row-key');
    }
  });

  it('правила поведения отчёта берутся из общего источника, а не из настроек страницы', () => {
    expect(REPORT_KIT, 'отчётный список берёт правила поведения не из общего источника').toContain(
      'useListBehaviorSettings',
    );
    for (const page of REPORT_PAGES) {
      expect(src(page), `${page}: контур включается не общей настройкой`).toContain('listKit.listBehavior.lasso');
    }
  });

  it('в отчёте удалять нечего — пункта «Удалить» в его меню нет ВООБЩЕ, а не гаснет', () => {
    expect(REPORT_KIT, 'в объявлении действий отчёта снова появилось удаление').not.toContain('listDeleteAction');
    expect(REPORT_KIT, 'пункт «Удалить» в меню отчёта — объявление, а не гаснущая подпись').not.toContain("'Удалить'");
    for (const page of REPORT_PAGES) {
      expect(src(page), `${page}: отчётный список объявляет удаление`).not.toContain('listDeleteAction');
    }
  });
});

/**
 * Производственная программа — список с ГРУППАМИ (договор → его двигатели).
 *
 * Кит перемещения по умолчанию считает движение по плоскому списку; в ПП порядок
 * групповой, и границы групп те же, что у мыши. Сторож держит и подключение
 * группового режима, и обе ручки (заголовка группы и строки).
 */
describe('ПП: клавиатурное перемещение по группам', () => {
  const page = './pages/ProductionProgramPage.tsx';

  it('перемещение стрелками идёт через кит в групповом режиме', () => {
    const text = src(page);
    expect(text, 'ПП не подключила клавиатурное перемещение кита').toContain('useListKeyboardMove');
    expect(text, 'ПП не передала кит групповой режим — границы групп потерялись бы').toContain('grouping:');
  });

  it('ручки и строки подписаны на перемещение — иначе подсказка кита врёт', () => {
    const text = src(page);
    expect(text, 'ручка ПП не подписана на перемещение стрелками').toContain('onHandleClick={programMove.onHandleClick}');
    expect(text, 'строки ПП не подсвечиваются в режиме перемещения').toContain('programMove.moveRowStyle');
  });

  it('своя механика рядом с китом не появилась: порядок считает кит и домен', () => {
    const text = src(page);
    expect(text, 'в ПП появилась своя подсказка про стрелки вместо китовой').not.toContain('ждёт группового кита');
  });
});

/**
 * Список карточек СИЗ — страница верхнего уровня, которая до сих пор жила мимо кита:
 * корневой маркер стоял, а выделения, контура и меню не было. Правило одно на программу,
 * значит и этот список ведёт себя как остальные: объявляет свои действия и уважает выделение.
 */
describe('список карточек СИЗ живёт по тому же киту', () => {
  const page = './pages/PpeCardsPage.tsx';

  it('меню собирается из объявления действий', () => {
    expect(src(page), 'список карточек СИЗ не объявляет свои действия').toContain('ListActionDeclaration');
  });

  it('удалять в списке нечего — пункта «Удалить» в меню нет ВООБЩЕ, а не гаснет', () => {
    expect(src(page), 'в списке карточек СИЗ появилось удаление — удалять там нечего').not.toContain(
      'listDeleteAction',
    );
  });

  it('печать и выгрузка уважают выделение', () => {
    const text = src(page);
    expect(text, 'выгрузка карточек СИЗ не уважает выделение').toContain('selectedRows={selectedRows}');
    expect(text, 'печать карточек СИЗ не уважает выделение').toContain('selectedRows={printScopeRows ?? selectedRows}');
  });
});
