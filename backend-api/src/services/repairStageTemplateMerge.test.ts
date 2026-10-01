import { beforeEach, describe, expect, it, vi } from 'vitest';

// Слияние дублей этапов (PR-J): строки переезжают через журнал, исходник — в архив.
// Жёсткое удаление — только этапа без строк.

const state = vi.hoisted(() => ({
  selects: [] as any[][],
  updates: [] as Array<Record<string, unknown>>,
  deletes: 0,
  recorded: [] as any[][],
}));

vi.mock('../database/db.js', () => {
  const chain = (rows: () => any[]) => {
    const c: any = {
      from: () => c,
      where: () => c,
      limit: () => c,
      orderBy: () => c,
      then: (res: (v: any[]) => any, rej?: (e: any) => any) => Promise.resolve(rows()).then(res, rej),
    };
    return c;
  };
  const db: any = {
    select: vi.fn(() => chain(() => state.selects.shift() ?? [])),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        state.updates.push(patch);
        const c: any = {
          where: () => c,
          returning: async () => [{ id: 'T1', code: 'x', name: 'X', sortOrder: 10, autoFrom: null, sideBranch: false, updatedAt: 1, archivedAt: null }],
        };
        return c;
      }),
    })),
    delete: vi.fn(() => {
      const c: any = {
        where: () => c,
        returning: async () => {
          state.deletes += 1;
          return [{ id: 'T1' }];
        },
      };
      return c;
    }),
  };
  return { db };
});

vi.mock('./sync/syncChangeService.js', () => ({
  recordSyncChanges: vi.fn(async (_actor: unknown, changes: unknown[]) => {
    state.recorded.push(changes as any[]);
  }),
}));

import { deleteRepairStageTemplate, mergeRepairStageTemplates } from './repairStageTemplateService.js';

const ACTOR = { id: 'u1', username: 'tester' };

function template(id: string, code: string, name: string, sideBranch = false) {
  return { id, code, name, sortOrder: 10, autoFrom: null, sideBranch, updatedAt: 1, archivedAt: null };
}

function stageRow(id: string, code: string, name: string) {
  return {
    id,
    engineEntityId: 'eng-1',
    operationType: 'repair_history_entry',
    status: 'done',
    note: `Этап: ${name}`,
    performedAt: 100,
    performedBy: 'tester',
    metaJson: JSON.stringify({ action: name, at: 100, stage: { code, name } }),
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null,
    syncStatus: 'synced',
  };
}

beforeEach(() => {
  state.selects = [];
  state.updates = [];
  state.deletes = 0;
  state.recorded = [];
});

describe('mergeRepairStageTemplates', () => {
  it('переезжают только строки исходного кода, исходник уходит в архив', async () => {
    state.selects = [
      [template('s1', 'ukladka_old', 'Укладка старая')],
      [template('t1', 'ukladka', 'Укладка')],
      [stageRow('r1', 'ukladka_old', 'Укладка старая'), stageRow('r2', 'sborka', 'Сборка')],
    ];
    const r = await mergeRepairStageTemplates('s1', 't1', ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.moved).toBe(1);
    expect(r.sourceCode).toBe('ukladka_old');
    expect(r.targetCode).toBe('ukladka');
    expect(state.recorded.length).toBe(1);
    expect(state.recorded[0]!.length).toBe(1);
    const payload = (state.recorded[0] as any[])[0].payload;
    expect(JSON.parse(String(payload.meta_json)).stage.code).toBe('ukladka');
    expect(JSON.parse(String(payload.meta_json)).stage.name).toBe('Укладка');
    expect(payload.note).toBe('Этап: Укладка');
    expect(state.updates.some((u) => u.archivedAt != null)).toBe(true);
  });

  it('dryRun считает, но не пишет', async () => {
    state.selects = [
      [template('s1', 'ukladka_old', 'Укладка старая')],
      [template('t1', 'ukladka', 'Укладка')],
      [stageRow('r1', 'ukladka_old', 'Укладка старая')],
    ];
    const r = await mergeRepairStageTemplates('s1', 't1', ACTOR, { dryRun: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.moved).toBe(1);
    expect(r.dryRun).toBe(true);
    expect(state.recorded.length).toBe(0);
    expect(state.updates.length).toBe(0);
  });

  it('совпадающие id и архивный исходник — отказ', async () => {
    const same = await mergeRepairStageTemplates('s1', 's1', ACTOR);
    expect(same.ok).toBe(false);
    state.selects = [[{ ...template('s1', 'a', 'A'), archivedAt: 5 }], [template('t1', 'b', 'B')]];
    const archived = await mergeRepairStageTemplates('s1', 't1', ACTOR);
    expect(archived.ok).toBe(false);
  });

  it('линейный этап и боковую ветку объединять нельзя', async () => {
    state.selects = [[template('s1', 'a', 'A')], [template('t1', 'scrap_branch', 'Утиль', true)]];
    const r = await mergeRepairStageTemplates('s1', 't1', ACTOR);
    expect(r.ok).toBe(false);
  });
});

describe('deleteRepairStageTemplate', () => {
  it('этап без строк удаляется', async () => {
    state.selects = [[template('s1', 'oops', 'Опечатка')], []];
    const r = await deleteRepairStageTemplate('s1', 'tester');
    expect(r.ok).toBe(true);
    expect(state.deletes).toBe(1);
  });

  it('этап со строками не удаляется', async () => {
    state.selects = [[template('s1', 'ukladka', 'Укладка')], [{ id: 'r1' }]];
    const r = await deleteRepairStageTemplate('s1', 'tester');
    expect(r.ok).toBe(false);
    expect(state.deletes).toBe(0);
  });
});
