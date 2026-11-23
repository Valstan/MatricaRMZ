import { readFileSync } from 'node:fs';
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
