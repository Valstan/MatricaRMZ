import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for workOrderTemplateService (Stage 2 of work-order-template-system plan).
// Mock БД: table-aware queue для select; mutating ops капчатся в mutationCalls.

const state = vi.hoisted(() => ({
  selectByTable: new Map<unknown, any[][]>(),
  mutationCalls: [] as Array<{
    kind: 'insert' | 'update' | 'delete';
    table: unknown;
    values?: unknown;
    set?: unknown;
    returning?: any[];
  }>,
  returningQueue: [] as any[][],
}));

vi.mock('../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown = undefined;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        const promise: any = Promise.resolve(undefined);
        promise.returning = vi.fn(() => {
          const returned = state.returningQueue.shift() ?? [];
          state.mutationCalls.push({ kind: 'insert', table, values, returning: returned });
          return Promise.resolve(returned);
        });
        state.mutationCalls.push({ kind: 'insert', table, values });
        return promise;
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((set: unknown) => ({
        where: vi.fn(() => {
          const promise: any = Promise.resolve(undefined);
          promise.returning = vi.fn(() => {
            const returned = state.returningQueue.shift() ?? [];
            state.mutationCalls.push({ kind: 'update', table, set, returning: returned });
            return Promise.resolve(returned);
          });
          state.mutationCalls.push({ kind: 'update', table, set });
          return promise;
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => {
          const returned = state.returningQueue.shift() ?? [];
          state.mutationCalls.push({ kind: 'delete', table, returning: returned });
          return Promise.resolve(returned);
        }),
      })),
    })),
  };
  return { db };
});

import { workOrderTemplates } from '../database/schema.js';
import {
  createWorkOrderTemplate,
  deleteWorkOrderTemplate,
  getWorkOrderTemplateById,
  listWorkOrderTemplates,
  updateWorkOrderTemplate,
} from '../services/workOrderTemplateService.js';

const TEMPLATE_ID = '99999999-9999-4999-8999-999999999999';
const WORKSHOP_ID = '11111111-1111-4111-8111-111111111111';
const NOM_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';

function enqueueSelect(table: unknown, rows: any[]) {
  const queue = state.selectByTable.get(table);
  if (queue) queue.push(rows);
  else state.selectByTable.set(table, [rows]);
}

function enqueueReturning(rows: any[]) {
  state.returningQueue.push(rows);
}

beforeEach(() => {
  state.selectByTable.clear();
  state.mutationCalls.length = 0;
  state.returningQueue.length = 0;
});

