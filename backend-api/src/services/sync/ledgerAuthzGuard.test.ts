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
