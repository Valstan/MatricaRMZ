import { describe, expect, it } from 'vitest';

import type { EngineListItem } from '../ipc/types.js';

import {
  activeEngineFacetCount,
  applyEngineFacets,
  clearEngineFacet,
  engineFacetById,
  engineFacetOptions,
  setEngineFacetDateBound,
  sanitizeEngineFacetSelection,
  toggleEngineFacetValue,
} from './engineListFacets.js';

// Ступенчатый фильтр списка двигателей (просьба владельца 07.09.2026): выбираем поля, затем
// значения, и каждый выбор отсекает лишнее в остальных ступенях.
const YEAR_2025 = Date.UTC(2025, 5, 1);
const YEAR_2026 = Date.UTC(2026, 1, 1);

// Строка списка несёт ещё служебные поля (updatedAt/syncStatus) — отбору они не нужны,
// поэтому фикстура частичная и приводится к типу строки явно.
const engines = [
  { id: 'e1', engineNumber: '1', customerId: 'CP1', customerName: 'Первый', contractId: 'C1', contractName: '125/2026', engineBrandId: 'BR1', engineBrand: 'Д-245', arrivalDate: YEAR_2025 },
  { id: 'e2', engineNumber: '2', customerId: 'CP1', customerName: 'Первый', contractId: 'C1', contractName: '125/2026', engineBrandId: 'BR2', engineBrand: 'ЯМЗ-238', arrivalDate: YEAR_2025 },
  { id: 'e3', engineNumber: '3', customerId: 'CP2', customerName: 'Второй', contractId: 'C2', contractName: '7/2026', engineBrandId: 'BR1', engineBrand: 'Д-245', arrivalDate: YEAR_2026 },
  { id: 'e4', engineNumber: '4', customerId: 'CP2', customerName: 'Второй', contractId: 'C2', contractName: '7/2026', engineBrandId: 'BR3', engineBrand: 'КамАЗ-740', arrivalDate: YEAR_2026, isScrap: true },
] as unknown as EngineListItem[];

const ids = (list: EngineListItem[]) => list.map((e) => e.id).sort();

describe('ступенчатый фильтр списка двигателей', () => {
  it('пустой фильтр не отбирает ничего', () => {
    expect(ids(applyEngineFacets(engines, {}))).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(activeEngineFacetCount({})).toBe(0);
  });

  it('одна ступень отбирает по нескольким значениям сразу', () => {
    expect(ids(applyEngineFacets(engines, { brand: ['BR1', 'BR3'] }))).toEqual(['e1', 'e3', 'e4']);
  });

  it('ступени складываются по «И»', () => {
    expect(ids(applyEngineFacets(engines, { customer: ['CP2'], brand: ['BR1'] }))).toEqual(['e3']);
  });

  it('варианты ступени считаются по строкам, прошедшим ОСТАЛЬНЫЕ ступени', () => {
    const brands = engineFacetOptions(engines, { customer: ['CP1'] }, 'brand');
    expect(brands.map((o) => o.value).sort()).toEqual(['BR1', 'BR2']);
    expect(brands.every((o) => o.count === 1)).toBe(true);
  });

  it('отсечение работает в обе стороны — порядок выбора не важен', () => {
    // Выбрали марку: в заказчиках остаётся только тот, у кого она есть.
    const customers = engineFacetOptions(engines, { brand: ['BR3'] }, 'customer');
    expect(customers.map((o) => o.value)).toEqual(['CP2']);
    // И наоборот — жёсткая лесенка «сперва заказчик» этого бы не дала.
    const brands = engineFacetOptions(engines, { customer: ['CP2'] }, 'brand');
    expect(brands.map((o) => o.value).sort()).toEqual(['BR1', 'BR3']);
  });

  it('своя ступень из подсчёта исключена: выбранное значение не схлопывает свой же список', () => {
    // Иначе, выбрав одну марку, оператор увидел бы в списке только её и не смог бы добавить вторую.
    const brands = engineFacetOptions(engines, { brand: ['BR1'] }, 'brand');
    expect(brands.map((o) => o.value).sort()).toEqual(['BR1', 'BR2', 'BR3']);
    expect(brands.find((o) => o.value === 'BR1')?.selected).toBe(true);
  });

  it('выбранное значение, которого не осталось в отборе, показывается нулём — иначе его не снять', () => {
    const options = engineFacetOptions(engines, { customer: ['CP1'], brand: ['BR3'] }, 'brand');
    const br3 = options.find((o) => o.value === 'BR3');
    expect(br3).toBeDefined();
    expect(br3?.count).toBe(0);
    expect(br3?.selected).toBe(true);
  });

  it('переключение значения добавляет и убирает, а пустая ступень исчезает целиком', () => {
    let sel = toggleEngineFacetValue({}, 'brand', 'BR1');
    expect(sel).toEqual({ brand: ['BR1'] });
    sel = toggleEngineFacetValue(sel, 'brand', 'BR2');
    expect(sel.brand).toEqual(['BR1', 'BR2']);
    sel = toggleEngineFacetValue(sel, 'brand', 'BR1');
    expect(sel.brand).toEqual(['BR2']);
    sel = toggleEngineFacetValue(sel, 'brand', 'BR2');
    expect(sel.brand).toBeUndefined();
    expect(activeEngineFacetCount(sel)).toBe(0);
  });

  it('снятие ступени целиком', () => {
    const sel = clearEngineFacet({ customer: ['CP1'], brand: ['BR1'] }, 'customer');
    expect(sel).toEqual({ brand: ['BR1'] });
    expect(clearEngineFacet(sel, 'customer')).toBe(sel);
  });

  it('двигатель без значения поля в отбор по этому полю не попадает', () => {
      const noBrand = [{ id: 'x', engineNumber: 'x' }] as unknown as EngineListItem[];
    expect(applyEngineFacets(noBrand, { brand: ['BR1'] })).toEqual([]);
    expect(applyEngineFacets(noBrand, {})).toHaveLength(1);
  });

  it('санитайзер: состояние списка роумится, мусор в нём не должен ломать отбор', () => {
    expect(sanitizeEngineFacetSelection(null)).toEqual({});
    expect(sanitizeEngineFacetSelection({ brand: 'BR1' })).toEqual({});
    expect(sanitizeEngineFacetSelection({ brand: ['BR1', 'BR1', ''], нет_такого: ['x'] })).toEqual({ brand: ['BR1'] });
  });
});