describe('listWorkOrderTemplates', () => {
  it('returns all summaries when no kind filter', async () => {
    enqueueSelect(workOrderTemplates, [
      {
        id: TEMPLATE_ID,
        workOrderKind: 'repair',
        name: 'Шаблон A',
        payloadOverridesJson: '{}',
        hiddenFieldsJson: '[]',
        linesJson: JSON.stringify([{ nomenclatureId: NOM_ID }, { serviceId: SERVICE_ID }]),
        updatedAt: 12345,
        updatedBy: null,
      },
    ]);
    const result = await listWorkOrderTemplates();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.lineCount).toBe(2);
    expect(result.templates[0]?.workOrderKind).toBe('repair');
  });

  it('filters by kind', async () => {
    enqueueSelect(workOrderTemplates, [
      {
        id: TEMPLATE_ID,
        workOrderKind: 'assembly',
        name: 'X',
        payloadOverridesJson: '{}',
        hiddenFieldsJson: '[]',
        linesJson: '[]',
        updatedAt: 1,
        updatedBy: null,
      },
    ]);
    const result = await listWorkOrderTemplates({ kind: 'assembly' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.templates[0]?.workOrderKind).toBe('assembly');
  });

  it('rejects invalid kind filter', async () => {
    const result = await listWorkOrderTemplates({ kind: 'bogus' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Недопустимый тип/);
  });
});

describe('getWorkOrderTemplateById', () => {
  it('returns dto with parsed fields', async () => {
    enqueueSelect(workOrderTemplates, [
      {
        id: TEMPLATE_ID,
        workOrderKind: 'repair',
        name: 'X',
        payloadOverridesJson: JSON.stringify({ workshopId: WORKSHOP_ID }),
        hiddenFieldsJson: JSON.stringify(['engineId', 'productNumber']),
        linesJson: JSON.stringify([{ nomenclatureId: NOM_ID, unit: 'шт' }]),
        updatedAt: 999,
        updatedBy: 'admin',
      },
    ]);
    const result = await getWorkOrderTemplateById(TEMPLATE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.payloadOverrides).toEqual({ workshopId: WORKSHOP_ID });
    expect(result.template.hiddenFields).toEqual(['engineId', 'productNumber']);
    expect(result.template.lines[0]?.unit).toBe('шт');
  });

  it('returns error when not found', async () => {
    enqueueSelect(workOrderTemplates, []);
    const result = await getWorkOrderTemplateById(TEMPLATE_ID);
    expect(result.ok).toBe(false);
  });

  it('rejects empty id', async () => {
    const result = await getWorkOrderTemplateById('   ');
    expect(result.ok).toBe(false);
  });
});

describe('createWorkOrderTemplate', () => {
  it('creates with valid input', async () => {
    enqueueSelect(workOrderTemplates, []); // dup check
    enqueueReturning([
      {
        id: TEMPLATE_ID,
        workOrderKind: 'repair',
        name: 'New',
        payloadOverridesJson: '{}',
        hiddenFieldsJson: '[]',
        linesJson: '[]',
        updatedAt: 100,
        updatedBy: 'admin',
      },
    ]);
    const result = await createWorkOrderTemplate({
      workOrderKind: 'repair',
      name: 'New',
      actor: 'admin',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.name).toBe('New');
  });

  it('rejects invalid workOrderKind', async () => {
    const result = await createWorkOrderTemplate({
      workOrderKind: 'workshop_template',
      name: 'X',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects empty name', async () => {
    const result = await createWorkOrderTemplate({
      workOrderKind: 'repair',
      name: '   ',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects name > 100 chars', async () => {
    const result = await createWorkOrderTemplate({
      workOrderKind: 'repair',
      name: 'x'.repeat(101),
    });
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate (kind, name)', async () => {
    enqueueSelect(workOrderTemplates, [{ id: TEMPLATE_ID }]);
    const result = await createWorkOrderTemplate({
      workOrderKind: 'repair',
      name: 'Dup',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/уже существует/);
  });

  it('rejects hiding required field (workshopId for repair)', async () => {
    const result = await createWorkOrderTemplate({
      workOrderKind: 'repair',
      name: 'X',
      hiddenFields: ['workshopId'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/нельзя скрыть/);
  });

  it('allows hiding non-required field (engineId for repair)', async () => {
    enqueueSelect(workOrderTemplates, []);
    enqueueReturning([
      {
        id: TEMPLATE_ID,
        workOrderKind: 'repair',
        name: 'X',
        payloadOverridesJson: '{}',
        hiddenFieldsJson: '["engineId"]',
        linesJson: '[]',
        updatedAt: 1,
        updatedBy: null,
      },
    ]);
    const result = await createWorkOrderTemplate({
      workOrderKind: 'repair',
      name: 'X',
      hiddenFields: ['engineId'],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects line without nomenclatureId or serviceId', async () => {
    const result = await createWorkOrderTemplate({
      workOrderKind: 'repair',
      name: 'X',
      lines: [{ unit: 'шт' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/должна содержать/);
  });

  it('rejects hiddenFields not an array', async () => {
    const result = await createWorkOrderTemplate({
      workOrderKind: 'repair',
      name: 'X',
      hiddenFields: 'not-array',
    });
    expect(result.ok).toBe(false);
  });

  it('accepts overrides as opaque object', async () => {
    enqueueSelect(workOrderTemplates, []);
    enqueueReturning([
      {
        id: TEMPLATE_ID,
        workOrderKind: 'assembly',
        name: 'X',
        payloadOverridesJson: JSON.stringify({ workshopId: WORKSHOP_ID, foo: 42 }),
        hiddenFieldsJson: '[]',
        linesJson: '[]',
        updatedAt: 1,
        updatedBy: null,
      },
    ]);
    const result = await createWorkOrderTemplate({
      workOrderKind: 'assembly',
      name: 'X',
      payloadOverrides: { workshopId: WORKSHOP_ID, foo: 42 },
    });
    expect(result.ok).toBe(true);
  });
});

describe('updateWorkOrderTemplate', () => {
  it('updates name when provided', async () => {
    enqueueSelect(workOrderTemplates, [
      {
        id: TEMPLATE_ID,
        workOrderKind: 'repair',
        name: 'Old',
        payloadOverridesJson: '{}',
        hiddenFieldsJson: '[]',
        linesJson: '[]',
        updatedAt: 1,
        updatedBy: null,
      },
    ]);
    enqueueSelect(workOrderTemplates, []); // dup check
    enqueueReturning([
      {
        id: TEMPLATE_ID,
        workOrderKind: 'repair',
        name: 'New',
        payloadOverridesJson: '{}',
        hiddenFieldsJson: '[]',
        linesJson: '[]',
        updatedAt: 2,
        updatedBy: 'admin',
      },
    ]);
    const result = await updateWorkOrderTemplate({ id: TEMPLATE_ID, name: 'New', actor: 'admin' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.name).toBe('New');
  });

  it('rejects rename with conflict', async () => {
    enqueueSelect(workOrderTemplates, [
      {
        id: TEMPLATE_ID,
        workOrderKind: 'repair',
        name: 'Old',
        payloadOverridesJson: '{}',
        hiddenFieldsJson: '[]',
        linesJson: '[]',
        updatedAt: 1,
        updatedBy: null,
      },
    ]);
    enqueueSelect(workOrderTemplates, [{ id: 'other' }]); // dup
    const result = await updateWorkOrderTemplate({ id: TEMPLATE_ID, name: 'Taken' });
    expect(result.ok).toBe(false);
  });

  it('returns error when template missing', async () => {
    enqueueSelect(workOrderTemplates, []);
    const result = await updateWorkOrderTemplate({ id: TEMPLATE_ID, name: 'X' });
    expect(result.ok).toBe(false);
  });

  it('returns current dto when patch is empty', async () => {
    enqueueSelect(workOrderTemplates, [
      {
        id: TEMPLATE_ID,
        workOrderKind: 'repair',
        name: 'Same',
        payloadOverridesJson: '{}',
        hiddenFieldsJson: '[]',
        linesJson: '[]',
        updatedAt: 1,
        updatedBy: null,
      },
    ]);
    const result = await updateWorkOrderTemplate({ id: TEMPLATE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.name).toBe('Same');
  });
});

describe('deleteWorkOrderTemplate', () => {
  it('deletes existing template', async () => {
    enqueueReturning([{ id: TEMPLATE_ID }]);
    const result = await deleteWorkOrderTemplate(TEMPLATE_ID);
    expect(result.ok).toBe(true);
  });

  it('returns error when nothing deleted', async () => {
    enqueueReturning([]);
    const result = await deleteWorkOrderTemplate(TEMPLATE_ID);
    expect(result.ok).toBe(false);
  });

  it('rejects empty id', async () => {
    const result = await deleteWorkOrderTemplate('  ');
    expect(result.ok).toBe(false);
  });
});
