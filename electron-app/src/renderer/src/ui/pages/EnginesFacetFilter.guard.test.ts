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
    expect(PAGE).toContain('const facetFiltered = useMemo(() => applyEngineFacets(filtered, facets)');
    expect(PAGE, 'сортировка снова берёт список до ступеней').toContain('const items = [...facetFiltered];');
    expect(PAGE).toContain("if (String(query ?? '').trim()) return facetFiltered;");
  });

  it('печать этикеток печатает то же, что видно в списке', () => {
    expect(PAGE).toContain('facetFiltered.map((e) => ({');
  });

  it('старый одиночный выбор контрагента снят, а его значение переезжает в ступень', () => {
    expect(PAGE, 'два фильтра об одном и том же — один из них невидим').not.toContain('<option value="">Контрагент: все</option>');
    expect(PAGE).toContain('return { ...base, customer: [customerFilter] };');
  });

  it('ступень с выбранными значениями показывается всегда', () => {
    // Иначе отбор идёт, а чем именно — на экране не видно.
    expect(PAGE).toContain('Array.from(new Set([...known, ...active]))');
  });

  it('кнопка сброса чистит и ступени, и их значения, и легаси-поле', () => {
    expect(PAGE).toContain("onReset={() => patchState({ facets: {}, facetFields: [], customerFilter: '', page: 0 })}");
    expect(FILTER).toContain('data-facet-reset');
  });

  it('варианты считаются по отобранному, а не по всему справочнику', () => {
    expect(PAGE).toContain('engines={filtered}');
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
