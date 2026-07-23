import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncTableName } from '@matricarmz/shared';

// Очередь ответов select(): первый вызов — stored-строка наряда, второй — проверка занятости номера.
const state = vi.hoisted(() => ({ selectQueue: [] as any[][] }));

vi.mock('../../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          const result = state.selectQueue.length > 0 ? state.selectQueue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
  };
  return { db };
});

vi.mock('../../utils/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../criticalEventsService.js', () => ({ ingestServerCriticalEvent: vi.fn() }));

const { enforceWorkOrderNumberImmutability } = await import('./workOrderNumberGuard.js');

const OPERATOR = { id: 'u-1', username: 'ivanov', role: 'engineer' };
const SUPERADMIN = { id: 'u-0', username: 'root', role: 'superadmin' };

function metaJson(workOrderNumber: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: 'work_order', version: 4, workOrderNumber, ...extra });
}

function numberChangeMarker(workOrderNumber: number): Record<string, unknown> {
  return { auditTrail: [{ at: 1, by: 'root', action: 'number_change', note: `№${workOrderNumber}` }] };
}

function input(rowId: string, workOrderNumber: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'upsert' as const,
    table: SyncTableName.Operations,
    row_id: rowId,
    row: {
      id: rowId,
      operation_type: 'work_order',
      note: `Наряд №${workOrderNumber}`,
      meta_json: metaJson(workOrderNumber, extra),
    } as Record<string, unknown>,
  };
}

function storedNumber(row: Record<string, unknown>): number {
  return Number((JSON.parse(String(row.meta_json)) as { workOrderNumber: number }).workOrderNumber);
}

beforeEach(() => {
  state.selectQueue = [];
});

