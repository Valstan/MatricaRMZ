import { describe, expect, it } from 'vitest';

import { accountRowsForAccessRows } from './usersSyncPublisherService.js';

type Account = { id: string; login: string };
type Access = { userId: string; sectionId: string };

const ACCOUNTS = new Map<string, Account>([
  ['u1', { id: 'u1', login: 'verify' }],
  ['u2', { id: 'u2', login: 'valstan' }],
]);

describe('accountRowsForAccessRows', () => {
  it('аккаунт едет вместе со своим доступом: иначе клиент не соберёт membership', () => {
    const rows = accountRowsForAccessRows<Account, Access>([{ userId: 'u1', sectionId: 'production' }], ACCOUNTS);
    expect(rows.map((r) => r.id)).toEqual(['u1']);
  });

  it('аккаунт, уже опубликованный в этой же пачке, не дублируется', () => {
    const rows = accountRowsForAccessRows<Account, Access>(
      [{ userId: 'u1', sectionId: 'production' }],
      ACCOUNTS,
      new Set(['u1']),
    );
    expect(rows).toEqual([]);
  });

  it('доступ нескольких людей тянет за собой их аккаунты', () => {
    const rows = accountRowsForAccessRows<Account, Access>(
      [
        { userId: 'u1', sectionId: 'production' },
        { userId: 'u2', sectionId: 'work_orders' },
        { userId: 'u1', sectionId: 'production_program' },
      ],
      ACCOUNTS,
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['u1', 'u2']);
  });

  it('доступ без аккаунта (аккаунта нет в пачке) — везти нечего', () => {
    const rows = accountRowsForAccessRows<Account, Access>([{ userId: 'ghost', sectionId: 'production' }], ACCOUNTS);
    expect(rows).toEqual([]);
  });

  it('пустая пачка доступов не тянет аккаунтов', () => {
    expect(accountRowsForAccessRows<Account, Access>([], ACCOUNTS)).toEqual([]);
  });
});
