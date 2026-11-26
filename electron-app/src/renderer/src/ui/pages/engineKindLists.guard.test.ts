import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Промт КАРМАНА #163: вид («ГОЗ / гражданка») — полноценный признак во всех списках, где он
// выводим: им фильтруют, по нему сортируют и по нему группируют; подписи короткие; вид
// считается по одному правилу. Сторож держит именно «по одному правилу»: правило, разъехавшееся
// по спискам, читается как поломка («в одном списке фильтр по виду есть, в другом нет»).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/** Списки, где вид выводим. */
const LISTS: { name: string; file: string; grouping: boolean }[] = [
  { name: 'двигатели', file: './EnginesPage.tsx', grouping: true },
  { name: 'договоры', file: './ContractsPage.tsx', grouping: false },
  { name: 'контрагенты', file: './CounterpartiesPage.tsx', grouping: false },
  { name: 'наряды (этапы работ)', file: './WorkSheetsPage.tsx', grouping: true },
  { name: 'отчёт «Двигатели»', file: './reports/EnginesReportPage.tsx', grouping: true },
  { name: 'отчёт «Сейчас на заводе»', file: './reports/EnginesNowAtPlantReportPage.tsx', grouping: true },
  { name: 'отчёт «Этапы работ»', file: './reports/WorkSheetsReportPage.tsx', grouping: true },
];

const pages = LISTS.map((list) => ({ ...list, source: src(list.file) }));

/**
 * Реестр разрезов группировки списка двигателей живёт то в странице, то в домене — соседняя
 * нитка #164 выносит его в `shared/src/domain/engineListGrouping.ts`, чтобы печать и выгрузка
 * знали о нём. Сторож смотрит туда, где реестр лежит СЕЙЧАС, — иначе он краснел бы на пустом
 * месте при каждой перестановке файлов.
 */
const ENGINE_GROUP_REGISTRY = existsSync(
  fileURLToPath(new URL('../../../../../../shared/src/domain/engineListGrouping.ts', import.meta.url)),
)
  ? src('../../../../../../shared/src/domain/engineListGrouping.ts')
  : src('./EnginesPage.tsx');

/** Доменный слой вида в списках — единственное место, где живут подпись, порядок и ступень. */
const KIND_LIST = src('../../../../../../shared/src/domain/engineKindList.ts');

describe('вид — полноценный признак в каждом списке', () => {
  for (const page of pages) {
    it(`${page.name}: быстрый доступ к отбору по виду есть в тулбаре`, () => {
      // Панель фильтров свёрнута за кнопку (решение владельца 25.11.2026) — без кнопки в
      // тулбаре отбор по виду до оператора не доходит.
      expect(page.source, 'в тулбаре нет кнопки «ГОЗ / Гражд.»').toContain('<KindQuickFilter');
      expect(page.source, 'кнопка не подключена к состоянию отбора').toContain('onChangeSelection=');
    });

    it(`${page.name}: сортировка по виду идёт по ЗАДАННОМУ порядку`, () => {
      expect(page.source, 'сортировка по виду не заведена').toContain('engineKindRank(');
      // Старая сортировка по подписи («Гражданский» по алфавиту раньше «ГОЗ») — больше не
      // годится: порядок вида в разных списках разъезжался бы.
      expect(page.source).not.toMatch(/sortValue:[^\n]*CONTRACT_KIND_LABELS\[/);
    });
  }

  it('в списках с группировкой есть раздел «Вид»', () => {
    for (const page of pages.filter((p) => p.grouping)) {
      const source = page.file === './EnginesPage.tsx' ? ENGINE_GROUP_REGISTRY : page.source;
      expect(source, `${page.name}: в выборе группировки нет разреза «Вид»`).toContain("kind: 'По виду'");
      expect(source, `${page.name}: группа «Вид» считается не тем ключом, что и сортировка`).toContain(
        'engineKindGroupKey(',
      );
    }
  });
});

describe('вид считается по одному правилу', () => {
  it('слой вида в списках — один модуль, и в нём есть и подпись, и порядок, и ступень', () => {
    expect(KIND_LIST).toContain('CONTRACT_KIND_SHORT_LABELS');
    expect(KIND_LIST).toContain('engineKindRank');
    expect(KIND_LIST).toContain('engineKindGroupKey');
    expect(KIND_LIST).toContain('engineKindFacetDescriptor');
  });

  it('ступень «Вид» во всех списках строится общим конструктором', () => {
    for (const file of [
      '../../../../../../shared/src/domain/engineListFacets.ts',
      '../../../../../../shared/src/domain/contractListFacets.ts',
      '../../../../../../shared/src/domain/counterpartyListFacets.ts',
      '../../../../../../shared/src/domain/workSheets.ts',
    ]) {
      expect(src(file), `${file}: ступень «Вид» написана своими словами`).toContain('engineKindFacetDescriptor');
    }
  });

  it('короткая подпись вида — одна на всю программу', () => {
    expect(KIND_LIST).toContain("civil: 'Гражд.'");
    // Ряд значений ступени собран из короткой подписи: в кнопке панели фильтров длинное
    // «Гражданский» не влезает.
    expect(KIND_LIST).toContain('CONTRACT_KIND_SHORT_LABELS.military');
    expect(KIND_LIST).toContain('CONTRACT_KIND_SHORT_LABELS.civil');
  });
});