describe('enforceWorkOrderNumberImmutability', () => {
  it('heals a foreign number change back to the stored one, keeping the rest of the payload', async () => {
    state.selectQueue.push([{ metaJson: metaJson(85) }]);
    const incoming = input('wo-1', 999, { totalAmountRub: 1234 });

    const heals = await enforceWorkOrderNumberImmutability([incoming], OPERATOR);

    expect(heals).toEqual([{ rowId: 'wo-1', stored: 85, incoming: 999, action: 'healed' }]);
    expect(storedNumber(incoming.row)).toBe(85);
    expect(incoming.row.note).toBe('Наряд №85');
    expect(JSON.parse(String(incoming.row.meta_json)).totalAmountRub).toBe(1234);
  });

  it('heals a zero number sent by an old client', async () => {
    state.selectQueue.push([{ metaJson: metaJson(85) }]);
    const incoming = input('wo-1', 0);

    const heals = await enforceWorkOrderNumberImmutability([incoming], OPERATOR);

    expect(heals[0]?.action).toBe('healed');
    expect(storedNumber(incoming.row)).toBe(85);
  });

  it('lets a superadmin change the number when it is free', async () => {
    state.selectQueue.push([{ metaJson: metaJson(0) }]); // stored row: broken zero
    const incoming = input('wo-1', 85);

    const heals = await enforceWorkOrderNumberImmutability([incoming], SUPERADMIN);

    // stored 0 → нечего защищать, номер присваивает клиент
    expect(heals).toEqual([]);
    expect(storedNumber(incoming.row)).toBe(85);
  });

  it('lets a superadmin renumber a healthy order when the change is marked and the number is free', async () => {
    state.selectQueue.push([{ metaJson: metaJson(103) }]); // stored
    state.selectQueue.push([]); // collision check: nobody holds 86
    const incoming = input('wo-1', 86, numberChangeMarker(86));

    const heals = await enforceWorkOrderNumberImmutability([incoming], SUPERADMIN);

    expect(heals).toEqual([{ rowId: 'wo-1', stored: 103, incoming: 86, action: 'allowed' }]);
    expect(storedNumber(incoming.row)).toBe(86);
  });

  it('heals back when the superadmin target number is already taken', async () => {
    state.selectQueue.push([{ metaJson: metaJson(103) }]);
    state.selectQueue.push([{ id: 'wo-2', metaJson: metaJson(86) }]);
    const incoming = input('wo-1', 86, numberChangeMarker(86));

    const heals = await enforceWorkOrderNumberImmutability([incoming], SUPERADMIN);

    expect(heals[0]?.action).toBe('collision_healed');
    expect(storedNumber(incoming.row)).toBe(103);
  });

  it('heals a superadmin push whose payload carries no number_change marker', async () => {
    state.selectQueue.push([{ metaJson: metaJson(103) }]);
    const incoming = input('wo-1', 86);

    const heals = await enforceWorkOrderNumberImmutability([incoming], SUPERADMIN);

    expect(heals[0]?.action).toBe('healed');
    expect(storedNumber(incoming.row)).toBe(103);
  });

  it('accepts a marker left earlier in the trail (card edited after the renumber)', async () => {
    state.selectQueue.push([{ metaJson: metaJson(103) }]);
    state.selectQueue.push([]);
    const incoming = input('wo-1', 86, {
      auditTrail: [
        { at: 1, by: 'root', action: 'number_change', note: '№86' },
        { at: 2, by: 'root', action: 'update' },
      ],
    });

    const heals = await enforceWorkOrderNumberImmutability([incoming], SUPERADMIN);

    expect(heals[0]?.action).toBe('allowed');
  });

  // След аудита append-only и переживает сохранения карточки, поэтому старый маркер живёт в payload
  // вечно: пускать по нему — значит разрешить устаревшему клиенту откатить номер к прошлой смене.
  it('heals a replay of an older marker when the row already carries a newer renumber', async () => {
    state.selectQueue.push([
      {
        metaJson: metaJson(90, {
          auditTrail: [
            { at: 10, by: 'root', action: 'number_change', note: '№86' },
            { at: 20, by: 'root', action: 'number_change', note: '№90' },
          ],
        }),
      },
    ]);
    const incoming = input('wo-1', 86, {
      auditTrail: [{ at: 10, by: 'root', action: 'number_change', note: '№86' }],
    });

    const heals = await enforceWorkOrderNumberImmutability([incoming], SUPERADMIN);

    expect(heals[0]?.action).toBe('healed');
    expect(storedNumber(incoming.row)).toBe(90);
  });

  it('accepts a fresh renumber over a row that already has an older marker', async () => {
    state.selectQueue.push([
      { metaJson: metaJson(86, { auditTrail: [{ at: 10, by: 'root', action: 'number_change', note: '№86' }] }) },
    ]);
    state.selectQueue.push([]);
    const incoming = input('wo-1', 90, {
      auditTrail: [
        { at: 10, by: 'root', action: 'number_change', note: '№86' },
        { at: 30, by: 'root', action: 'number_change', note: '№90' },
      ],
    });

    const heals = await enforceWorkOrderNumberImmutability([incoming], SUPERADMIN);

    expect(heals[0]?.action).toBe('allowed');
    expect(storedNumber(incoming.row)).toBe(90);
  });

  it('does not accept a marker written for a different number', async () => {
    state.selectQueue.push([{ metaJson: metaJson(103) }]);
    const incoming = input('wo-1', 8, numberChangeMarker(86));

    const heals = await enforceWorkOrderNumberImmutability([incoming], SUPERADMIN);

    expect(heals[0]?.action).toBe('healed');
    expect(storedNumber(incoming.row)).toBe(103);
  });

  it('uses row.id, not the client-supplied row_id, as the lookup key', async () => {
    state.selectQueue.push([{ metaJson: metaJson(85) }]);
    const incoming = input('wo-1', 999);
    incoming.row_id = 'wo-does-not-exist';

    const heals = await enforceWorkOrderNumberImmutability([incoming], OPERATOR);

    expect(heals[0]).toEqual({ rowId: 'wo-1', stored: 85, incoming: 999, action: 'healed' });
    expect(storedNumber(incoming.row)).toBe(85);
  });

  it('guards a row the client labelled as delete but sent without deleted_at', async () => {
    state.selectQueue.push([{ metaJson: metaJson(85) }]);
    const incoming = { ...input('wo-1', 999), type: 'delete' as const };

    const heals = await enforceWorkOrderNumberImmutability([incoming], OPERATOR);

    expect(heals[0]?.action).toBe('healed');
    expect(storedNumber(incoming.row)).toBe(85);
  });

  it('leaves a first materialization alone (no stored row yet)', async () => {
    state.selectQueue.push([]);
    const incoming = input('wo-new', 104);

    const heals = await enforceWorkOrderNumberImmutability([incoming], OPERATOR);

    expect(heals).toEqual([]);
    expect(storedNumber(incoming.row)).toBe(104);
  });

  it('ignores non-work-order operations and other tables', async () => {
    const defect = {
      type: 'upsert' as const,
      table: SyncTableName.Operations,
      row_id: 'op-1',
      row: { id: 'op-1', operation_type: 'defect', meta_json: metaJson(1) } as Record<string, unknown>,
    };
    const entity = {
      type: 'upsert' as const,
      table: SyncTableName.Entities,
      row_id: 'e-1',
      row: { id: 'e-1' } as Record<string, unknown>,
    };

    const heals = await enforceWorkOrderNumberImmutability([defect, entity], OPERATOR);

    expect(heals).toEqual([]);
    expect(state.selectQueue.length).toBe(0);
  });
});
