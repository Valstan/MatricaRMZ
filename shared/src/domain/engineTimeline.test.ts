import { describe, expect, it } from 'vitest';

import {
  buildEngineTimeline,
  describeOperationType,
  operationStatusLabel,
  type EngineTimelineSourceRow,
} from './engineTimeline.js';

function row(partial: Partial<EngineTimelineSourceRow> & { id: string; operationType: string }): EngineTimelineSourceRow {
  return {
    status: 'done',
    note: null,
    performedAt: null,
    performedBy: null,
    metaJson: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe('describeOperationType', () => {
  it('maps known types to human labels + phase', () => {
    expect(describeOperationType('acceptance')).toMatchObject({ label: 'Приёмка', phase: 'acceptance' });
    expect(describeOperationType('defect_act')).toMatchObject({ label: 'Акт дефектовки', phase: 'defect' });
    expect(describeOperationType('workshop_transfer')).toMatchObject({ label: 'Межцеховая передача' });
    expect(describeOperationType('customer_delivery')).toMatchObject({ phase: 'shipment' });
    expect(describeOperationType('work_order')).toMatchObject({ label: 'Наряд', phase: 'repair' });
    expect(describeOperationType('engine_inventory')).toMatchObject({ label: 'Ведомость деталей', phase: 'defect' });
    expect(describeOperationType('engine_intake')).toMatchObject({ phase: 'acceptance' });
  });

  it('falls back to raw code for unknown types', () => {
    const d = describeOperationType('some_new_type');
    expect(d.label).toBe('some_new_type');
    expect(d.phase).toBe('other');
  });
});

describe('operationStatusLabel', () => {
  it('translates known status codes, echoes unknown', () => {
    expect(operationStatusLabel('transferred')).toBe('Передан');
    expect(operationStatusLabel('weird')).toBe('weird');
  });
});

describe('buildEngineTimeline', () => {
  it('sorts newest first by performedAt, falls back to updatedAt', () => {
    const items = buildEngineTimeline([
      row({ id: 'a', operationType: 'acceptance', performedAt: 100 }),
      row({ id: 'b', operationType: 'defect', performedAt: 300 }),
      row({ id: 'c', operationType: 'repair', performedAt: null, updatedAt: 200 }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(items[0]?.at).toBe(300);
    expect(items[1]?.at).toBe(200);
  });

  it('normalizes label/icon/status into the item', () => {
    const [item] = buildEngineTimeline([
      row({ id: 'x', operationType: 'workshop_transfer', status: 'transferred', note: 'Цех A → B', performedBy: 'ivanov', performedAt: 5 }),
    ]);
    expect(item).toMatchObject({
      operationType: 'workshop_transfer',
      label: 'Межцеховая передача',
      statusLabel: 'Передан',
      note: 'Цех A → B',
      performedBy: 'ivanov',
      at: 5,
    });
    expect(item?.icon).toBeTruthy();
  });
});
