import { describe, expect, it } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

import { budgetForTable, operationsReserve } from './pushBudget.js';

/**
 * Приоритет таблиц в бюджете push (план #114, шаг 27).
 *
 * До правки первые четыре таблицы забирали весь бюджет (1200 строк), и пачка
 * `operations` не собиралась ВООБЩЕ — без единой ошибки. Строка (в т.ч. история
 * ремонта, введённая с планшета) висела `pending` вечно.
 */
const MAX_TOTAL = 1200;
const PER_TABLE: Partial<Record<SyncTableName, number>> = {
  [SyncTableName.EntityTypes]: 1000,
  [SyncTableName.Entities]: 200,
  [SyncTableName.AttributeDefs]: 1000,
  [SyncTableName.AttributeValues]: 500,
  [SyncTableName.Operations]: 500,
};

/** Сбор пачки по порядку таблиц — как в `collectPending`. */
function collect(pending: Partial<Record<SyncTableName, number>>, reserve: number) {
  const order: SyncTableName[] = [
    SyncTableName.EntityTypes,
    SyncTableName.Entities,
    SyncTableName.AttributeDefs,
    SyncTableName.AttributeValues,
    SyncTableName.Operations,
  ];
  let total = 0;
  const taken: Partial<Record<SyncTableName, number>> = {};
  for (const table of order) {
    const want = pending[table] ?? 0;
    const per = PER_TABLE[table] ?? MAX_TOTAL;
    const remaining = budgetForTable(table, reserve, MAX_TOTAL) - total;
    const take = Math.max(0, Math.min(want, per, remaining));
    taken[table] = take;
    total += take;
  }
  return { taken, total };
}

describe('operations не вытесняется бюджетом push', () => {
  it('без резерва operations вытесняется первыми таблицами (прежнее поведение)', () => {
    const reserve = operationsReserve(0, PER_TABLE[SyncTableName.Operations]!);
    const { taken } = collect(
      {
        [SyncTableName.EntityTypes]: 1000,
        [SyncTableName.Entities]: 200,
        [SyncTableName.AttributeDefs]: 1000,
        [SyncTableName.AttributeValues]: 500,
        [SyncTableName.Operations]: 50,
      },
      reserve,
    );
    expect(taken[SyncTableName.Operations]).toBe(0);
  });

  it('с резервом operations собирается даже при забитых первых таблицах', () => {
    const reserve = operationsReserve(50, PER_TABLE[SyncTableName.Operations]!);
    const { taken } = collect(
      {
        [SyncTableName.EntityTypes]: 1000,
        [SyncTableName.Entities]: 200,
        [SyncTableName.AttributeDefs]: 1000,
        [SyncTableName.AttributeValues]: 500,
        [SyncTableName.Operations]: 50,
      },
      reserve,
    );
    expect(taken[SyncTableName.Operations]).toBe(50);
  });

  it('резерв не превышает лимит таблицы и не бывает отрицательным', () => {
    expect(operationsReserve(10_000, 500)).toBe(500);
    expect(operationsReserve(-5, 500)).toBe(0);
    expect(operationsReserve(0, 500)).toBe(0);
  });

  it('без pending operations бюджет других таблиц не режется', () => {
    const reserve = operationsReserve(0, 500);
    expect(budgetForTable(SyncTableName.EntityTypes, reserve, MAX_TOTAL)).toBe(MAX_TOTAL);
    expect(budgetForTable(SyncTableName.Operations, reserve, MAX_TOTAL)).toBe(MAX_TOTAL);
  });
});
