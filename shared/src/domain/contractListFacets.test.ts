import { describe, expect, it } from 'vitest';

import {
  CONTRACT_FACETS,
  applyContractFacets,
  contractFacetIsActive,
  contractFacetOptions,
  sanitizeContractFacetSelection,
  toggleContractFacetValue,
  type ContractFacetRow,
} from './contractListFacets.js';

// Ступени списка контрактов (просьба владельца 08.09.2026): фильтр читает поля карточки,
// а числовые характеристики (сумма, срок, счётчики) разложены по корзинам — список из сорока
// разных сумм оператору ничего не даёт.
const DAY_05 = Date.parse('2026-09-05T10:00:00');
const DAY_09 = Date.parse('2026-09-09T10:00:00');

const rows: ContractFacetRow[] = [
  {
    id: 'c1',
    kind: 'military',
    customerId: 'CP1',
    counterparty: 'Первый',
    gozIgk: '1234',
    hasFiles: true,
    engineBrandNames: ['Д-245'],
    addonCount: 2,
    isFullyExecuted: false,
    progressPct: 40,
    burningEngines: 1,
    enginesAtFactory: 3,
    contractAmount: 5_000_000,
    dateMs: DAY_05,
    daysLeft: 10,
  },
  {
    id: 'c2',
    kind: 'civil',
    customerId: 'CP2',
    counterparty: 'Второй',
    engineBrandNames: ['ЯМЗ-238'],
    addonCount: 0,
    isFullyExecuted: true,
    progressPct: 100,
    burningEngines: 0,
    enginesAtFactory: 0,
    contractAmount: 500_000,
    dateMs: DAY_09,
    daysLeft: -5,
  },
  {
    id: 'c3',
    customerId: '',
    counterparty: '—',
    addonCount: 0,
    progressPct: null,
    contractAmount: 0,
    dateMs: null,
    daysLeft: null,
  },
];

const ids = (list: ContractFacetRow[]) => list.map((r) => r.id).sort();

describe('ступени списка контрактов', () => {
  it('вид контракта отбирает военные и гражданские, а непроставленные видны отдельно', () => {
    expect(ids(applyContractFacets(rows, { kind: ['military'] }))).toEqual(['c1']);
    expect(ids(applyContractFacets(rows, { kind: ['civil'] }))).toEqual(['c2']);
    // Именно по этому значению контракты без вида и находят, чтобы его проставить.
    expect(ids(applyContractFacets(rows, { kind: ['none'] }))).toEqual(['c3']);
  });

  it('контрагент «—» не создаёт ступени: это отсутствие значения, а не контрагент', () => {
    expect(contractFacetOptions(rows, {}, 'counterparty').map((o) => o.value).sort()).toEqual(['CP1', 'CP2']);
  });

  it('исполнение различает «исполнен», «в работе», «не начат» и «без прогресса»', () => {
    expect(ids(applyContractFacets(rows, { execution: ['done'] }))).toEqual(['c2']);
    expect(ids(applyContractFacets(rows, { execution: ['in_progress'] }))).toEqual(['c1']);
    expect(ids(applyContractFacets(rows, { execution: ['unknown'] }))).toEqual(['c3']);
  });

  it('срок исполнения разложен по корзинам, а не по сырым дням', () => {
    expect(ids(applyContractFacets(rows, { deadline: ['overdue'] }))).toEqual(['c2']);
    expect(ids(applyContractFacets(rows, { deadline: ['soon'] }))).toEqual(['c1']);
    expect(ids(applyContractFacets(rows, { deadline: ['none'] }))).toEqual(['c3']);
  });

  it('сумма разложена по корзинам', () => {
    expect(ids(applyContractFacets(rows, { amount: ['lt1m'] }))).toEqual(['c2']);
    expect(ids(applyContractFacets(rows, { amount: ['lt10m'] }))).toEqual(['c1']);
    expect(ids(applyContractFacets(rows, { amount: ['none'] }))).toEqual(['c3']);
  });

  it('ГОЗ, файлы, ДС, горящие и двигатели на заводе — да/нет', () => {
    expect(ids(applyContractFacets(rows, { goz: ['yes'] }))).toEqual(['c1']);
    expect(ids(applyContractFacets(rows, { files: ['yes'] }))).toEqual(['c1']);
    expect(ids(applyContractFacets(rows, { addons: ['yes'] }))).toEqual(['c1']);
    expect(ids(applyContractFacets(rows, { burning: ['yes'] }))).toEqual(['c1']);
    expect(ids(applyContractFacets(rows, { enginesAtFactory: ['yes'] }))).toEqual(['c1']);
  });

  it('диапазон даты заключения работает как у двигателей', () => {
    expect(ids(applyContractFacets(rows, { signedAt: { from: '2026-09-05', to: '2026-09-05' } }))).toEqual(['c1']);
    // Контракт без даты в отбор по диапазону не попадает.
    expect(ids(applyContractFacets(rows, { signedAt: { from: '2026-01-01' } }))).toEqual(['c1', 'c2']);
  });

  it('ступени сужают вместе, и варианты считаются по остальным ступеням', () => {
    expect(ids(applyContractFacets(rows, { kind: ['military'], goz: ['yes'] }))).toEqual(['c1']);
    expect(contractFacetOptions(rows, { kind: ['civil'] }, 'counterparty').map((o) => o.value)).toEqual(['CP2']);
  });

  it('санитайзер и переключение значений разбирают оба вида ступеней', () => {
    expect(sanitizeContractFacetSelection({ kind: ['military'], signedAt: { from: '2026-09-05' } })).toEqual({
      kind: ['military'],
      signedAt: { from: '2026-09-05' },
    });
    expect(sanitizeContractFacetSelection({ kind: { from: '2026-09-05' } })).toEqual({});
    expect(toggleContractFacetValue({ kind: ['military'] }, 'kind', 'military')).toEqual({});
    expect(contractFacetIsActive({ kind: ['military'] }, 'kind')).toBe(true);
    expect(contractFacetIsActive({}, 'kind')).toBe(false);
  });

  it('у каждой ступени есть подпись и уникальный id', () => {
    const idsList = CONTRACT_FACETS.map((f) => f.id);
    expect(new Set(idsList).size).toBe(idsList.length);
    expect(CONTRACT_FACETS.every((f) => f.label.trim().length > 0)).toBe(true);
  });
});
