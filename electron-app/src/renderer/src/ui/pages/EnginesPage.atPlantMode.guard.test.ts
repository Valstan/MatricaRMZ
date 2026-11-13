import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Режим «Сейчас на заводе» в списке двигателей (владелец 13.11.2026): показывать только
// двигателей, которые сейчас на заводе, и считать ТЕКУЩИЙ заезд — этапы прошлого цикла и
// сброшенные шагом назад не действуют. Ломается молча: список выглядит обычным, просто в
// отборах и колонке «Этап» живёт прошлый заезд.

const PAGE = readFileSync(resolve(__dirname, './EnginesPage.tsx'), 'utf-8');
const AT_PLANT_REPORT = readFileSync(resolve(__dirname, './reports/EnginesNowAtPlantReportPage.tsx'), 'utf-8');
const SHEETS_REPORT = readFileSync(resolve(__dirname, './reports/WorkSheetsReportPage.tsx'), 'utf-8');

describe('режим «Сейчас на заводе» в списке двигателей', () => {
  it('переключатель режима есть и помечен — иначе смоук и оператор его не найдут', () => {
    expect(PAGE).toContain('data-at-plant-mode');
    expect(PAGE).toContain('Сейчас на заводе');
    expect(PAGE).toContain('patchState({ atPlantOnly: !atPlantOnly');
  });

  it('режим показывает только двигателей, которые сейчас на заводе', () => {
    expect(PAGE).toContain('currentPassRows(props.engines).filter(isEngineAtPlant)');
  });

  it('отборы и поиск считаются по строкам режима, а не по всей истории', () => {
    // Поиск и ступени фильтров берут одни и те же строки: иначе в режиме «сейчас» отбор
    // «Отгрузка двигателя заказчику» ловил бы двигателя, вернувшегося по рекламации.
    expect(PAGE).toContain('useListDeepFilter(modeRows');
    expect(PAGE).toContain('applyEngineFacets(facetRows');
  });

  it('оператор видит, что режим включён: в списке не все двигатели', () => {
    expect(PAGE).toContain('data-at-plant-mode-note');
    expect(PAGE).toContain('Режим «Сейчас на заводе»');
    // Счётчики «сколько показано из скольких» — иначе режим выглядит как обычный список.
    expect(PAGE).toContain('modeRows.length');
    expect(PAGE).toContain('props.engines.length');
  });
});

describe('отчёт «Сейчас на заводе» — тот же срез', () => {
  it('строки отчёта переведены на текущий заезд', () => {
    expect(AT_PLANT_REPORT).toContain('.map(currentPassRow)');
    expect(AT_PLANT_REPORT).toContain('.filter(isEngineAtPlant)');
  });
});

describe('отчёты статистики — все операции, без приоритета', () => {
  it('отчёт «Этапы ремонта» считает ВСЕ проходы, а не текущий заезд', () => {
    // Прямое требование владельца: в статистике операции равны и считаются по всем датам.
    expect(SHEETS_REPORT).not.toContain('currentPassRow');
  });
});