// Ступени, добавленные по просьбе владельца 08.09.2026: стадия ремонта, цех, акт дефектовки
// и диапазоны дат. Диапазон — не список значений, поэтому у него свои правила отбора.
const DAY_05 = Date.parse('2026-09-05T10:00:00');
const DAY_07 = Date.parse('2026-09-07T10:00:00');
const DAY_09 = Date.parse('2026-09-09T10:00:00');

const dated = [
  { id: 'd1', arrivalDate: DAY_05, defectDate: DAY_05, workshopId: 'W1', workshopName: 'Цех 1', hasDefectAct: true, statusFlags: { status_repair_started: true } },
  { id: 'd2', arrivalDate: DAY_07, defectDate: DAY_09, workshopId: 'W2', workshopName: 'Цех 2', statusFlags: { status_repair_started: true, status_repaired: true } },
  { id: 'd3', arrivalDate: DAY_09, workshopId: '', statusFlags: {} },
] as unknown as EngineListItem[];

describe('ступени по датам', () => {
  it('диапазон включает обе границы целиком, а не с полуночи', () => {
    expect(ids(applyEngineFacets(dated, { arrivalDate: { from: '2026-09-05', to: '2026-09-07' } }))).toEqual(['d1', 'd2']);
  });

  it('одна дата означает ровно этот день', () => {
    expect(ids(applyEngineFacets(dated, { arrivalDate: { from: '2026-09-07', to: '2026-09-07' } }))).toEqual(['d2']);
  });

  it('открытая граница отбирает в одну сторону', () => {
    expect(ids(applyEngineFacets(dated, { arrivalDate: { to: '2026-09-05' } }))).toEqual(['d1']);
    expect(ids(applyEngineFacets(dated, { arrivalDate: { from: '2026-09-09' } }))).toEqual(['d3']);
  });

  it('двигатель без даты в отбор по диапазону не попадает', () => {
    expect(ids(applyEngineFacets(dated, { defectDate: { from: '2026-09-01' } }))).toEqual(['d1', 'd2']);
  });

  it('пустой диапазон не отбирает и не считается активной ступенью', () => {
    expect(ids(applyEngineFacets(dated, { arrivalDate: {} }))).toEqual(['d1', 'd2', 'd3']);
    expect(activeEngineFacetCount({ arrivalDate: {} })).toBe(0);
    expect(activeEngineFacetCount({ arrivalDate: { from: '2026-09-05' } })).toBe(1);
  });

  it('у ступени по датам нет списка вариантов', () => {
    expect(engineFacetOptions(dated, {}, 'arrivalDate')).toEqual([]);
  });

  it('диапазон и значения сужают вместе', () => {
    expect(ids(applyEngineFacets(dated, { arrivalDate: { from: '2026-09-05' }, workshop: ['W2'] }))).toEqual(['d2']);
  });

  it('санитайзер пропускает только YYYY-MM-DD и режет мусор', () => {
    expect(sanitizeEngineFacetSelection({ arrivalDate: { from: '2026-09-05', to: 'вчера' } })).toEqual({ arrivalDate: { from: '2026-09-05' } });
    expect(sanitizeEngineFacetSelection({ arrivalDate: ['2026-09-05'] })).toEqual({});
    expect(sanitizeEngineFacetSelection({ workshop: { from: '2026-09-05' } })).toEqual({});
  });

  it('setEngineFacetDateBound снимает ступень, когда обе границы пусты', () => {
    const one = setEngineFacetDateBound({}, 'arrivalDate', 'from', '2026-09-05');
    expect(one).toEqual({ arrivalDate: { from: '2026-09-05' } });
    expect(setEngineFacetDateBound(one, 'arrivalDate', 'from', '')).toEqual({});
  });
});

describe('стадия ремонта, цех и акт дефектовки', () => {
  it('стадия — самый поздний выставленный флаг, а не все сразу', () => {
    expect(engineFacetById('status')?.kind).toBe('values');
    expect(ids(applyEngineFacets(dated, { status: ['status_repaired'] }))).toEqual(['d2']);
    expect(ids(applyEngineFacets(dated, { status: ['status_repair_started'] }))).toEqual(['d1']);
  });

  it('двигатель без единого флага попадает в «без стадии»', () => {
    expect(ids(applyEngineFacets(dated, { status: ['none'] }))).toEqual(['d3']);
  });

  it('двигатель без цеха отбирается отдельным значением', () => {
    expect(ids(applyEngineFacets(dated, { workshop: ['none'] }))).toEqual(['d3']);
  });

  it('акт дефектовки делит список надвое без «нет значения»', () => {
    expect(ids(applyEngineFacets(dated, { defectAct: ['yes'] }))).toEqual(['d1']);
    expect(ids(applyEngineFacets(dated, { defectAct: ['no'] }))).toEqual(['d2', 'd3']);
  });
});
