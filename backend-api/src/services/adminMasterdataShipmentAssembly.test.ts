import { beforeEach, describe, expect, it, vi } from 'vitest';

// Гейт отгрузки «Отправлен заказчику ↔ открытый сборочный наряд» стоит только
// в UI-карточке двигателя. Не-UI пути (sync-push старых клиентов, web-admin,
// скрипты) его обходят — жёсткий блок невозможен (offline-first уже закоммитил),
// поэтому сервер пишет warning-запись в журнал рядом с `recordEngineStatusAudit`.

const state = vi.hoisted(() => ({
  selectByTable: new Map<unknown, any[][]>(),
  changes: [] as any[],
}));

vi.mock('../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) })) })),
  };
  return { db };
});

vi.mock('./sync/syncChangeService.js', () => ({
  recordSyncChanges: vi.fn(async (_actor: unknown, changes: unknown[]) => {
    state.changes.push(changes);
  }),
}));

const { attributeDefs, attributeValues, entities, entityTypes, operations, rowOwners } = await import(
  '../database/schema.js'
);
const { listOpenAssemblyWorkOrdersForEngine, setEntityAttribute } = await import('./adminMasterdataService.js');

const ACTOR = { id: 'u1', username: 'test-admin', role: 'admin' };
const ENGINE = 'eeeeeeee-0000-0000-0000-000000000001';
const OTHER_ENGINE = 'eeeeeeee-0000-0000-0000-000000000002';
const ENGINE_TYPE = 'bbbbbbbb-0000-0000-0000-000000000002';
const DEF_SENT = 'dddddddd-0000-0000-0000-000000000003';
const DAY = 86_400_000;

const sentDef = () => [{ id: DEF_SENT, code: 'status_customer_sent', dataType: 'boolean' }];

function woRow(id: string, meta: Record<string, unknown>, status = 'open', extra: Record<string, unknown> = {}) {
  return { id, status, metaJson: JSON.stringify(meta), createdAt: 1, updatedAt: 2, deletedAt: null, ...extra };
}

function assemblyMeta(engineId: string, n = 7) {
  return {
    kind: 'work_order',
    workOrderKind: 'assembly',
    assemblyEngineId: engineId,
    workOrderNumber: n,
    orderDate: 1_000,
    dueDate: Date.now() + 30 * DAY,
  };
}

function seedEngineFlagPath(existing: any[]) {
  state.selectByTable.set(entities, [[{ id: ENGINE, typeId: ENGINE_TYPE, createdAt: 1, updatedAt: 1, deletedAt: null }]]);
  state.selectByTable.set(attributeDefs, [sentDef(), sentDef()]);
  state.selectByTable.set(attributeValues, [existing]);
  state.selectByTable.set(rowOwners, [[]]);
  state.selectByTable.set(entityTypes, [[{ code: 'engine' }]]);
}

function shipmentAudits() {
  return state.changes
    .flat()
    .filter((c: any) => c?.payload?.action === 'engine_shipment_with_open_assembly')
    .map((c: any) => String(c?.payload?.payload_json ?? ''));
}

beforeEach(() => {
  state.selectByTable.clear();
  state.changes.length = 0;
});

describe('скан открытых сборочных нарядов двигателя', () => {
  it('возвращает только действующий сборочный наряд этого двигателя', async () => {
    state.selectByTable.set(operations, [
      [
        woRow('wo-open', assemblyMeta(ENGINE, 7)),
        woRow('wo-closed', assemblyMeta(ENGINE, 5), 'closed'),
        woRow('wo-regular', { ...assemblyMeta(ENGINE, 3), workOrderKind: 'regular' }),
        woRow('wo-alien', assemblyMeta(OTHER_ENGINE, 9)),
      ],
    ]);
    const rows = await listOpenAssemblyWorkOrdersForEngine(ENGINE);
    expect(rows.map((r) => r.id)).toEqual(['wo-open']);
    expect(rows[0]).toMatchObject({ workOrderNumber: 7, statusCode: 'issued' });
  });

  it('пустой двигатель — пустой список без запросов в никуда', async () => {
    state.selectByTable.set(operations, [[woRow('wo-open', assemblyMeta(ENGINE, 7))]]);
    expect(await listOpenAssemblyWorkOrdersForEngine('')).toEqual([]);
    expect(await listOpenAssemblyWorkOrdersForEngine(OTHER_ENGINE)).toEqual([]);
  });
});

describe('аудит отгрузки при открытом сборочном наряде', () => {
  it('галка вверх при открытом наряде пишет warning-запись с номером наряда', async () => {
    seedEngineFlagPath([]);
    state.selectByTable.set(operations, [[woRow('wo-open', assemblyMeta(ENGINE, 7))]]);
    const r = await setEntityAttribute(ACTOR, ENGINE, 'status_customer_sent', true);
    expect(r.ok).toBe(true);
    const audits = shipmentAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toContain('wo-open');
    // Обычный аудит статуса при этом пишется как раньше — запись рядом, а не вместо.
    expect(state.changes.flat().some((c: any) => c?.payload?.action === 'engine_status_change')).toBe(true);
  });

  it('снятие галки аудита отгрузки не даёт', async () => {
    seedEngineFlagPath([{ id: 'aaaaaaaa-1111-4111-8111-000000000001', valueJson: 'true', createdAt: 1, deletedAt: null }]);
    state.selectByTable.set(operations, [[woRow('wo-open', assemblyMeta(ENGINE, 7))]]);
    const r = await setEntityAttribute(ACTOR, ENGINE, 'status_customer_sent', false);
    expect(r.ok).toBe(true);
    expect(shipmentAudits()).toHaveLength(0);
  });

  it('галка вверх без открытых нарядов — тихо, без записи', async () => {
    seedEngineFlagPath([]);
    state.selectByTable.set(operations, [[]]);
    const r = await setEntityAttribute(ACTOR, ENGINE, 'status_customer_sent', true);
    expect(r.ok).toBe(true);
    expect(shipmentAudits()).toHaveLength(0);
  });
});
