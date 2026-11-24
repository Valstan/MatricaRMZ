import { describe, expect, it } from 'vitest';

import { planSectionAccessWrites, type SectionAccessRow } from './sectionAccessPlan.js';

/**
 * UNIQUE(user_id, section_id) в `user_section_access` НЕ смотрит на deleted_at:
 * строка (человек, раздел) в базе навсегда одна. Значит повторная выдача
 * снятого раздела обязана ВОЗВРАЩАТЬ строку, а не вставлять новую — иначе
 * constraint отвергает вставку, выдача падает, и раздел невыдаваем навсегда
 * (замер на стенде lane1, 25.11.2026).
 */
const LIVE: SectionAccessRow = { id: 'row-live', sectionId: 'production', level: 'viewer', deletedAt: null };
const TOMBSTONE: SectionAccessRow = {
  id: 'row-dead',
  sectionId: 'production',
  level: 'viewer',
  deletedAt: 1795560166971,
};

describe('planSectionAccessWrites', () => {
  it('снятый раздел оживает, а не вставляется заново', () => {
    const plan = planSectionAccessWrites([TOMBSTONE], { production: 'viewer' });
    expect(plan).toEqual([{ kind: 'revive', sectionId: 'production', rowId: 'row-dead', level: 'viewer' }]);
  });

  it('повторная выдача снятого раздела НЕ планирует вставку (constraint отверг бы её)', () => {
    const plan = planSectionAccessWrites([TOMBSTONE], { production: 'viewer' });
    expect(plan.some((s) => s.kind === 'insert')).toBe(false);
  });

  it('живая строка с тем же уровнем не трогается', () => {
    expect(planSectionAccessWrites([LIVE], { production: 'viewer' })).toEqual([
      { kind: 'keep', sectionId: 'production' },
    ]);
  });

  it('живая строка с другим уровнем обновляется', () => {
    expect(planSectionAccessWrites([LIVE], { production: 'editor' })).toEqual([
      { kind: 'update', sectionId: 'production', rowId: 'row-live', level: 'editor' },
    ]);
  });

  it('раздел, которого никогда не было, вставляется', () => {
    expect(planSectionAccessWrites([], { production: 'viewer' })).toEqual([
      { kind: 'insert', sectionId: 'production', level: 'viewer' },
    ]);
  });

  it('раздел, которого больше нет в наборе, снимается (тумбстоун)', () => {
    expect(planSectionAccessWrites([LIVE], {})).toEqual([
      { kind: 'revoke', sectionId: 'production', rowId: 'row-live' },
    ]);
  });

  it('снятый раздел не снимается повторно', () => {
    expect(planSectionAccessWrites([TOMBSTONE], {})).toEqual([]);
  });

  it('полный круг: выдали → сняли → выдали снова — последний шаг revive, не insert', () => {
    const first = planSectionAccessWrites([], { production: 'viewer' });
    expect(first).toEqual([{ kind: 'insert', sectionId: 'production', level: 'viewer' }]);

    const revoke = planSectionAccessWrites([LIVE], {});
    expect(revoke).toEqual([{ kind: 'revoke', sectionId: 'production', rowId: 'row-live' }]);

    const again = planSectionAccessWrites([TOMBSTONE], { production: 'viewer' });
    expect(again).toEqual([{ kind: 'revive', sectionId: 'production', rowId: 'row-dead', level: 'viewer' }]);
  });
});
