import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { applyEngineFacets, engineFacetOptions, type EngineListItem } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

// Ступенчатый фильтр списка двигателей: логика чистая и покрыта своими тестами, а рвётся провод —
// список может остаться на прежнем массиве, и тогда фильтр рисуется, считает, показывает числа
// и НИЧЕГО не отбирает. Сторож держит именно цепочку «отбор → сортировка → таблица».
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = src('./EnginesPage.tsx');
const FILTER = src('../components/EngineFacetFilter.tsx');

describe('ступенчатый фильтр доезжает до строк списка', () => {
  it('таблица строится по отфильтрованному ступенями массиву', () => {
    expect(PAGE).toContain('const facetFiltered = useMemo(() => applyEngineFacets(facetRows, facets)');
    expect(PAGE, 'сортировка снова берёт список до ступеней').toContain('const items = [...facetFiltered];');
    expect(PAGE).toContain("if (String(query ?? '').trim()) return facetFiltered;");
  });

  it('печать этикеток печатает то же, что видно в списке', () => {
    expect(PAGE).toContain('facetFiltered.map((e) => ({');
  });

  it('старые одиночные фильтры тулбара сняты, а их значения переезжают в ступени', () => {
    expect(PAGE, 'два фильтра об одном и том же — один из них невидим').not.toContain('<option value="">Контрагент: все</option>');
    expect(PAGE).not.toContain('<option value="all">Акт компл.: все</option>');
    expect(PAGE, 'кнопка «Рекламационные» дублировала свою же ступень').not.toContain('>\n          Рекламационные\n        </Button>');
    for (const migration of [
      "if (customerFilter && !engineFacetIsActive(base, 'customer')) out.customer = [customerFilter];",
      "if (onlyReclamation && !engineFacetIsActive(base, 'reclamation')) out.reclamation = ['yes'];",
      "if (completenessFilter !== 'all' && !engineFacetIsActive(base, 'completenessAct')) out.completenessAct = [completenessFilter];",
    ]) {
      expect(PAGE).toContain(migration);
    }
    expect(PAGE, 'даты прихода переезжают диапазоном, а не парой полей тулбара').toContain(
      "if ((contractDateFrom || contractDateTo) && !engineFacetIsActive(base, 'arrivalDate')) {",
    );
  });

  it('ступень с выбранными значениями показывается всегда', () => {
    // Иначе отбор идёт, а чем именно — на экране не видно.
    expect(PAGE).toContain('Array.from(new Set([...known, ...active]))');
  });

  it('кнопка сброса чистит ступени, их значения и все легаси-поля', () => {
    for (const cleared of ['facets: {},', 'facetFields: [],', "customerFilter: '',", 'onlyReclamation: false,', "completenessFilter: 'all',", "contractDateFrom: '',", "contractDateTo: '',"]) {
      expect(PAGE).toContain(cleared);
    }
    expect(FILTER).toContain('data-facet-reset');
  });

  it('панель прячется под одну кнопку, но число активных ступеней видно и свёрнутой', () => {
    expect(FILTER).toContain('data-facet-toggle');
    expect(FILTER, 'свёрнутая панель всё равно рисует кнопку').toContain('if (!props.open) return <div data-engine-facets>{toggle}</div>;');
    expect(FILTER).toContain("{props.open ? '▾' : '▸'} Фильтры{activeCount > 0 ? ` (${activeCount})` : ''}");
    expect(PAGE).toContain('open={facetsOpen}');
  });

  it('ступень по датам рисует две границы, а не список значений', () => {
    expect(FILTER).toContain("if (facet.kind === 'dateRange') {");
    expect(FILTER).toContain('data-facet-date={`${fieldId}:from`}');
    expect(FILTER).toContain('data-facet-date={`${fieldId}:to`}');
  });

  it('варианты считаются по отобранному, а имя цеха подставляется до подсчёта', () => {
    expect(PAGE).toContain('engines={facetRows}');
    expect(PAGE, 'цех приходит идентификатором — без имени ступень покажет UUID').toContain('workshopNameById[id]');
  });

  it('контроль на живых данных: отбор и варианты работают вместе', () => {
    // Строка списка несёт ещё служебные поля (updatedAt/syncStatus) — для отбора они не нужны,
    // поэтому фикстура частичная и приводится к типу строки явно.
    const engines = [
      { id: 'a', engineNumber: 'a', customerId: 'CP1', customerName: 'Первый', engineBrandId: 'BR1', engineBrand: 'Д-245' },
      { id: 'b', engineNumber: 'b', customerId: 'CP2', customerName: 'Второй', engineBrandId: 'BR2', engineBrand: 'ЯМЗ' },
    ] as unknown as EngineListItem[];
    expect(applyEngineFacets(engines, { customer: ['CP1'] }).map((e) => e.id)).toEqual(['a']);
    expect(engineFacetOptions(engines, { customer: ['CP1'] }, 'brand').map((o) => o.value)).toEqual(['BR1']);
  });
});
