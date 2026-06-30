import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for workshopRepairTemplateService:
//
// • Multi-template CRUD (v1.27.0): list/getById/create/update/delete.
// • Legacy single-template API kept for backward-compat with PR 5 UI rollout.
// • Mock БД: table-aware queue для select; mutating ops (insert/update/delete)
//   capture into mutationCalls.

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
        promise.onConflictDoUpdate = vi.fn((conflict: any) => {
          state.mutationCalls.push({ kind: 'insert', table, values, set: conflict?.set });
          return Promise.resolve(undefined);
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

import { directoryWorkshops, erpNomenclature, workshopRepairTemplates } from '../database/schema.js';
import {
  createRepairTemplate,
  deleteRepairTemplate,
  getRepairTemplate,
  getRepairTemplateById,
  listRepairTemplates,
  setRepairTemplate,
  updateRepairTemplate,
} from '../services/workshopRepairTemplateService.js';

const WORKSHOP_ID = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '99999999-9999-4999-8999-999999999999';
const NOM_ID_1 = '22222222-2222-4222-8222-222222222222';
const NOM_ID_2 = '33333333-3333-4333-8333-333333333333';

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

describe('listRepairTemplates', () => {
  it('returns summaries with lineCount', async () => {
    enqueueSelect(workshopRepairTemplates, [
      {
        id: TEMPLATE_ID,
        workshopId: WORKSHOP_ID,
        name: 'Базовый',
        linesJson: JSON.stringify([
          { nomenclatureId: NOM_ID_1, unit: 'шт' },
          { nomenclatureId: NOM_ID_2, unit: 'кг' },
        ]),
        updatedAt: 12345,
      },
    ]);
    const r = await listRepairTemplates(WORKSHOP_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.templates).toHaveLength(1);
      expect(r.templates[0]).toEqual({
        id: TEMPLATE_ID,
        workshopId: WORKSHOP_ID,
        name: 'Базовый',
        lineCount: 2,
        updatedAt: 12345,
      });
    }
  });

  it('returns empty array when no templates exist', async () => {
    enqueueSelect(workshopRepairTemplates, []);
    const r = await listRepairTemplates(WORKSHOP_ID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.templates).toEqual([]);
  });

  it('rejects empty workshopId', async () => {
    const r = await listRepairTemplates('   ');
    expect(r.ok).toBe(false);
  });
});

describe('getRepairTemplateById', () => {
  it('returns parsed template', async () => {
    enqueueSelect(workshopRepairTemplates, [
      {
        id: TEMPLATE_ID,
        workshopId: WORKSHOP_ID,
        name: 'Гильзы',
        linesJson: JSON.stringify([{ nomenclatureId: NOM_ID_1, unit: 'шт', defaultQty: 3 }]),
        updatedAt: 999,
        updatedBy: 'admin',
      },
    ]);
    const r = await getRepairTemplateById(TEMPLATE_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.template.id).toBe(TEMPLATE_ID);
      expect(r.template.name).toBe('Гильзы');
      expect(r.template.lines).toEqual([{ nomenclatureId: NOM_ID_1, unit: 'шт', defaultQty: 3 }]);
    }
  });

  it('returns error when not found', async () => {
    enqueueSelect(workshopRepairTemplates, []);
    const r = await getRepairTemplateById(TEMPLATE_ID);
    expect(r.ok).toBe(false);
  });
});

