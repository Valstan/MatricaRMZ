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

  it('кнопка «Фильтры» — в тулбаре, панель разворачивается ниже', () => {
    const toolbar = PAGE.slice(PAGE.indexOf('<SearchModeToggle'), PAGE.indexOf('<SearchModeToggle') + 600);
    expect(toolbar).toContain('<FacetToggleButton<Row>');
    expect(PAGE).toContain('open={facetsOpen}');
    expect(FILTER).toContain('data-facet-toggle');
    expect(FILTER, 'свёрнутая панель не занимает полосу').toContain('if (!props.open) return null;');
  });

  it('кнопка сброса чистит ступени и их значения', () => {
    expect(PAGE).toContain('onReset={() => patchState({ facets: {}, facetFields: [] })}');
    expect(FILTER).toContain('data-facet-reset');
  });

  it('ступень с выбранными значениями показывается всегда', () => {
    expect(PAGE).toContain('Array.from(new Set([...known, ...active]))');
  });

  it('выбор колонок стоит в тулбаре и в панели фильтров не дублируется', () => {
    // Владелец 16.09.2026 вернул кнопку в тулбар: панель фильтров сворачивается, и вместе с
    // ней пропадала настройка колонок — а она нужна и при закрытом фильтре.
    expect(PAGE).toContain('label="Колонки списка"');
    const toolbar = PAGE.slice(PAGE.indexOf('<PageToolbar>'), PAGE.indexOf('</PageToolbar>'));
    expect(toolbar, 'кнопка колонок живёт в тулбаре — она нужна и при свёрнутом фильтре').toContain('<ColumnSettingsButton');
    expect(PAGE, 'в панель фильтров кнопка больше не отдаётся').not.toContain('columnsControl={');
    expect(FILTER, 'слот колонок из панели убран — иначе останется мёртвая разметка').not.toContain('data-facet-columns');
  });

  it('печать списка осталась на месте', () => {
    expect(PAGE).toContain('Печать списка');
    expect(PAGE).toContain('storageKey="list:employees:printFields"');
  });
});
