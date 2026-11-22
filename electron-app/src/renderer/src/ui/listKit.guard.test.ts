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

const MENU_BUILDER = src('./utils/listContextActions.ts');
const SELECTION_HOOK = src('./hooks/useListSelection.ts');
const BEHAVIOR_HOOK = src('./hooks/useListBehaviorSettings.ts');
const SHARED_CONTROL = src('../../../../../shared/src/domain/uiControl.ts');
const SHARED_LIST_BEHAVIOR = src('../../../../../shared/src/domain/listBehavior.ts');

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