describe('createRepairTemplate', () => {
  it('creates a new template with valid data', async () => {
    enqueueSelect(directoryWorkshops, [{ id: WORKSHOP_ID }]);
    enqueueSelect(workshopRepairTemplates, []); // name uniqueness check: empty
    enqueueSelect(erpNomenclature, [{ id: NOM_ID_1 }]);
    enqueueReturning([
      {
        id: TEMPLATE_ID,
        workshopId: WORKSHOP_ID,
        name: 'Поршни',
        linesJson: JSON.stringify([{ nomenclatureId: NOM_ID_1, unit: 'шт' }]),
        updatedAt: 1000,
        updatedBy: 'admin',
      },
    ]);
    const r = await createRepairTemplate({
      workshopId: WORKSHOP_ID,
      name: 'Поршни',
      lines: [{ nomenclatureId: NOM_ID_1, unit: 'шт' }],
      actor: 'admin',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.template.name).toBe('Поршни');
      expect(r.template.lines).toHaveLength(1);
    }
  });

  it('rejects empty name', async () => {
    const r = await createRepairTemplate({ workshopId: WORKSHOP_ID, name: '   ', lines: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate name in same workshop', async () => {
    enqueueSelect(directoryWorkshops, [{ id: WORKSHOP_ID }]);
    enqueueSelect(workshopRepairTemplates, [{ id: 'other-template' }]); // name collision
    const r = await createRepairTemplate({
      workshopId: WORKSHOP_ID,
      name: 'Поршни',
      lines: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/уже существует/);
  });

  it('rejects when workshop not found', async () => {
    enqueueSelect(directoryWorkshops, []);
    const r = await createRepairTemplate({ workshopId: WORKSHOP_ID, name: 'X', lines: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Цех не найден/);
  });

  it('rejects when nomenclatureId does not exist', async () => {
    enqueueSelect(directoryWorkshops, [{ id: WORKSHOP_ID }]);
    enqueueSelect(workshopRepairTemplates, []);
    enqueueSelect(erpNomenclature, []); // nothing found
    const r = await createRepairTemplate({
      workshopId: WORKSHOP_ID,
      name: 'X',
      lines: [{ nomenclatureId: NOM_ID_1, unit: 'шт' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/не найдена/);
  });

  // v1.27.1: serviceId хранится как opaque-строка (EAV-id из admin.entities),
  // backend не валидирует его против erp_nomenclature — это разные пространства.
  it('accepts arbitrary serviceId string (no existence check in v1.27.1)', async () => {
    enqueueSelect(directoryWorkshops, [{ id: WORKSHOP_ID }]);
    enqueueSelect(workshopRepairTemplates, []);
    enqueueSelect(erpNomenclature, [{ id: NOM_ID_1 }]); // nomenclature ok
    enqueueReturning([
      {
        id: TEMPLATE_ID,
        workshopId: WORKSHOP_ID,
        name: 'X',
        linesJson: JSON.stringify([{ nomenclatureId: NOM_ID_1, unit: 'шт', serviceId: NOM_ID_2 }]),
        updatedAt: 1,
        updatedBy: null,
      },
    ]);
    const r = await createRepairTemplate({
      workshopId: WORKSHOP_ID,
      name: 'X',
      lines: [{ nomenclatureId: NOM_ID_1, unit: 'шт', serviceId: NOM_ID_2 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.template.lines).toHaveLength(1);
      expect(r.template.lines[0]?.serviceId).toBe(NOM_ID_2);
    }
  });

  it('accepts empty lines array', async () => {
    enqueueSelect(directoryWorkshops, [{ id: WORKSHOP_ID }]);
    enqueueSelect(workshopRepairTemplates, []);
    enqueueReturning([
      { id: TEMPLATE_ID, workshopId: WORKSHOP_ID, name: 'Пустой', linesJson: '[]', updatedAt: 1, updatedBy: null },
    ]);
    const r = await createRepairTemplate({ workshopId: WORKSHOP_ID, name: 'Пустой', lines: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.template.lines).toEqual([]);
  });
});

describe('updateRepairTemplate', () => {
  it('updates name and lines together', async () => {
    enqueueSelect(workshopRepairTemplates, [
      { id: TEMPLATE_ID, workshopId: WORKSHOP_ID, name: 'Старое', linesJson: '[]', updatedAt: 1, updatedBy: null },
    ]);
    enqueueSelect(workshopRepairTemplates, []); // name uniqueness: empty
    enqueueSelect(erpNomenclature, [{ id: NOM_ID_1 }]);
    enqueueReturning([
      {
        id: TEMPLATE_ID,
        workshopId: WORKSHOP_ID,
        name: 'Новое',
        linesJson: JSON.stringify([{ nomenclatureId: NOM_ID_1, unit: 'шт' }]),
        updatedAt: 2,
        updatedBy: 'admin',
      },
    ]);
    const r = await updateRepairTemplate({
      id: TEMPLATE_ID,
      name: 'Новое',
      lines: [{ nomenclatureId: NOM_ID_1, unit: 'шт' }],
      actor: 'admin',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.template.name).toBe('Новое');
      expect(r.template.lines).toHaveLength(1);
    }
  });

  it('rejects when template not found', async () => {
    enqueueSelect(workshopRepairTemplates, []);
    const r = await updateRepairTemplate({ id: TEMPLATE_ID, name: 'X' });
    expect(r.ok).toBe(false);
  });

  it('rejects rename to existing name in same workshop', async () => {
    enqueueSelect(workshopRepairTemplates, [
      { id: TEMPLATE_ID, workshopId: WORKSHOP_ID, name: 'Старое', linesJson: '[]', updatedAt: 1, updatedBy: null },
    ]);
    enqueueSelect(workshopRepairTemplates, [{ id: 'other' }]); // duplicate exists
    const r = await updateRepairTemplate({ id: TEMPLATE_ID, name: 'Занято' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/уже существует/);
  });

  it('returns current template when no fields provided', async () => {
    enqueueSelect(workshopRepairTemplates, [
      { id: TEMPLATE_ID, workshopId: WORKSHOP_ID, name: 'X', linesJson: '[]', updatedAt: 1, updatedBy: null },
    ]);
    const r = await updateRepairTemplate({ id: TEMPLATE_ID });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.template.name).toBe('X');
  });
});

describe('deleteRepairTemplate', () => {
  it('deletes existing template', async () => {
    enqueueReturning([{ id: TEMPLATE_ID }]);
    const r = await deleteRepairTemplate(TEMPLATE_ID);
    expect(r.ok).toBe(true);
  });

  it('returns error when not found', async () => {
    enqueueReturning([]);
    const r = await deleteRepairTemplate(TEMPLATE_ID);
    expect(r.ok).toBe(false);
  });

  it('rejects empty id', async () => {
    const r = await deleteRepairTemplate('   ');
    expect(r.ok).toBe(false);
  });
});

describe('getRepairTemplate (legacy)', () => {
  it('returns empty template when no row exists', async () => {
    enqueueSelect(workshopRepairTemplates, []);
    const r = await getRepairTemplate(WORKSHOP_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.template.workshopId).toBe(WORKSHOP_ID);
      expect(r.template.lines).toEqual([]);
    }
  });

  it('parses lines from first stored template', async () => {
    enqueueSelect(workshopRepairTemplates, [
      {
        workshopId: WORKSHOP_ID,
        linesJson: JSON.stringify([{ nomenclatureId: NOM_ID_1, unit: 'шт', defaultQty: 2 }]),
        updatedAt: 12345,
        updatedBy: 'admin',
      },
    ]);
    const r = await getRepairTemplate(WORKSHOP_ID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.template.lines).toHaveLength(1);
  });
});

describe('setRepairTemplate (legacy)', () => {
  it('inserts new «Базовый» template when none exists', async () => {
    enqueueSelect(directoryWorkshops, [{ id: WORKSHOP_ID }]);
    enqueueSelect(erpNomenclature, [{ id: NOM_ID_1 }]);
    enqueueSelect(workshopRepairTemplates, []); // no existing
    const r = await setRepairTemplate({
      workshopId: WORKSHOP_ID,
      lines: [{ nomenclatureId: NOM_ID_1, unit: 'шт' }],
      actor: 'admin',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lineCount).toBe(1);
    const insertCall = state.mutationCalls.find((c) => c.kind === 'insert');
    expect(insertCall).toBeDefined();
    const vals = insertCall!.values as { name: string };
    expect(vals.name).toBe('Базовый');
  });

  it('updates first template when one exists', async () => {
    enqueueSelect(directoryWorkshops, [{ id: WORKSHOP_ID }]);
    enqueueSelect(erpNomenclature, [{ id: NOM_ID_1 }]);
    enqueueSelect(workshopRepairTemplates, [{ id: TEMPLATE_ID }]);
    const r = await setRepairTemplate({
      workshopId: WORKSHOP_ID,
      lines: [{ nomenclatureId: NOM_ID_1, unit: 'шт' }],
      actor: 'admin',
    });
    expect(r.ok).toBe(true);
    const updateCall = state.mutationCalls.find((c) => c.kind === 'update');
    expect(updateCall).toBeDefined();
  });

  it('rejects when workshop not found', async () => {
    enqueueSelect(directoryWorkshops, []);
    const r = await setRepairTemplate({ workshopId: WORKSHOP_ID, lines: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects line with empty nomenclatureId', async () => {
    enqueueSelect(directoryWorkshops, [{ id: WORKSHOP_ID }]);
    const r = await setRepairTemplate({
      workshopId: WORKSHOP_ID,
      lines: [{ nomenclatureId: '', unit: 'шт' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects non-array lines payload', async () => {
    enqueueSelect(directoryWorkshops, [{ id: WORKSHOP_ID }]);
    const r = await setRepairTemplate({ workshopId: WORKSHOP_ID, lines: 'not-array' as unknown });
    expect(r.ok).toBe(false);
  });
});
