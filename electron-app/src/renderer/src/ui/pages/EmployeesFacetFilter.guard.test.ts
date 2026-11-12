import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Ступенчатый фильтр списка сотрудников (владелец 12.09.2026). Логика ступеней чистая и покрыта
// своими тестами, а рвётся провод: список может остаться на прежнем массиве — фильтр рисуется,
// считает, показывает числа и НИЧЕГО не отбирает. Сторож держит цепочку «поиск → ступени →
// сортировка → таблица» и то, что поля, которых нет в строке сервиса (имя цеха, признак файлов),
// действительно досчитываются: ступень без своего поля молча отбирает пустоту.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = src('./EmployeesPage.tsx');
const FILTER = src('../components/FacetFilter.tsx');

describe('ступенчатый фильтр доезжает до строк списка сотрудников', () => {
  it('таблица строится по отфильтрованному ступенями массиву', () => {
    expect(PAGE, 'поиск отбирает первым, ступени — вторым').toContain('const searched = useMemo(');
    expect(PAGE).toContain('const filtered = useMemo(() => applyEmployeeFacets(searched, facets), [searched, facets]);');
    expect(PAGE, 'сортировка идёт по отфильтрованному').toContain('return [...filtered].sort(');
  });

  it('варианты ступеней считаются по найденному поиском, а не по всему справочнику', () => {
    expect(PAGE).toContain('rows={searched}');
  });

  it('поля, которых нет в строке сервиса, досчитываются для ступеней', () => {
    // Сервис отдаёт workshopId и список превью; ступеням нужны имя цеха и «есть файлы».
    expect(PAGE).toContain('workshopName: row.workshopId ? String(workshopNameById.get(row.workshopId) ?? \'\') : \'\'');
    expect(PAGE).toContain('hasFiles: (row.attachmentPreviews?.length ?? 0) > 0');
  });

  it('кнопки «Фильтры» нет: панель фильтров всегда на виду под тулбаром', () => {
    // Владелец 12.11.2026: «убери кнопку „Фильтры“ отовсюду, пусть панель фильтров будет всегда
    // открыта и активна и видна под панелью управляющих кнопок карточки или списка».
    expect(PAGE, 'кнопка «Фильтры» вернулась бы в тулбар').not.toContain('<FacetToggleButton');
    expect(PAGE).not.toContain('data-facet-toggle');
    expect(PAGE, 'у списка больше нет состояния раскрытости панели').not.toContain('facetsOpen');
    expect(FILTER, 'панель снова может исчезнуть').not.toContain('if (!props.open) return null;');
    // Панель при этом на месте — под тулбаром.
    expect(PAGE).toContain('<FacetFilter<Row>');
  });

  it('кнопка сброса чистит ступени и их значения', () => {
    expect(PAGE).toContain('onReset={() => patchState({ facets: {}, facetFields: [] })}');
    expect(FILTER).toContain('data-facet-reset');
  });

  it('ступень с выбранными значениями показывается всегда', () => {
    expect(PAGE).toContain('Array.from(new Set([...known, ...active]))');
  });

  it('выбор колонок — рядом плашек между фильтрами и шапкой списка, а не кнопкой в тулбаре', () => {
    // Владелец 12.11.2026: кнопка «Колонки списка» из тулбара убрана совсем — колонками
    // управляет ряд плашек между фильтрами и шапкой списка.
    expect(PAGE, 'кнопка «Колонки списка» вернулась бы в тулбар').not.toContain('ColumnSettingsButton');
    expect(PAGE, 'ряд плашек колонок на месте').toContain('<ListColumnChips');
    const toolbar = PAGE.slice(PAGE.indexOf('<PageToolbar>'), PAGE.indexOf('</PageToolbar>'));
    expect(toolbar, 'в тулбаре колонок больше нет').not.toContain('<ListColumnChips');
    const chips = PAGE.indexOf('<ListColumnChips');
    expect(chips, 'ряд плашек — после панели фильтров').toBeGreaterThan(PAGE.indexOf('<FacetFilter'));
    expect(chips, 'ряд плашек — до шапки списка').toBeLessThan(PAGE.indexOf('ref={containerRef}'));
    expect(PAGE, 'в панель фильтров кнопка больше не отдаётся').not.toContain('columnsControl={');
    expect(FILTER, 'слот колонок из панели убран — иначе останется мёртвая разметка').not.toContain('data-facet-columns');
  });

  it('печать списка осталась на месте', () => {
    expect(PAGE).toContain('Печать списка');
    expect(PAGE).toContain('storageKey="list:employees:printFields"');
  });
});
