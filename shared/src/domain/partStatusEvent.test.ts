import { describe, expect, it } from 'vitest';

import { buildPartStatusEventNote, parsePartStatusEventPayload } from './partStatusEvent.js';
import { buildRepairOrderItemsFromInventory } from './repairChecklist.js';
import { buildRepairIncomingFromWorkOrderPayloads, deriveEngineRepairPartStates, WorkOrderKind } from './workOrder.js';

describe('buildRepairOrderItemsFromInventory', () => {
  const base = { quantity: 4, present: false, actual_qty: 4 };

  it('takes only repair-branch rows with defect, qty = scrap+replace', () => {
    const { items, skippedNoPartId } = buildRepairOrderItemsFromInventory([
      { ...base, part_name: 'Гильза', scrap_qty: 1, replace_qty: 1, replenishment_branch: 'repair', __brand_part_id: 'p1' },
      { ...base, part_name: 'Поршень', scrap_qty: 0, replace_qty: 2, replenishment_branch: 'purchase', __brand_part_id: 'p2' },
      { ...base, part_name: 'Кольцо', scrap_qty: 0, replace_qty: 0, replenishment_branch: 'repair', __brand_part_id: 'p3' },
    ]);
    expect(items).toEqual([{ partId: 'p1', partLabel: 'Гильза', qty: 2 }]);
    expect(skippedNoPartId).toBe(0);
  });

  it('aggregates by partId and counts rows without part id', () => {
    const { items, skippedNoPartId } = buildRepairOrderItemsFromInventory([
      { ...base, part_name: 'Гильза', scrap_qty: 1, replace_qty: 0, replenishment_branch: 'repair', __brand_part_id: 'p1' },
      { ...base, part_name: 'Гильза', scrap_qty: 0, replace_qty: 3, replenishment_branch: 'repair', __part_id: 'p1' },
      { ...base, part_name: 'Безымянная', scrap_qty: 1, replace_qty: 0, replenishment_branch: 'repair' },
    ]);
    expect(items).toEqual([{ partId: 'p1', partLabel: 'Гильза', qty: 4 }]);
    expect(skippedNoPartId).toBe(1);
  });

  it('falls back to part_number for the label', () => {
    const { items } = buildRepairOrderItemsFromInventory([
      { ...base, part_name: '  ', part_number: 'Ч-001', scrap_qty: 1, replace_qty: 0, replenishment_branch: 'repair', __part_id: 'p9' },
    ]);
    expect(items[0]!.partLabel).toBe('Ч-001');
  });
});

describe('part status event payload', () => {
  it('round-trips through JSON and validates', () => {
    const payload = {
      kind: 'part_status_event',
      engineEntityId: 'eng1',
      partId: 'p1',
      partLabel: 'Гильза',
      qty: 2,
      status: 'in_repair',
      workOrderOperationId: 'op1',
      workOrderNumber: 17,
    };
    expect(parsePartStatusEventPayload(JSON.stringify(payload))).toEqual(payload);
  });

  it('rejects foreign/broken payloads', () => {
    expect(parsePartStatusEventPayload(null)).toBeNull();
    expect(parsePartStatusEventPayload('not json')).toBeNull();
    expect(parsePartStatusEventPayload(JSON.stringify({ kind: 'work_order' }))).toBeNull();
    expect(parsePartStatusEventPayload(JSON.stringify({ kind: 'part_status_event', partId: 'p', status: 'nope' }))).toBeNull();
  });

  it('builds operator-readable note', () => {
    expect(buildPartStatusEventNote({ partLabel: 'Гильза', status: 'ready_for_assembly', workOrderNumber: 7 })).toBe(
      'Гильза — готова к сборке (наряд №7)',
    );
    expect(buildPartStatusEventNote({ partLabel: '', status: 'in_repair', workOrderNumber: 0 })).toBe('Деталь — в ремонте');
  });
});

