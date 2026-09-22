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

// Ступени по истории ремонта (шаг 5 пакета владельца): «что с двигателем происходило» и когда.
const historyRows = [
  { id: 'h1', lastHistoryAction: 'Перемещение в другой цех', lastHistoryAt: DAY_05, workshopId: 'W1', workshopName: 'Цех 1' },
  { id: 'h2', lastHistoryAction: 'Ремонт закончен', lastHistoryAt: DAY_09, workshopId: 'W2', workshopName: 'Цех 2' },
  { id: 'h3' },
] as unknown as EngineListItem[];

describe('ступени по истории ремонта', () => {
  it('отбирает по последнему событию', () => {
    expect(ids(applyEngineFacets(historyRows, { historyAction: ['ремонт закончен'] }))).toEqual(['h2']);
  });

  it('двигатель без истории собирается в «событий нет»', () => {
    expect(ids(applyEngineFacets(historyRows, { historyAction: ['none'] }))).toEqual(['h3']);
  });

  it('подпись значения — как ввёл оператор, а отбор нечувствителен к регистру', () => {
    const options = engineFacetOptions(historyRows, {}, 'historyAction');
    const moved = options.find((o) => o.value === 'перемещение в другой цех');
    expect(moved?.label).toBe('Перемещение в другой цех');
  });

  it('дата события отбирается диапазоном', () => {
    expect(ids(applyEngineFacets(historyRows, { historyDate: { from: '2026-09-07' } }))).toEqual(['h2']);
    // Двигатель без событий в отбор по диапазону не попадает.
    expect(ids(applyEngineFacets(historyRows, { historyDate: { from: '2026-01-01' } }))).toEqual(['h1', 'h2']);
  });

  it('история и цех сужают вместе — «кто был в этом цехе и что с ним делали»', () => {
    expect(ids(applyEngineFacets(historyRows, { workshop: ['W1'], historyAction: ['перемещение в другой цех'] }))).toEqual(['h1']);
  });
});

// Этапы работ (15.09.2026): узел последнего этапа — отдельная ступень, потому что ручные
// записи и стадии перебивали бы его в «последнем событии», а вопрос диспетчера — про участок.
const sheetRows = [
  { id: 's1', lastSheetNode: 'Обкатка', lastSheetAt: DAY_09 },
  { id: 's2', lastSheetNode: 'Укладка', lastSheetAt: DAY_05 },
  { id: 's3' },
] as unknown as EngineListItem[];

describe('ступень по узлу этапа работ', () => {
  it('отбирает по узлу без учёта регистра и собирает двигатели без этапов работ отдельно', () => {
    expect(ids(applyEngineFacets(sheetRows, { sheetNode: ['обкатка'] }))).toEqual(['s1']);
    expect(ids(applyEngineFacets(sheetRows, { sheetNode: ['none'] }))).toEqual(['s3']);
    expect(engineFacetOptions(sheetRows, {}, 'sheetNode').find((o) => o.value === 'обкатка')?.label).toBe('Обкатка');
  });

  it('дата этапа работ отбирается диапазоном', () => {
    expect(ids(applyEngineFacets(sheetRows, { sheetDate: { from: '2026-09-07' } }))).toEqual(['s1']);
  });
});

// Владелец 16.09.2026: «в фильтре этапа нет обкатки» — ни один двигатель в ней не стоял, а ряд
// ступени собирался только из строк. Со справочником видов работ ряд полный и в его порядке.
const STAGE_TYPES = [
  { code: 'ukladka', name: 'Укладка', sortOrder: 10 },
  { code: 'sborka', name: 'Сборка', sortOrder: 30 },
  { code: 'obkatka', name: 'Обкатка', sortOrder: 40 },
];
const stageRows = [
  { id: 'f1', arrivalDate: DAY_05, lastSheetNode: 'Укладка', lastSheetTypeCode: 'ukladka', lastSheetAt: DAY_09 },
  { id: 'f2', arrivalDate: DAY_05, lastSheetNode: 'сборка', lastSheetAt: DAY_09 },
  { id: 'f3', arrivalDate: DAY_05 },
] as unknown as EngineListItem[];

