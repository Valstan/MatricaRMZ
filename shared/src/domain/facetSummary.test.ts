import { describe, expect, it } from 'vitest';

import { describeFacetSelection, describeFacetSelectionForRows, formatDayLabel, formatMonthLabel } from './facetSummary.js';
import type { FacetDescriptor, FacetSelection } from './listFacets.js';

type Row = { kind: string; stage: string; date: number | null };

const FACETS: FacetDescriptor<Row>[] = [
  {
    kind: 'values',
    id: 'kind',
    label: 'Вид работ',
    valueOf: (row) => ({ value: row.kind, label: row.kind }),
    options: [
      { value: 'stack', label: 'Укладка вала' },
      { value: 'grind', label: 'Шлифовка' },
    ],
  },
  { kind: 'values', id: 'stage', label: 'Цех', valueOf: (row) => ({ value: row.stage, label: row.stage }) },
  { kind: 'dateRange', id: 'stageDate', label: 'Дата этапа', dateOf: (row) => row.date },
];

// Ступень без справочника: значение — идентификатор заказчика, подпись — его название.
// Ровно так устроены «Заказчик», «Контракт», «Марка», «Цех» в списках двигателей.
type CustRow = { customerId: string; customerName: string };
const CUSTOMER_FACETS: FacetDescriptor<CustRow>[] = [
  {
    kind: 'values',
    id: 'customer',
    label: 'Заказчик',
    valueOf: (r) => (r.customerId ? { value: r.customerId, label: r.customerName } : null),
  },
  {
    kind: 'values',
    id: 'workshop',
    label: 'Цех',
    valueOf: (r) => ({ value: r.customerId ? `name:${r.customerName.toLowerCase()}` : 'none', label: r.customerName || 'без цеха' }),
    options: [{ value: 'name:сборка', label: 'Сборка' }],
  },
];


describe('описание отбора для шапки печати', () => {
  it('пустой отбор даёт пустой список, а не «нет фильтров»', () => {
    expect(describeFacetSelection(FACETS, {})).toEqual([]);
  });

  it('подписи значений берутся из ступени, а не из сырого значения', () => {
    const lines = describeFacetSelection(FACETS, { kind: ['stack'] });
    expect(lines).toEqual(['Вид работ: Укладка вала']);
  });

  it('несколько значений и ступеней — один абзац через точку-разделитель', () => {
    const lines = describeFacetSelection(FACETS, { kind: ['stack', 'grind'], stage: ['Сборка'] } satisfies FacetSelection);
    expect(lines).toEqual(['Вид работ: Укладка вала, Шлифовка · Цех: Сборка']);
  });

  it('значение без подписи печатается как есть — отбор не исчезает из шапки', () => {
    const lines = describeFacetSelection(FACETS, { stage: ['Архив'] });
    expect(lines).toEqual(['Цех: Архив']);
  });

  it('диапазон дат: обе границы, одна граница, один день', () => {
    expect(describeFacetSelection(FACETS, { stageDate: { from: '2026-10-01', to: '2026-10-18' } })).toEqual([
      'Дата этапа: с 01.10.2026 по 18.10.2026',
    ]);
    expect(describeFacetSelection(FACETS, { stageDate: { from: '2026-10-01' } })).toEqual(['Дата этапа: с 01.10.2026']);
    expect(describeFacetSelection(FACETS, { stageDate: { to: '2026-10-18' } })).toEqual(['Дата этапа: по 18.10.2026']);
    expect(describeFacetSelection(FACETS, { stageDate: { from: '2026-10-01', to: '2026-10-01' } })).toEqual([
      'Дата этапа: 01.10.2026',
    ]);
  });

  it('длинный перечень значений сокращается, чтобы шапка осталась шапкой', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const lines = describeFacetSelection(FACETS, { stage: many });
    expect(lines[0]).toBe('Цех: a, b, c, d, e, f и ещё 2');
  });

  it('поиск, период, группировка и строки страницы идут отдельными строками', () => {
    const lines = describeFacetSelection(FACETS, { kind: ['stack'] }, {
      search: '  вал  ',
      period: 'всё время',
      grouping: 'по видам работ',
      extra: ['Тип: Деталь', '  '],
    });
    expect(lines).toEqual([
      'Вид работ: Укладка вала',
      'Поиск: «вал»',
      'Период: всё время',
      'Группировка: по видам работ',
      'Тип: Деталь',
    ]);
  });

  it('ступень с пустым выбором не считается активной', () => {
    expect(describeFacetSelection(FACETS, { kind: [], stage: [], stageDate: {} })).toEqual([]);
  });

  it('месяц из <input type="month"> печатается словами', () => {
    expect(formatMonthLabel('2026-10')).toBe('октябрь 2026');
    expect(formatMonthLabel('2026-01')).toBe('январь 2026');
  });

  it('битый месяц не превращается в строку шапки', () => {
    expect(formatMonthLabel('')).toBe('');
    expect(formatMonthLabel('2026-13')).toBe('');
    expect(formatMonthLabel('октябрь')).toBe('');
  });

  it('дата в шапке пишется как у оператора, неразобранная — как есть', () => {
    expect(formatDayLabel('2026-10-01')).toBe('01.10.2026');
    expect(formatDayLabel('вчера')).toBe('вчера');
  });
});

describe('шапка по строкам: значение ступени названо, а не показано идентификатором', () => {
  const rows: CustRow[] = [
    { customerId: '11111111-2222-3333-4444-555555555555', customerName: 'Ромашка' },
    { customerId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', customerName: 'Лютик' },
  ];

  it('идентификатор заказчика печатается названием из строки', () => {
    // Прод-случай: в выгрузке поле заказчика несло id, потому что у ступени нет
    // справочника — ряд значений рождается из строк, и подпись лежит только там.
    const lines = describeFacetSelectionForRows(CUSTOMER_FACETS, rows, {
      customer: ['11111111-2222-3333-4444-555555555555'],
    });
    expect(lines).toEqual(['Заказчик: Ромашка']);
    expect(lines.join(' ')).not.toContain('11111111');
  });

  it('ступень со справочником берёт подпись из справочника, строки ей не нужны', () => {
    const lines = describeFacetSelectionForRows(CUSTOMER_FACETS, rows, { workshop: ['name:сборка'] });
    expect(lines).toEqual(['Цех: Сборка']);
  });

  it('значение, которого нет в строках, не теряет отбор: печатается как есть', () => {
    // Так выглядит выбор, переживший смену данных (заказчик удалён). Идентификатор
    // добивает последняя сетка выгрузки, а шапка честно показывает, что отбор есть.
    const lines = describeFacetSelectionForRows(CUSTOMER_FACETS, rows, { customer: ['99999999-0000-0000-0000-000000000000'] });
    expect(lines).toEqual(['Заказчик: 99999999-0000-0000-0000-000000000000']);
  });

  it('пустой отбор по-прежнему даёт пустую шапку', () => {
    expect(describeFacetSelectionForRows(CUSTOMER_FACETS, rows, {})).toEqual([]);
  });
});