describe('buildRepairIncomingFromWorkOrderPayloads', () => {
  it('aggregates issued repair work lines per part+workshop, skips other kinds and non-issued', () => {
    const lines = buildRepairIncomingFromWorkOrderPayloads([
      {
        kind: 'work_order',
        workOrderKind: WorkOrderKind.Repair,
        repairIssued: true,
        workshopId: 'w1',
        freeWorks: [
          { partId: 'p1', qty: 2 },
          { partId: 'p1', qty: 1 },
          { partId: '', qty: 5 },
          { partId: 'p2', qty: 0 },
        ],
      },
      { kind: 'work_order', workOrderKind: WorkOrderKind.Assembly, workshopId: 'w1', freeWorks: [{ partId: 'p3', qty: 4 }] },
      { kind: 'work_order', workOrderKind: WorkOrderKind.Repair, repairIssued: true, freeWorks: [{ partId: 'p1', qty: 1 }] },
      // Repair-наряд без пометки «выдан в работу» — в прогноз НЕ попадает.
      { kind: 'work_order', workOrderKind: WorkOrderKind.Repair, workshopId: 'w1', freeWorks: [{ partId: 'p1', qty: 99 }] },
    ]);
    expect(lines).toEqual([
      { partId: 'p1', qty: 3, workshopId: 'w1' },
      { partId: 'p1', qty: 1, workshopId: null },
    ]);
  });

  it('excludes repair orders that are not issued to work (repairIssued !== true)', () => {
    const lines = buildRepairIncomingFromWorkOrderPayloads([
      { kind: 'work_order', workOrderKind: WorkOrderKind.Repair, workshopId: 'w1', freeWorks: [{ partId: 'p1', qty: 5 }] },
      { kind: 'work_order', workOrderKind: WorkOrderKind.Repair, repairIssued: false, workshopId: 'w1', freeWorks: [{ partId: 'p2', qty: 3 }] },
    ]);
    expect(lines).toEqual([]);
  });

  it('reads workGroups lines too (issued)', () => {
    const lines = buildRepairIncomingFromWorkOrderPayloads([
      {
        kind: 'work_order',
        workOrderKind: WorkOrderKind.Repair,
        repairIssued: true,
        workshopId: 'w2',
        workGroups: [{ lines: [{ partId: 'p5', qty: 2 }] }],
      },
    ]);
    expect(lines).toEqual([{ partId: 'p5', qty: 2, workshopId: 'w2' }]);
  });
});

describe('deriveEngineRepairPartStates', () => {
  const repairOp = (args: {
    operationId: string;
    status: string;
    updatedAt: number;
    engineId: string;
    partId: string;
    workOrderNumber?: number;
  }) => ({
    operationId: args.operationId,
    status: args.status,
    updatedAt: args.updatedAt,
    rawPayload: {
      kind: 'work_order',
      workOrderKind: WorkOrderKind.Repair,
      workOrderNumber: args.workOrderNumber ?? 1,
      freeWorks: [{ partId: args.partId, qty: 1, engineId: args.engineId }],
    },
  });

  it('open order → in_repair, closed → repaired; foreign engine ignored', () => {
    const states = deriveEngineRepairPartStates(
      [
        repairOp({ operationId: 'a', status: 'open', updatedAt: 10, engineId: 'eng1', partId: 'p1', workOrderNumber: 5 }),
        repairOp({ operationId: 'b', status: 'closed', updatedAt: 20, engineId: 'eng1', partId: 'p2', workOrderNumber: 6 }),
        repairOp({ operationId: 'c', status: 'open', updatedAt: 30, engineId: 'eng2', partId: 'p3' }),
      ],
      'eng1',
    );
    expect(states.get('p1')).toEqual({ state: 'in_repair', workOrderOperationId: 'a', workOrderNumber: 5 });
    expect(states.get('p2')).toEqual({ state: 'repaired', workOrderOperationId: 'b', workOrderNumber: 6 });
    expect(states.has('p3')).toBe(false);
  });

  it('open order wins over closed for the same part', () => {
    const states = deriveEngineRepairPartStates(
      [
        repairOp({ operationId: 'closed-late', status: 'closed', updatedAt: 100, engineId: 'eng1', partId: 'p1' }),
        repairOp({ operationId: 'open-early', status: 'open', updatedAt: 50, engineId: 'eng1', partId: 'p1', workOrderNumber: 9 }),
      ],
      'eng1',
    );
    expect(states.get('p1')).toEqual({ state: 'in_repair', workOrderOperationId: 'open-early', workOrderNumber: 9 });
  });
});
