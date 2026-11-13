import { describe, expect, it } from 'vitest';

import {
  applyCounterpartyFacets,
  COUNTERPARTY_FACETS,
  counterpartyFacetOptions,
  counterpartyFacetRangeOf,
  sanitizeCounterpartyFacetSelection,
  toggleCounterpartyFacetValue,
  type CounterpartyFacetRow,
  type CounterpartyFacetSelection,
} from './counterpartyListFacets.js';

const rows: CounterpartyFacetRow[] = [
  {
    id: 'cp-1',
    inn: '1234567890',
    kpp: '9901',
    address: 'г. Казань, ул. Победы, 1',
    phone: '+7-900',
    email: 'a@b.ru',
    updatedAt: Date.parse('2026-09-05T10:00:00'),
    contractCount: 5,
    contractAmount: 12_000_000,
    enginesAtFactory: 3,
    overdueContracts: 1,
  },
  {
    id: 'cp-2',
    inn: '999',
    updatedAt: Date.parse('2026-08-01T10:00:00'),
    contractCount: 1,
    contractAmount: 500_000,
    enginesAtFactory: 0,
    overdueContracts: 0,
  },
  {
    id: 'cp-3',
    updatedAt: Date.parse('2026-07-01T10:00:00'),
    contractCount: 0,
    contractAmount: 0,
    enginesAtFactory: 0,
    overdueContracts: 0,
  },
];

const ids = (list: CounterpartyFacetRow[]) => list.map((r) => r.id).sort();

describe('ступени списка заказчиков', () => {
  it('отбирает по числу договоров, сумме, двигателям и просрочке', () => {
    expect(ids(applyCounterpartyFacets(rows, { contracts: ['many'] }))).toEqual(['cp-1']);
    expect(ids(applyCounterpartyFacets(rows, { contracts: ['none'] }))).toEqual(['cp-3']);
    expect(ids(applyCounterpartyFacets(rows, { amount: ['gte10m'] }))).toEqual(['cp-1']);
    expect(ids(applyCounterpartyFacets(rows, { enginesAtFactory: ['yes'] }))).toEqual(['cp-1']);
    expect(ids(applyCounterpartyFacets(rows, { overdue: ['yes'] }))).toEqual(['cp-1']);
  });

  it('ступени складываются: «много договоров» + «просроченные»', () => {
    expect(ids(applyCounterpartyFacets(rows, { contracts: ['many'], overdue: ['yes'] }))).toEqual(['cp-1']);
    // «Просроченные» есть только у cp-1, а «4 и больше» — только у него же; если бы
    // ступени складывались не по «и», а по «или», в отбор попал бы и cp-3.
    expect(ids(applyCounterpartyFacets(rows, { contracts: ['none'], overdue: ['yes'] }))).toEqual([]);
  });

  it('реквизиты: заполнены / частично / нет', () => {
    expect(ids(applyCounterpartyFacets(rows, { requisites: ['full'] }))).toEqual(['cp-1']);
    expect(ids(applyCounterpartyFacets(rows, { requisites: ['partial'] }))).toEqual(['cp-2']);
    expect(ids(applyCounterpartyFacets(rows, { requisites: ['none'] }))).toEqual(['cp-3']);
  });

  it('дата изменения — диапазон', () => {
    const selection: CounterpartyFacetSelection = { updatedAt: { from: '2026-08-15', to: '2026-09-30' } };
    expect(ids(applyCounterpartyFacets(rows, selection))).toEqual(['cp-1']);
    expect(counterpartyFacetRangeOf(selection, 'updatedAt')).toEqual({ from: '2026-08-15', to: '2026-09-30' });
  });

  it('варианты ступени считаются по строкам, прошедшим остальные ступени', () => {
    // Отбор «много договоров» оставляет только cp-1 — значит, в вариантах остальных
    // ступеней остаются только её значения (движок listFacets так и считает).
    const options = counterpartyFacetOptions(rows, { contracts: ['many'] }, 'overdue');
    expect(options.map((o) => o.value)).toEqual(['yes']);
    const all = counterpartyFacetOptions(rows, {}, 'overdue');
    expect(all.map((o) => o.value).sort()).toEqual(['no', 'yes']);
  });

  it('переключение значения и очистка ступени', () => {
    const on: CounterpartyFacetSelection = toggleCounterpartyFacetValue({}, 'contracts', 'many');
    expect(on.contracts).toEqual(['many']);
    const off = toggleCounterpartyFacetValue(on, 'contracts', 'many');
    expect(off.contracts ?? []).toEqual([]);
  });

  it('мусор в выборе отбрасывается, а не падает', () => {
    // Неизвестная СТУПЕНЬ отбрасывается; неизвестное ЗНАЧЕНИЕ внутри известной ступени
    // остаётся (оно просто ничего не отбирает) — так ведёт себя и общий движок.
    const sanitized = sanitizeCounterpartyFacetSelection({ contracts: ['many', 'нет-такого'], bogus: ['x'] });
    expect(sanitized.contracts).toEqual(['many', 'нет-такого']);
    expect((sanitized as Record<string, unknown>).bogus).toBeUndefined();
  });

  it('все ступени объявлены с подписями', () => {
    for (const facet of COUNTERPARTY_FACETS) {
      expect(facet.label.length, `ступень ${facet.id} без подписи`).toBeGreaterThan(0);
    }
  });
});