describe('ступень «Этап на заводе» со справочником видов работ', () => {
  it('предлагает ВСЕ этапы в порядке от позднего к раннему, пустые — нулём', () => {
    const options = engineFacetOptions(stageRows, {}, 'factoryStage', STAGE_TYPES);
    expect(options.map((o) => o.value)).toEqual([
      'scrap',
      'repaired',
      'sheet:obkatka',
      'sheet:sborka',
      'sheet:ukladka',
      'defect_act',
      'completeness_act',
      'repair_started',
      'arrived',
    ]);
    expect(options.find((o) => o.value === 'sheet:obkatka')).toMatchObject({ label: 'Обкатка', count: 0 });
    expect(options.find((o) => o.value === 'sheet:ukladka')?.count).toBe(1);
  });

  it('этап работ без кода узнаётся по имени и отбирается тем же ключом, что и в отчёте', () => {
    expect(engineFacetOptions(stageRows, {}, 'factoryStage', STAGE_TYPES).find((o) => o.value === 'sheet:sborka')?.count).toBe(1);
    expect(ids(applyEngineFacets(stageRows, { factoryStage: ['sheet:sborka'] }, STAGE_TYPES))).toEqual(['f2']);
  });

  it('вид работ вне справочника не теряется — идёт после ряда', () => {
    const rows = [...stageRows, { id: 'f4', arrivalDate: DAY_05, lastSheetNode: 'Покраска', lastSheetAt: DAY_09 }] as unknown as EngineListItem[];
    const options = engineFacetOptions(rows, {}, 'factoryStage', STAGE_TYPES);
    expect(options[options.length - 1]).toMatchObject({ value: 'sheet:покраска', label: 'Покраска', count: 1 });
  });

  it('ступень «Последний этап работ» тоже сеется справочником видов в его порядке', () => {
    const options = engineFacetOptions(stageRows, {}, 'sheetNode', STAGE_TYPES);
    expect(options.map((o) => o.value)).toEqual(['укладка', 'сборка', 'обкатка', 'none']);
  });

  it('без справочника постоянные этапы всё равно в ряду, этапы работ — по строкам', () => {
    const values = engineFacetOptions(stageRows, {}, 'factoryStage').map((o) => o.value);
    expect(values.slice(0, 6)).toEqual(['scrap', 'repaired', 'defect_act', 'completeness_act', 'repair_started', 'arrived']);
    // Этап работ без кода получает ключ по имени — со справочником он стал бы `sheet:sborka`.
    expect(values.slice(6).sort()).toEqual(['sheet:ukladka', 'sheet:сборка']);
  });
});

// Повторный заезд (владелец 22.09.2026): «чтобы потом в отчётах мы могли разобрать, где старый
// заезд, где новый». Роль заезда строка несёт готовой — ступень её только раскладывает.
const arrivalRows = [
  { id: 'r1', engineNumber: '77', arrival: { role: 'archived', index: 1, total: 2, year: 2025 } },
  { id: 'r2', engineNumber: '77', arrival: { role: 'current', index: 2, total: 2, year: 2026 } },
  { id: 'r3', engineNumber: '78' },
] as unknown as EngineListItem[];

describe('ступень «Заезд»', () => {
  it('отбирает свежий и архивный заезд врозь, а двигатель без заездов — «единственный»', () => {
    expect(engineFacetById('arrival')?.label).toBe('Заезд');
    expect(ids(applyEngineFacets(arrivalRows, { arrival: ['current'] }))).toEqual(['r2']);
    expect(ids(applyEngineFacets(arrivalRows, { arrival: ['archived'] }))).toEqual(['r1']);
    expect(ids(applyEngineFacets(arrivalRows, { arrival: ['single'] }))).toEqual(['r3']);
  });

  it('ряд значений полный и в порядке свежий → архивный → единственный', () => {
    const options = engineFacetOptions(arrivalRows, {}, 'arrival');
    expect(options.map((o) => o.value)).toEqual(['current', 'archived', 'single']);
    expect(options.map((o) => o.label)).toEqual(['свежий', 'архивный', 'единственный']);
    expect(options.map((o) => o.count)).toEqual([1, 1, 1]);
  });
});
