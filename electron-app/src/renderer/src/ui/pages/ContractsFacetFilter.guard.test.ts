import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Ступенчатый фильтр списка контрактов: логика чистая и покрыта своими тестами, а рвётся провод —
// список может остаться на прежнем массиве, и тогда фильтр рисуется, считает, показывает числа
// и НИЧЕГО не отбирает. Сторож держит цепочку «поиск → ступени → сортировка → таблица», а также
// то, что поля карточки реально доезжают до строки: ступень без своего поля молча отбирает пустоту.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = src('./ContractsPage.tsx');
const CARD = src('./ContractDetailsPage.tsx');
const FILTER = src('../components/FacetFilter.tsx');

describe('ступенчатый фильтр доезжает до строк списка контрактов', () => {
  it('таблица строится по отфильтрованному ступенями массиву', () => {
    expect(PAGE, 'поиск отбирает первым, ступени — вторым').toContain('const searched = useMemo(');
    expect(PAGE).toContain('const filtered = useMemo(() => applyContractFacets(searched, facets), [searched, facets]);');
  });

  it('варианты ступеней считаются по найденному поиском, а не по всему справочнику', () => {
    expect(PAGE).toContain('rows={searched}');
  });

  it('старых полей дат заключения нет ни в тулбаре, ни в состоянии списка', () => {
    expect(PAGE, 'два фильтра об одном и том же — один из них невидим').not.toContain('title="Дата заключения контракта: с"');
    // Владелец 08.09.2026: поля убраны совсем. Сохранённая граница не переезжает в ступень —
    // снять её было бы нечем, поля на экране больше нет.
    expect(PAGE).not.toContain('contractDateFrom');
    expect(PAGE).not.toContain('contractDateTo');
  });

  it('поля карточки доезжают до строки — иначе ступень отбирает пустоту', () => {
    for (const field of ['kind: sections.primary.kind', 'customerId: sections.primary.customerId', 'gozName:', 'gozIgk:', 'hasSeparateAccount:', 'hasFiles:', 'engineBrandNames:', 'addonCount: sections.addons.length']) {
      expect(PAGE).toContain(field);
    }
    expect(PAGE, 'марки лежат в разделах идентификаторами — ступени нужно имя').toContain('collectContractBrandNames(sections, engineBrandNameById)');
  });

  it('ступень с выбранными значениями показывается всегда', () => {
    expect(PAGE).toContain('Array.from(new Set([...known, ...active]))');
  });

  it('кнопка сброса чистит ступени и их значения', () => {
    expect(PAGE).toContain('onReset={() => patchState({ facets: {}, facetFields: [] })}');
    expect(FILTER).toContain('data-facet-reset');
  });

  it('ряд кнопок — одна строка, а выбор колонок переехал в панель фильтров', () => {
    expect(PAGE).toContain('<PageToolbar>');
    expect(PAGE).toContain('<ToolbarPin>');
    expect(PAGE).toContain('label="Колонки списка"');
    expect(PAGE).toContain('columnsControl={');
    expect(FILTER).toContain('data-facet-columns');
  });

  it('тулбар без кнопки превью: колонку убирают в шапке столбцов', () => {
    // Владелец 08.09.2026 — то же, что и в списке двигателей: второй способ управлять одной
    // и той же колонкой только путает.
    expect(PAGE).not.toContain('Отключить превью');
    expect(PAGE, 'мёртвый механизм видимости не должен остаться в коде').not.toContain('requireShowPreviews');
  });

  it('кнопка «Фильтры» — в тулбаре, панель разворачивается ниже', () => {
    const toolbar = PAGE.slice(PAGE.indexOf('<SearchModeToggle'), PAGE.indexOf('<SearchModeToggle') + 500);
    expect(toolbar).toContain('<FacetToggleButton<Row>');
    expect(PAGE).toContain('open={facetsOpen}');
    expect(FILTER).toContain('data-facet-toggle');
    expect(FILTER, 'свёрнутая панель не занимает полосу').toContain('if (!props.open) return null;');
  });
});

describe('вид контракта в карточке', () => {
  it('переключатель пишет в раздел, а не в отдельный атрибут', () => {
    // EAV-freeze: новых атрибутов не заводим, поле живёт внутри contract_sections.
    expect(CARD).toContain('data-contract-kind');
    expect(CARD).toContain('update({ kind: on ? null : kind })');
    expect(CARD, 'новый EAV-атрибут вида нарушил бы EAV-freeze').not.toContain("'contract_kind'");
  });

  it('повторный щелчок снимает вид — иначе «не указан» не вернуть', () => {
    expect(CARD).toContain('on ? null : kind');
  });
});
