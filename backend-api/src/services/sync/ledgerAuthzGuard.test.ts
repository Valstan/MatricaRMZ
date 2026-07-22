import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operatorRolePermissions } from '@matricarmz/shared';

// Table-aware in-memory db mock: queue rows per table; select().from(t).where(...) drains it.
const state = vi.hoisted(() => ({ selectByTable: new Map<unknown, any[][]>() }));

vi.mock('../../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
  };
  return { db };
});

// Engineer effective perms (real preset). actorId === 'emp-self'.
vi.mock('../../auth/permissions.js', () => ({
  getEffectivePermissionsForUser: vi.fn(async () => operatorRolePermissions('engineer')!),
}));

// Advisory engine reservations: the guard's own db reads are covered by its own
// tests; here we drive the gate directly.
const reservationState = vi.hoisted(() => ({ live: new Map<string, unknown>() }));
vi.mock('../engineReservationGuard.js', () => ({
  getLiveEngineReservations: vi.fn(async (ids: string[]) => {
    const out = new Map<string, unknown>();
    for (const id of ids) {
      const r = reservationState.live.get(id);
      if (r) out.set(id, r);
    }
    return out;
  }),
  invalidateEngineReservationCache: vi.fn(),
  readEngineReservations: vi.fn(async () => new Map()),
}));

const { attributeDefs, entities, entityTypes } = await import('../../database/schema.js');
const { partitionLedgerInputsByAuthz } = await import('./ledgerAuthzGuard.js');

function seedTypes() {
  state.selectByTable.set(entityTypes, [
    [
      { id: 't-engine', code: 'engine' },
      { id: 't-contract', code: 'contract' },
      { id: 't-employee', code: 'employee' },
    ],
  ]);
}
function seedEntities(rows: Array<{ id: string; entityTypeId: string }>) {
  state.selectByTable.set(entities, [rows]);
}
function seedDefs(rows: Array<{ id: string; code: string }>) {
  state.selectByTable.set(attributeDefs, [rows]);
}

const ENGINEER = { id: 'emp-self', username: 'eng', role: 'engineer' };

beforeEach(() => {
  state.selectByTable.clear();
  reservationState.live.clear();
  delete process.env.MATRICA_ENGINE_RESERVATION_GATE;
});

