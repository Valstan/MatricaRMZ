import { SyncTableName } from '@matricarmz/shared';
import { describe, expect, it, vi } from 'vitest';

import { planDependencyRequeue } from './dependencyRequeue.js';

const skippedOp = (rowId: string, missingId: string, dependency = 'engine_entity') => ({
  table: SyncTableName.Operations,
  row_id: rowId,
  reason: 'missing_dependency',
  dependency,
  missing_id: missingId,
});

describe('planDependencyRequeue', () => {
  it('двигатель есть локально → он возвращается в очередь, наряд остаётся pending', async () => {
    const exists = vi.fn(async () => true);
    const plan = await planDependencyRequeue([skippedOp('op-1', 'eng-1'), skippedOp('op-2', 'eng-1')], exists);
    expect([...plan.requeue.entries()]).toEqual([[SyncTableName.Entities, ['eng-1']]]);
    expect(plan.markError.size).toBe(0);
    // одна зависимость — одна проверка, сколько бы нарядов на неё ни ссылалось
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith(SyncTableName.Entities, 'eng-1');
  });

  it('двигателя нет и локально → наряд помечается error, чтобы выйти из вечного цикла', async () => {
    const plan = await planDependencyRequeue([skippedOp('op-1', 'eng-gone')], async () => false);
    expect(plan.requeue.size).toBe(0);
    expect([...plan.markError.entries()]).toEqual([[SyncTableName.Operations, ['op-1']]]);
  });

  it('зависимость на аккаунт вернуть в очередь нечем → сразу error', async () => {
    const exists = vi.fn(async () => true);
    const plan = await planDependencyRequeue(
      [{ table: SyncTableName.ChatMessages, row_id: 'm-1', reason: 'missing_dependency', dependency: 'recipient_user', missing_id: 'u-1' }],
      exists,
    );
    expect(exists).not.toHaveBeenCalled();
    expect([...plan.markError.entries()]).toEqual([[SyncTableName.ChatMessages, ['m-1']]]);
  });

  it('другие причины пропуска (бронь двигателя и т.п.) не трогает', async () => {
    const plan = await planDependencyRequeue(
      [{ table: SyncTableName.Operations, row_id: 'op-1', reason: 'engine_reserved_by:valstan' }, { table: 'nope', row_id: 'x', reason: 'missing_dependency', dependency: 'entity', missing_id: 'e' }],
      async () => true,
    );
    expect(plan.requeue.size).toBe(0);
    expect(plan.markError.size).toBe(0);
  });

  it('отказ проверки локальной базы читается как «нет» — лучше error, чем бесконечный pending', async () => {
    const plan = await planDependencyRequeue([skippedOp('op-1', 'eng-1', 'entity')], async () => {
      throw new Error('sqlite busy');
    });
    expect([...plan.markError.entries()]).toEqual([[SyncTableName.Operations, ['op-1']]]);
  });
});
