import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * График отпусков (промты КАРМАНА #38/#39).
 *
 * Сторож держит вещи, которые тихо ломаются:
 *  - данные берутся из ТОЙ ЖЕ таблицы отпусков `ppe_absences`, по которой идёт
 *    расчёт норм выдачи (второго места хранения отпусков не заводим);
 *  - запись идёт существующими дверями `ppe:absences:*` с правами СИЗ;
 *  - период по умолчанию — две недели с понедельника;
 *  - пересечение с уже заведённым отпуском — предупреждение, а не молчаливый дубль;
 *  - вкладка есть в меню группы «Кладовщик» и в доступе по разделам.
 */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = src('./PpeVacationSchedulePage.tsx');
const SECTIONS = src('../../../../../../shared/src/domain/uiSections.ts');
const SECTION_ACCESS = src('../../../../../../shared/src/domain/sectionAccess.ts');
const APP = src('../App.tsx');
const REGISTRY = src('../services/uiSearchRegistry.ts');

describe('график отпусков', () => {
  it('читает и пишет отпуска через существующие двери СИЗ', () => {
    expect(PAGE).toContain('window.matrica.ppe.absences.list');
    expect(PAGE).toContain('window.matrica.ppe.absences.create');
    expect(PAGE).toContain('window.matrica.ppe.absences.delete');
    // Второго места хранения отпусков не заводим: расчёт норм идёт по ppe_absences.
    expect(PAGE, 'график завёл собственное хранилище отпусков').not.toMatch(/ppe_absences_|setAbsences\s*\(.*localStorage/);
  });

  it('период по умолчанию — две недели с понедельника', () => {
    expect(PAGE).toContain('defaultVacationPeriod(Date.now())');
    expect(PAGE).toContain('mondayOfDate(year, half.month');
  });

  it('пересечение с заведённым отпуском — предупреждение, а не молчаливый дубль', () => {
    expect(PAGE).toContain('findOverlappingAbsence');
    expect(PAGE).toContain("title: 'Период пересекается'");
  });

  it('вкладка заведена в меню группы «Кладовщик» и в доступе по разделам', () => {
    expect(SECTIONS).toContain("| 'ppe_vacations'");
    expect(SECTIONS).toContain("ppe_vacations: 'График отпусков'");
    expect(SECTIONS).toMatch(/workwear: \[[^\]]*'ppe_vacations'/);
    expect(SECTION_ACCESS).toContain("'ppe_vacations',");
    expect(APP).toContain("<PpeVacationSchedulePage canEdit={caps.canEditNomenclature} />");
    expect(REGISTRY).toContain("'ppe_vacations'");
  });

  it('сетка — две половины месяца, а не календарная сетка дней', () => {
    expect(PAGE).toContain('vacationHalves(year)');
    expect(PAGE).toContain('absenceSegments(absences, year)');
  });
});
