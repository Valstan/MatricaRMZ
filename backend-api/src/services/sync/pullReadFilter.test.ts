import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ selectByTable: new Map<unknown, any[][]>() }));

vi.mock('../../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((t: unknown) => {
          currentTable = t;
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

const { entityTypes, attributeDefs } = await import('../../database/schema.js');
const { makePullReadFilter, isPullTableAllowedForRole, resetPullReadFilterCache } = await import('./pullReadFilter.js');
const { getEffectivePermissionsForUser } = await import('../../auth/permissions.js');

vi.mock('../../auth/permissions.js', () => ({
  getEffectivePermissionsForUser: vi.fn(async () => ({}) as Record<string, boolean>),
}));

const ATTRS = 'attribute_values';
const ENTITIES = 'entities';
const AUDIT = 'audit_log';
const CHILDREN = 'erp_employee_children';

function seed() {
  state.selectByTable.set(entityTypes, [[{ id: 't-emp' }]]);
  state.selectByTable.set(attributeDefs, [
    [
      { id: 'd-salary', code: 'salary', name: 'Зарплата' }, // PII restricted
      { id: 'd-passport', code: 'passport_number', name: 'Паспорт' }, // PII restricted
      { id: 'd-birth', code: 'birth_date', name: 'Дата рождения' }, // HR restricted
      { id: 'd-term', code: 'termination_date', name: 'Дата увольнения' }, // KEPT (roster authority)
      { id: 'd-status', code: 'employment_status', name: 'Статус занятости' }, // KEPT
      { id: 'd-login', code: 'login', name: 'Логин' }, // KEPT (ФИО resolution)
      { id: 'd-name', code: 'full_name', name: 'ФИО' }, // KEPT
      { id: 'd-role', code: 'system_role', name: 'Системная роль' }, // KEPT (deferred)
      { id: 'd-pwd', code: 'password_hash', name: 'Пароль (хэш)' }, // credential — drop all
    ],
  ]);
}

beforeEach(() => {
  state.selectByTable.clear();
  resetPullReadFilterCache();
  seed();
});

describe('makePullReadFilter — operator', () => {
  it('drops credentials for everyone, hides PII/HR of others, keeps own + operational', async () => {
    const f = await makePullReadFilter({ id: 'self', role: 'engineer' });

    // credential — dropped even for the operator's OWN record
    expect(f(ATTRS, { attribute_def_id: 'd-pwd', entity_id: 'self' })).toBe(false);
    expect(f(ATTRS, { attribute_def_id: 'd-pwd', entity_id: 'other' })).toBe(false);

    // sensitive PII + HR of another employee -> hidden
    for (const def of ['d-salary', 'd-passport', 'd-birth']) {
      expect(f(ATTRS, { attribute_def_id: def, entity_id: 'other' }), def).toBe(false);
    }
    // own PII/HR -> visible
    expect(f(ATTRS, { attribute_def_id: 'd-salary', entity_id: 'self' })).toBe(true);
    expect(f(ATTRS, { attribute_def_id: 'd-birth', entity_id: 'self' })).toBe(true);

    // deliberately-kept fields of anyone -> visible (termination_date is the
    // authoritative roster "fired" signal; login/status/name/role kept)
    for (const def of ['d-term', 'd-status', 'd-login', 'd-name', 'd-role']) {
      expect(f(ATTRS, { attribute_def_id: def, entity_id: 'other' }), def).toBe(true);
    }

    // audit_log: оператор видит СВОИ журнальные строки (решение владельца 26.11.2026),
    // чужие — нет. Правило повторено в syncPrivacy.ts (там оно ещё и в SQL).
    const fAudit = await makePullReadFilter({ id: 'self', role: 'engineer', username: 'me-login' });
    expect(fAudit(AUDIT, { id: 'a1', actor: 'me-login' })).toBe(true);
    expect(fAudit(AUDIT, { id: 'a2', actor: 'other-login' })).toBe(false);
    expect(f(ENTITIES, { id: 'x' })).toBe(true);
  });
});

describe('makePullReadFilter — legacy `user` (non-operator, full PII as before)', () => {
  it('keeps others’ PII/HR (no operator clamp) but still drops credentials', async () => {
    const f = await makePullReadFilter({ id: 'u', role: 'user' });
    expect(f(ATTRS, { attribute_def_id: 'd-salary', entity_id: 'other' })).toBe(true);
    expect(f(ATTRS, { attribute_def_id: 'd-birth', entity_id: 'other' })).toBe(true);
    expect(f(ATTRS, { attribute_def_id: 'd-pwd', entity_id: 'other' })).toBe(false); // credential
    // Журнал — по логину автора: свои строки видны, чужие нет.
    const fAudit = await makePullReadFilter({ id: 'u', role: 'user', username: 'u-login' });
    expect(fAudit(AUDIT, { id: 'a1', actor: 'u-login' })).toBe(true);
    expect(fAudit(AUDIT, { id: 'a2', actor: 'other-login' })).toBe(false);
  });
});

describe('makePullReadFilter — admin', () => {
  it('keeps PII/HR and audit_log, but still drops credentials', async () => {
    const f = await makePullReadFilter({ id: 'admin-id', role: 'superadmin' });
    expect(f(ATTRS, { attribute_def_id: 'd-salary', entity_id: 'other' })).toBe(true);
    expect(f(ATTRS, { attribute_def_id: 'd-birth', entity_id: 'other' })).toBe(true);
    expect(f(AUDIT, { id: 'a1' })).toBe(true);
    expect(f(ATTRS, { attribute_def_id: 'd-pwd', entity_id: 'other' })).toBe(false); // credential
  });
});

describe('makePullReadFilter — карточки детей (владелец 21.11.2026)', () => {
  it('строки детей не едут в реплику тому, у кого нет права children.view', async () => {
    vi.mocked(getEffectivePermissionsForUser).mockResolvedValue({});
    const f = await makePullReadFilter({ id: 'self', role: 'engineer' });
    expect(f(CHILDREN, { id: 'c1' })).toBe(false);
    // Остальные таблицы детьми не затронуты.
    expect(f(ENTITIES, { id: 'x' })).toBe(true);
  });

  it('суперадмину и хозяину модуля строки детей видны', async () => {
    vi.mocked(getEffectivePermissionsForUser).mockResolvedValue({ 'children.view': true });
    const f = await makePullReadFilter({ id: 'owner', role: 'supply' });
    expect(f(CHILDREN, { id: 'c1' })).toBe(true);
  });
});

describe('isPullTableAllowedForRole', () => {
  it('таблиц «целиком только админу» больше нет: журнал оператору виден своими строками', () => {
    // Правило журнала — в syncPrivacy.ts (PRIVACY_TABLES), а не в пропуске таблицы:
    // иначе операторский клиент никогда не получал бы свои строки обратно
    // (инцидент 26.11.2026).
    for (const role of ['engineer', 'user', 'pending', 'employee', 'admin', 'superadmin']) {
      expect(isPullTableAllowedForRole(AUDIT, role), role).toBe(true);
      expect(isPullTableAllowedForRole(ATTRS, role), role).toBe(true);
      expect(isPullTableAllowedForRole(ENTITIES, role), role).toBe(true);
    }
  });
});
