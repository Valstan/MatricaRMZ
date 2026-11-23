import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LIST_REPORT_PAGES } from './listReportPages.js';

// Граница объёма шага «отчёты» (D-248 ③): в объём входят только таблицы-страницы.
// Потолок «84 файла со списками» из плана #68 — это потолок, а не перечень: в нём и
// компоненты, и диалоги, и вложенные панели. Сторож держит решение зафиксированным,
// чтобы объём не «разъехался» молча: новая отчётная страница обязана быть на ките,
// а пресетные таблицы и конструктор отчётов — быть названы в плане как не входящие.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PLAN = src('../../../../../../../docs/plans/unified-list-rules-2026-11.md');
const KIT = src('./reportListKit.ts');

/** Страницы-отчёты, зарегистрированные в рамке «отчёт как список». */
const LIST_REPORT_PAGE_FILES = [
  './EnginesReportPage.tsx',
  './EnginesNowAtPlantReportPage.tsx',
  './WorkSheetsReportPage.tsx',
];

describe('отчётные списки на ките: объём зафиксирован', () => {
  it('зарегистрированы ровно три отчётных списка — и каждый на ките', () => {
    const distinct = new Set(Object.values(LIST_REPORT_PAGES));
    expect(distinct.size, 'число отчётных списков разъехалось с планом').toBe(LIST_REPORT_PAGE_FILES.length);
    for (const file of LIST_REPORT_PAGE_FILES) {
      const text = src(file);
      expect(text, `${file}: отчётный список не подключён к киту`).toContain('useReportListKit');
      expect(text, `${file}: нет маркера корня списка`).toContain('data-list-root="true"');
      expect(text, `${file}: у строк нет маркера data-list-row-key`).toContain('data-list-row-key');
      expect(text, `${file}: контур не подключён`).toContain('ListLassoLayer');
    }
  });

  it('печать и выгрузка отчёта уважают выделение — правило одно на программу', () => {
    for (const file of LIST_REPORT_PAGE_FILES) {
      const text = src(file);
      expect(text, `${file}: выгрузка не берёт выделенное`).toContain('selectedRows={listKit.selectedRows}');
      expect(text, `${file}: печать из меню не помнит, какие строки выбрали`).toContain(
        'selectedRows={printScopeRows ?? listKit.selectedRows}',
      );
    }
  });

  it('план нитки называет и то, что в объёме, и то, что сознательно вне', () => {
    expect(PLAN, 'в плане нет перечня отчётных списков').toContain('ШАГ 4 — отчёты: что именно в объёме');
    for (const file of LIST_REPORT_PAGE_FILES) {
      expect(PLAN, `в плане нет отчёта ${file}`).toContain(file.replace('./', ''));
    }
    // Вне объёма (D-248 ③ + позиционные строки без устойчивого ключа) — названы явно.
    expect(PLAN, 'в плане нет границы по пресетным таблицам').toContain('ReportPresetPage.tsx');
    expect(PLAN, 'в плане нет границы по конструктору отчётов').toContain('CustomReportsPage.tsx');
    expect(PLAN, 'план не ссылается на решение владельца D-248').toContain('D-248');
  });

  it('в отчёте удаления нет — список для чтения, а не список для правки', () => {
    expect(KIT, 'в объявлении действий отчёта снова появилось удаление').not.toContain('listDeleteAction');
    expect(KIT, 'пункт «Удалить» в меню отчёта объявлен').not.toContain("'Удалить'");
  });
});
