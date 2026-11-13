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

  it('ряд кнопок — одна строка, а выбор колонок — рядом плашек над списком', () => {
    expect(PAGE).toContain('<PageToolbar>');
    expect(PAGE).toContain('<ToolbarPin>');
    // Владелец 12.11.2026: кнопка «Колонки списка» из тулбара убрана совсем — колонками
    // управляет ряд плашек между фильтрами и шапкой списка.
    expect(PAGE, 'кнопка «Колонки списка» вернулась бы в тулбар').not.toContain('ColumnSettingsButton');
    expect(PAGE, 'ряд плашек колонок на месте').toContain('<ListColumnChips');
    const toolbar = PAGE.slice(PAGE.indexOf('<PageToolbar>'), PAGE.indexOf('</PageToolbar>'));
    expect(toolbar, 'в тулбаре колонок больше нет').not.toContain('<ListColumnChips');
    const chips = PAGE.indexOf('<ListColumnChips');
    expect(chips, 'ряд плашек — под тулбаром').toBeGreaterThan(PAGE.indexOf('</PageToolbar>'));
    expect(chips, 'ряд плашек — до шапки списка').toBeLessThan(PAGE.indexOf('ref={containerRef}'));
    expect(PAGE, 'в панель фильтров кнопка больше не отдаётся').not.toContain('columnsControl={');
    expect(FILTER, 'слот колонок из панели убран — иначе останется мёртвая разметка').not.toContain('data-facet-columns');
  });

  it('тулбар без кнопки превью: колонку убирают в шапке столбцов', () => {
    // Владелец 08.09.2026 — то же, что и в списке двигателей: второй способ управлять одной
    // и той же колонкой только путает.
    expect(PAGE).not.toContain('Отключить превью');
    expect(PAGE, 'мёртвый механизм видимости не должен остаться в коде').not.toContain('requireShowPreviews');
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
});

describe('вид контракта в карточке', () => {
  it('переключатель пишет в раздел, а не в отдельный атрибут', () => {
    // EAV-freeze: новых атрибутов не заводим, поле живёт внутри contract_sections.
    expect(CARD).toContain('data-contract-kind');
    expect(CARD).toContain('update({ kind })');
    expect(CARD, 'новый EAV-атрибут вида нарушил бы EAV-freeze').not.toContain("'contract_kind'");
  });

  it('вид всегда проставлен: переключатель двух видов, а не «снять вид»', () => {
    // Владелец 13.11.2026: вид по умолчанию «ГОЗ», забытый переключатель не должен
    // оставлять договор без вида — состояния «не указан» больше нет.
    expect(CARD).not.toContain('on ? null : kind');
    expect(CARD).toContain('update({ kind })');
  });
});

describe('вкладки контракта переключаются, шапки короткие (владелец 01.10.2026)', () => {
  it('панели вкладок прячутся по-настоящему: hidden без безусловного display', () => {
    // Полотенце 01.10: у каждой панели hidden + инлайн display:grid — инлайн побеждал,
    // и все 5 панелей были видны всегда. Теперь display только у активной.
    for (const tab of ['contract', 'engines', 'parts', 'accounting', 'files']) {
      const at = CARD.indexOf(`data-card-tab="${tab}"`);
      expect(at, `панели ${tab} нет`).toBeGreaterThan(0);
      const block = CARD.slice(at, CARD.indexOf('>', CARD.indexOf('style=', at)) + 1);
      expect(block, `панель ${tab} видна всегда — полотенце вернулось`).not.toContain("style={{ display: 'grid'");
      expect(block, `панель ${tab} без условного display`).toContain(`activeTab === '${tab}' ? { display: 'grid' }`);
    }
  });

  it('шапки двигательных колонок короткие, полные — в подсказке', () => {
    for (const [id, label, title] of [
      ['enginesPlanned', 'План', 'Двигателей по контракту'],
      ['enginesAccepted', 'Исполнено', 'Двигателей исполнено'],
      ['enginesAtFactory', 'На заводе', 'Двигателей на заводе'],
      ['partsCompleted', 'Запчасти', 'Запчасти исполнено'],
    ]) {
      expect(PAGE, `колонка ${id}`).toContain(`id: '${id}'`);
      expect(PAGE, `колонка ${id} не укорочена`).toContain(`label: '${label}'`);
      expect(PAGE, `у колонки ${id} нет полной подсказки`).toContain(`title: '${title}'`);
    }
  });
});