describe('partitionLedgerInputsByAuthz', () => {
  it('engineer: own area allowed, contract denied, own employee allowed, other employee denied', async () => {
    seedTypes();
    seedEntities([
      { id: 'emp-self', entityTypeId: 't-employee' },
      { id: 'emp-other', entityTypeId: 't-employee' },
    ]);

    const inputs = [
      { type: 'upsert' as const, table: 'entities', row: { id: 'e1', entity_type_id: 't-engine' }, row_id: 'e1' },
      { type: 'upsert' as const, table: 'entities', row: { id: 'c1', entity_type_id: 't-contract' }, row_id: 'c1' },
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a1', entity_id: 'emp-self' }, row_id: 'a1' },
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a2', entity_id: 'emp-other' }, row_id: 'a2' },
    ];

    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);

    expect(allowed.map((i) => i.row_id).sort()).toEqual(['a1', 'e1']);
    expect(denied.map((d) => d.row_id).sort()).toEqual(['a2', 'c1']);
    expect(denied.find((d) => d.row_id === 'c1')?.reason).toBe('forbidden:contract');
    expect(denied.find((d) => d.row_id === 'a2')?.reason).toBe('forbidden:employee');
  });

  it('resolves a new entity created in the SAME batch (not yet in DB)', async () => {
    seedTypes();
    seedEntities([]); // emp-other not needed; the contract entity is created in-batch
    const inputs = [
      { type: 'upsert' as const, table: 'entities', row: { id: 'c2', entity_type_id: 't-contract' }, row_id: 'c2' },
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a3', entity_id: 'c2' }, row_id: 'a3' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);
    expect(allowed).toHaveLength(0);
    expect(denied.map((d) => d.row_id).sort()).toEqual(['a3', 'c2']);
    expect(denied.every((d) => d.reason === 'forbidden:contract')).toBe(true);
  });

  it('non-operator roles are not operator-scoped (non-security writes allowed)', async () => {
    seedTypes();
    for (const role of ['user', 'admin', 'superadmin']) {
      const inputs = [
        { type: 'upsert' as const, table: 'entities', row: { id: 'c1', entity_type_id: 't-contract' }, row_id: 'c1' },
      ];
      const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, { id: 'u', username: 'u', role });
      expect(allowed, role).toHaveLength(1);
      expect(denied, role).toHaveLength(0);
      state.selectByTable.clear();
      seedTypes();
    }
  });

  // C2 backstop: server-managed employee auth attrs are never writable via a
  // client ledger tx, regardless of role (closes the own_employee → set own
  // system_role=superadmin escalation, and the legacy-user bypass of it).
  it('operator: own employee system_role DENIED (backstop), own profile attr allowed', async () => {
    seedTypes();
    seedEntities([{ id: 'emp-self', entityTypeId: 't-employee' }]);
    seedDefs([
      { id: 'def-role', code: 'system_role' },
      { id: 'def-name', code: 'full_name' },
    ]);

    const inputs = [
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a1', entity_id: 'emp-self', attribute_def_id: 'def-role' }, row_id: 'a1' },
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a2', entity_id: 'emp-self', attribute_def_id: 'def-name' }, row_id: 'a2' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);

    expect(allowed.map((i) => i.row_id)).toEqual(['a2']);
    expect(denied.map((d) => d.row_id)).toEqual(['a1']);
    expect(denied[0]?.reason).toBe('forbidden:employee_auth_attr:system_role');
  });

  it('legacy non-operator role: backstop still DENIES system_role on ANOTHER employee, but allows a non-security attr', async () => {
    seedTypes();
    seedEntities([{ id: 'emp-other', entityTypeId: 't-employee' }]);
    seedDefs([
      { id: 'def-role', code: 'system_role' },
      { id: 'def-name', code: 'full_name' },
    ]);

    const inputs = [
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a1', entity_id: 'emp-other', attribute_def_id: 'def-role' }, row_id: 'a1' },
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a2', entity_id: 'emp-other', attribute_def_id: 'def-name' }, row_id: 'a2' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, { id: 'attacker', username: 'u', role: 'user' });

    expect(denied.map((d) => d.row_id)).toEqual(['a1']);
    expect(denied[0]?.reason).toBe('forbidden:employee_auth_attr:system_role');
    expect(allowed.map((i) => i.row_id)).toEqual(['a2']);
  });
});

// Ф3: section viewer write-gate. Membership rows are loaded via restrictedWorkOrders
// (attributeDefs + attributeValues selects, drained AFTER the codeByDefId select).
const { __clearRestrictedPolicyCache } = await import('./restrictedWorkOrders.js');

function pushQueue(table: unknown, rows: any[]) {
  const q = state.selectByTable.get(table) ?? [];
  q.push(rows);
  state.selectByTable.set(table, q);
}

function seedMembership(rows: Array<{ login: string; membership: object }>) {
  pushQueue(attributeDefs, [
    { id: 'def-login', code: 'login' },
    { id: 'def-sa', code: 'section_access' },
  ]);
  const vals: any[] = [];
  let i = 0;
  for (const r of rows) {
    const eid = `emp-m${i++}`;
    vals.push({ entityId: eid, defId: 'def-login', v: JSON.stringify(r.login) });
    vals.push({ entityId: eid, defId: 'def-sa', v: JSON.stringify(r.membership) });
  }
  return vals;
}

const { attributeValues } = await import('../../database/schema.js');

describe('section viewer write-gate (Ф3)', () => {
  beforeEach(() => {
    __clearRestrictedPolicyCache();
  });

  it('seeded viewer of production: engine write DENIED; unmapped type still allowed', async () => {
    seedTypes();
    const vals = seedMembership([{ login: 'eng', membership: { production: 'viewer' } }]);
    pushQueue(attributeValues, vals);

    const inputs = [
      { type: 'upsert' as const, table: 'entities', row: { id: 'e1', entity_type_id: 't-engine' }, row_id: 'e1' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);
    expect(allowed).toHaveLength(0);
    expect(denied[0]?.reason).toBe('forbidden:section_viewer:production');
  });

  it('seeded editor of production: engine write allowed', async () => {
    seedTypes();
    const vals = seedMembership([{ login: 'eng', membership: { production: 'editor' } }]);
    pushQueue(attributeValues, vals);

    const inputs = [
      { type: 'upsert' as const, table: 'entities', row: { id: 'e1', entity_type_id: 't-engine' }, row_id: 'e1' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);
    expect(allowed).toHaveLength(1);
    expect(denied).toHaveLength(0);
  });

  it('legacy `user` role does NOT bypass the seeded gate (contracts viewer → contract write denied)', async () => {
    seedTypes();
    const vals = seedMembership([{ login: 'u', membership: { contracts: 'viewer' } }]);
    pushQueue(attributeValues, vals);

    const inputs = [
      { type: 'upsert' as const, table: 'entities', row: { id: 'c1', entity_type_id: 't-contract' }, row_id: 'c1' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, { id: 'u', username: 'u', role: 'user' });
    expect(allowed).toHaveLength(0);
    expect(denied[0]?.reason).toBe('forbidden:section_viewer:contracts');
  });

  it('own employee record stays writable for a people-viewer (self-service parity)', async () => {
    seedTypes();
    seedEntities([{ id: 'emp-self', entityTypeId: 't-employee' }]);
    seedDefs([{ id: 'def-name', code: 'full_name' }]);
    const vals = seedMembership([{ login: 'eng', membership: { people: 'viewer', production: 'editor' } }]);
    pushQueue(attributeValues, vals);

    const inputs = [
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a1', entity_id: 'emp-self', attribute_def_id: 'def-name' }, row_id: 'a1' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);
    expect(allowed.map((i) => i.row_id)).toEqual(['a1']);
    expect(denied).toHaveLength(0);
  });

  it('unseeded membership → fail-open (day-one safety)', async () => {
    seedTypes();
    // no membership rows queued → loads drain empty
    const inputs = [
      { type: 'upsert' as const, table: 'entities', row: { id: 'e1', entity_type_id: 't-engine' }, row_id: 'e1' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);
    expect(allowed).toHaveLength(1);
    expect(denied).toHaveLength(0);
  });
});

describe('advisory engine reservation gate (Ф2)', () => {
  const NOW = Date.now();
  const OTHER_HOLDER = {
    v: 1,
    holderUserId: 'emp-other',
    holderLogin: 'ivanov',
    holderFullName: 'Иванов Иван',
    startedAt: NOW - 60 * 60 * 1000,
    expiresAt: NOW + 6 * 60 * 60 * 1000,
    releasedAt: null,
    releasedBy: null,
  };

  it('чужой замок режет свежие правки двигателя, но не чужую сущность в том же батче', async () => {
    seedTypes();
    seedEntities([{ id: 'eng-1', entityTypeId: 't-engine' }]);
    seedDefs([{ id: 'def-num', code: 'engine_number' }]);
    reservationState.live.set('eng-1', OTHER_HOLDER);

    const inputs = [
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a1', entity_id: 'eng-1', attribute_def_id: 'def-num', updated_at: NOW }, row_id: 'a1' },
      { type: 'upsert' as const, table: 'entities', row: { id: 'eng-2', entity_type_id: 't-engine', updated_at: NOW }, row_id: 'eng-2' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);

    expect(allowed.map((i) => i.row_id)).toEqual(['eng-2']);
    expect(denied.map((d) => d.row_id)).toEqual(['a1']);
    expect(denied[0]?.reason).toBe(`reserved:ivanov:${OTHER_HOLDER.expiresAt}`);
  });

  it('оффлайн-правка, сделанная ДО взятия замка, проходит (pre-lock grace)', async () => {
    seedTypes();
    seedEntities([{ id: 'eng-1', entityTypeId: 't-engine' }]);
    seedDefs([{ id: 'def-num', code: 'engine_number' }]);
    reservationState.live.set('eng-1', OTHER_HOLDER);

    const inputs = [
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a1', entity_id: 'eng-1', attribute_def_id: 'def-num', updated_at: OTHER_HOLDER.startedAt - 7 * 24 * 60 * 60 * 1000 }, row_id: 'a1' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);

    expect(allowed.map((i) => i.row_id)).toEqual(['a1']);
    expect(denied).toHaveLength(0);
  });

  it('держателя собственный замок не режет', async () => {
    seedTypes();
    seedEntities([{ id: 'eng-1', entityTypeId: 't-engine' }]);
    seedDefs([{ id: 'def-num', code: 'engine_number' }]);
    reservationState.live.set('eng-1', { ...OTHER_HOLDER, holderUserId: 'emp-self' });

    const inputs = [
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a1', entity_id: 'eng-1', attribute_def_id: 'def-num', updated_at: NOW }, row_id: 'a1' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);
    expect(allowed.map((i) => i.row_id)).toEqual(['a1']);
    expect(denied).toHaveLength(0);
  });

  it('гейтятся только операции карточки двигателя: наряд мастера проходит, дефектовка режется', async () => {
    seedTypes();
    seedEntities([{ id: 'eng-1', entityTypeId: 't-engine' }]);
    reservationState.live.set('eng-1', OTHER_HOLDER);

    const inputs = [
      { type: 'upsert' as const, table: 'operations', row: { id: 'op-wo', operation_type: 'work_order', engine_entity_id: 'eng-1', updated_at: NOW }, row_id: 'op-wo' },
      { type: 'upsert' as const, table: 'operations', row: { id: 'op-def', operation_type: 'defect', engine_entity_id: 'eng-1', updated_at: NOW }, row_id: 'op-def' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);

    expect(allowed.map((i) => i.row_id)).toEqual(['op-wo']);
    expect(denied.map((d) => d.row_id)).toEqual(['op-def']);
  });

  it('админ проходит замок, а kill-switch выключает гейт целиком', async () => {
    seedTypes();
    seedEntities([{ id: 'eng-1', entityTypeId: 't-engine' }]);
    seedDefs([{ id: 'def-num', code: 'engine_number' }]);
    reservationState.live.set('eng-1', OTHER_HOLDER);
    const row = { id: 'a1', entity_id: 'eng-1', attribute_def_id: 'def-num', updated_at: NOW };

    const asAdmin = await partitionLedgerInputsByAuthz(
      [{ type: 'upsert' as const, table: 'attribute_values', row, row_id: 'a1' }] as any,
      { id: 'adm', username: 'adm', role: 'admin' },
    );
    expect(asAdmin.allowed.map((i) => i.row_id)).toEqual(['a1']);

    state.selectByTable.clear();
    seedTypes();
    seedEntities([{ id: 'eng-1', entityTypeId: 't-engine' }]);
    seedDefs([{ id: 'def-num', code: 'engine_number' }]);
    process.env.MATRICA_ENGINE_RESERVATION_GATE = 'off';
    const off = await partitionLedgerInputsByAuthz(
      [{ type: 'upsert' as const, table: 'attribute_values', row, row_id: 'a1' }] as any,
      ENGINEER,
    );
    expect(off.allowed.map((i) => i.row_id)).toEqual(['a1']);
    expect(off.denied).toHaveLength(0);
  });

  it('backstop не обходится подложным attribute_def из ТОГО ЖЕ батча', async () => {
    seedTypes();
    seedEntities([{ id: 'eng-1', entityTypeId: 't-engine' }]);
    seedDefs([]); // подложного def'а в БД ещё нет — он приехал этим же батчем

    const inputs = [
      { type: 'upsert' as const, table: 'attribute_defs', row: { id: 'def-fake', code: 'engine_reservation', entity_type_id: 't-engine' }, row_id: 'def-fake' },
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a1', entity_id: 'eng-1', attribute_def_id: 'def-fake', updated_at: NOW }, row_id: 'a1' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, ENGINEER);

    expect(denied.map((d) => d.row_id)).toContain('a1');
    expect(denied.find((d) => d.row_id === 'a1')?.reason).toBe('forbidden:server_managed_attr:engine_reservation');
    expect(allowed.map((i) => i.row_id)).not.toContain('a1');
  });

  it('сам атрибут резерва не пишется клиентом ни при какой роли (server-managed backstop)', async () => {
    seedTypes();
    seedEntities([{ id: 'eng-1', entityTypeId: 't-engine' }]);
    seedDefs([{ id: 'def-res', code: 'engine_reservation' }]);

    const inputs = [
      { type: 'upsert' as const, table: 'attribute_values', row: { id: 'a1', entity_id: 'eng-1', attribute_def_id: 'def-res', updated_at: NOW }, row_id: 'a1' },
    ];
    const { allowed, denied } = await partitionLedgerInputsByAuthz(inputs as any, { id: 'adm', username: 'adm', role: 'superadmin' });

    expect(allowed).toHaveLength(0);
    expect(denied[0]?.reason).toBe('forbidden:server_managed_attr:engine_reservation');
  });
});
