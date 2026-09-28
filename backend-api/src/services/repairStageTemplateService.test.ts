import { beforeEach, describe, expect, it, vi } from 'vitest';

// Шаблон единого списка этапов (шаг 5a плана): код immutable, дубль отбивается,
// архив не освобождает код, reorder пересчитывает приоритеты десятками.

const state = vi.hoisted(() => ({
  selects: [] as any[][],
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
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
  const db = {
    select: vi.fn(() => chain(() => state.selects.shift() ?? [])),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        state.updates.push(patch);
        const c: any = { where: () => c, returning: async () => [{ id: 'T1', code: 'x', name: 'X', sortOrder: 10, autoFrom: null, sideBranch: false, updatedAt: 1, archivedAt: null }] };
        return c;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        state.inserts.push(row);
        return { returning: async () => [{ id: 'NEW', ...row, archivedAt: null }] };
      }),
    })),
  };
  return { db };
});

import { archiveRepairStageTemplate, reorderRepairStageTemplates, upsertRepairStageTemplate } from './repairStageTemplateService.js';

beforeEach(() => {
  state.selects = [];
  state.updates = [];
  state.inserts = [];
});

describe('шаблон этапа', () => {
  it('новый этап — в конец линейки (+10 от максимума живых)', async () => {
    state.selects.push([]); // дубля кода нет
    state.selects.push([{ sortOrder: 90 }, { sortOrder: 0 }]); // боковая ветка максимум не двигает
    const r = await upsertRepairStageTemplate({ code: 'paint', name: 'Покраска', actor: 'ivanov' });
    expect(r.ok).toBe(true);
    expect(state.inserts[0]?.code).toBe('paint');
    expect(state.inserts[0]?.sortOrder).toBe(100);
  });

  it('плохой код и чужой autoFrom отбиваются', async () => {
    expect((await upsertRepairStageTemplate({ code: '1 bad', name: 'X' })).ok).toBe(false);
    expect((await upsertRepairStageTemplate({ code: 'ok_code', name: 'X', autoFrom: 'nope' })).ok).toBe(false);
  });

  it('дубль кода отбивается, архивный код не освобождается', async () => {
    state.selects.push([{ id: 'T9', archivedAt: 123 }]);
    const r = await upsertRepairStageTemplate({ code: 'sborka', name: 'Сборка 2' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('архиве');
  });

  it('архив гасит, а не удаляет', async () => {
    const r = await archiveRepairStageTemplate('T1', 'ivanov');
    expect(r).toEqual({ ok: true, id: 'T1' });
    expect(state.updates[0]?.archivedAt).toBeGreaterThan(0);
  });

  it('reorder пересчитывает 10/20/…, боковую ветку пропускает', async () => {
    state.selects.push([
      { id: 'a', code: 'sborka', sideBranch: false, sortOrder: 50 },
      { id: 'b', code: 'otk', sideBranch: false, sortOrder: 70 },
      { id: 'c', code: 'scrap_branch', sideBranch: true, sortOrder: 0 },
    ]);
    const r = await reorderRepairStageTemplates(['b', 'a', 'c'], 'ivanov');
    expect(r).toEqual({ ok: true, updated: 2 });
    expect(state.updates.map((u) => u.sortOrder)).toEqual([10, 20]);
  });

  it('reorder с неизвестным id — отказ', async () => {
    state.selects.push([{ id: 'a', code: 'sborka', sideBranch: false, sortOrder: 50 }]);
    const r = await reorderRepairStageTemplates(['nope'], 'ivanov');
    expect(r.ok).toBe(false);
  });
});
