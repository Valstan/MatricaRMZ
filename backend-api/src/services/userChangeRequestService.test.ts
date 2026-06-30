import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  inserted: [] as any[],
  updatedSets: [] as any[],
  selectRows: [] as any[],
}));

vi.mock('../database/db.js', () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(async (v: any) => { state.inserted.push(v); }) })),
    update: vi.fn(() => ({
      set: vi.fn((s: any) => ({ where: vi.fn(async () => { state.updatedSets.push(s); return { rowCount: 1 }; }) })),
    })),
    select: vi.fn(() => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (v: any[]) => any) => Promise.resolve(state.selectRows).then(resolve),
      };
      return chain;
    }),
  },
}));

const {
  submitUserChangeRequest,
  listPendingUserChangeRequests,
  getUserChangeRequest,
  markUserChangeRequestDecided,
  USER_CHANGE_PENDING_MESSAGE,
} = await import('./userChangeRequestService.js');

beforeEach(() => {
  state.inserted = [];
  state.updatedSets = [];
  state.selectRows = [];
});

describe('userChangeRequestService', () => {
  it('submit stores a pending admin_user request and returns the owner message (no plaintext password)', async () => {
    const r = await submitUserChangeRequest({
      actor: { id: 'admin-1', username: 'hr' },
      rowId: 'new-emp',
      payload: { kind: 'create', data: { login: 'ivanov', passwordHash: 'HASH', role: 'user', accessEnabled: false } },
    });
    expect(r.ok).toBe(true);
    expect(r.message).toBe(USER_CHANGE_PENDING_MESSAGE);

    const row = state.inserted[0];
    expect(row.tableName).toBe('admin_user');
    expect(row.status).toBe('pending');
    expect(row.rowId).toBe('new-emp');
    expect(row.changeAuthorUserId).toBe('admin-1');
    expect(row.changeAuthorUsername).toBe('hr');
    const payload = JSON.parse(row.afterJson);
    expect(payload.kind).toBe('create');
    expect(payload.data.passwordHash).toBe('HASH');
    expect(payload.data).not.toHaveProperty('password'); // never queue plaintext
  });

  it('list/get parse the stored payload back', async () => {
    state.selectRows = [
      {
        id: 'r1',
        status: 'pending',
        rowId: 'emp-9',
        afterJson: JSON.stringify({ kind: 'update', data: { fullName: 'Иванов И.И.' } }),
        beforeJson: null,
        changeAuthorUserId: 'admin-1',
        changeAuthorUsername: 'hr',
        note: null,
        createdAt: 123,
      },
    ];
    const list = await listPendingUserChangeRequests();
    expect(list).toHaveLength(1);
    expect(list[0]?.payload?.kind).toBe('update');
    expect(list[0]?.payload?.data['fullName']).toBe('Иванов И.И.');

    const one = await getUserChangeRequest('r1');
    expect(one?.id).toBe('r1');
    expect(one?.rowId).toBe('emp-9');
  });

  it('markDecided records status + approver', async () => {
    await markUserChangeRequestDecided({ id: 'r1', status: 'applied', approver: { id: 'super', username: 'root' } });
    const set = state.updatedSets[0];
    expect(set.status).toBe('applied');
    expect(set.decidedByUserId).toBe('super');
    expect(set.decidedByUsername).toBe('root');
  });
});
