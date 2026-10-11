import { describe, expect, it, vi } from 'vitest';

// M102: строки-аккаунты (`sync_state.client_id` = id пользователя) сливаются
// в строку единственной машины и удаляются; неоднозначные и ничейные —
// удаляются без переноса; машины и служебные строки не трогаются.

vi.mock('../database/db.js', () => ({ db: {}, pool: {} }));

const { planSyncStateAccountMerge } = await import('./mergeSyncStateAccountRows.js');

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-000000000001';
const MACHINE = 'PC99-bbbbbbbb-2222-4222-8222-000000000002';

function base() {
  return {
    syncRows: [
      { clientId: ACCOUNT, lastPushedAt: 100 },
      { clientId: MACHINE, lastPushedAt: 50 },
      { clientId: 'system', lastPushedAt: 10 },
      { clientId: 'ledger-replay', lastPushedAt: 5 },
    ],
    userLoginById: new Map([[ACCOUNT, 'oper1']]),
    machineIdsByLogin: new Map([['oper1', [MACHINE, 'PC98-dead-machine']]]),
  };
}

describe('план слияния строк-аккаунтов', () => {
  it('пусто: нет машин — только удалить нечего', () => {
    const plan = planSyncStateAccountMerge({ syncRows: [], userLoginById: new Map(), machineIdsByLogin: new Map() });
    expect(plan).toEqual({ merge: [], remove: [], kept: [] });
  });

  it('одна машина — слить с переносом pushedAt, служебные оставить', () => {
    const plan = planSyncStateAccountMerge({
      ...base(),
      machineIdsByLogin: new Map([['oper1', [MACHINE]]]),
    });
    expect(plan.merge).toEqual([{ account: ACCOUNT, machine: MACHINE, pushedAt: 100 }]);
    expect(plan.remove).toEqual([]);
    expect(plan.kept).toEqual([MACHINE, 'system', 'ledger-replay']);
  });

  it('машин нет — удалить без переноса', () => {
    const plan = planSyncStateAccountMerge({ ...base(), machineIdsByLogin: new Map() });
    expect(plan.merge).toEqual([]);
    expect(plan.remove).toEqual([{ account: ACCOUNT, reason: 'нет строк машин' }]);
  });

  it('машин несколько — удалить без переноса', () => {
    const machine2 = 'PC98-cccccccc-3333-4333-8333-000000000003';
    const plan = planSyncStateAccountMerge({
      syncRows: [...base().syncRows, { clientId: machine2, lastPushedAt: 20 }],
      userLoginById: new Map([[ACCOUNT, 'oper1']]),
      machineIdsByLogin: new Map([['oper1', [MACHINE, machine2]]]),
    });
    expect(plan.merge).toEqual([]);
    expect(plan.remove).toEqual([{ account: ACCOUNT, reason: 'машин несколько: 2' }]);
  });

  it('машина без своей строки sync_state в слияние не идёт', () => {
    const plan = planSyncStateAccountMerge({
      ...base(),
      syncRows: [
        { clientId: ACCOUNT, lastPushedAt: 100 },
        { clientId: 'system', lastPushedAt: 10 },
      ],
      machineIdsByLogin: new Map([['oper1', ['PC98-ghost']]]),
    });
    expect(plan.merge).toEqual([]);
    expect(plan.remove).toEqual([{ account: ACCOUNT, reason: 'нет строк машин' }]);
  });

  it('ничейный uuid — удалить, машины и служебные не трогать', () => {
    const plan = planSyncStateAccountMerge({
      syncRows: [
        { clientId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', lastPushedAt: 7 },
        { clientId: MACHINE, lastPushedAt: 50 },
      ],
      userLoginById: new Map(),
      machineIdsByLogin: new Map(),
    });
    expect(plan.merge).toEqual([]);
    expect(plan.remove).toEqual([{ account: 'ffffffff-ffff-4fff-8fff-ffffffffffff', reason: 'ничейный uuid (нет в users)' }]);
    expect(plan.kept).toEqual([MACHINE]);
  });

  it('совпадение логина — без учёта регистра', () => {
    const plan = planSyncStateAccountMerge({
      ...base(),
      userLoginById: new Map([[ACCOUNT, 'Oper1']]),
      machineIdsByLogin: new Map([['oper1', [MACHINE]]]),
    });
    expect(plan.merge).toHaveLength(1);
  });
});
