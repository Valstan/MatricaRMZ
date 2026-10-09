import { describe, expect, it } from 'vitest';

import { searchEntityCardContent } from './cardContentSearchService.js';

// Тир-2 списков (владелец 10.10.2026): без кнопки «≈ Похожие» — только подряд
// идущее вхождение всего запроса (с точностью до разделителей). Слова из разных
// мест карточки — уже похожее.
function mockDb(rows: Array<{ entityId: string; valueJson: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  } as any;
}

describe('searchEntityCardContent — точный тир-2', () => {
  it('находит подряд идущее вхождение и компакт-эквивалент', async () => {
    const db = mockDb([
      { entityId: 'e1', valueJson: '"ЯМЗ 240"' },
      { entityId: 'e1', valueJson: '"турбо"' },
      { entityId: 'e2', valueJson: '"Насос"' },
    ]);
    const r1 = await searchEntityCardContent(db, { entityIds: ['e1', 'e2'], q: 'ямз 240' });
    expect(r1).toEqual({ ok: true, ids: ['e1'] });
    const r2 = await searchEntityCardContent(db, { entityIds: ['e1', 'e2'], q: 'ямз240' });
    expect(r2).toEqual({ ok: true, ids: ['e1'] });
  });

  it('слова из разных мест карточки без Похожие не находят', async () => {
    const db = mockDb([
      { entityId: 'e1', valueJson: '"ЯМЗ"' },
      { entityId: 'e1', valueJson: '"контракт 5"' },
      { entityId: 'e1', valueJson: '"турбо"' },
    ]);
    const r = await searchEntityCardContent(db, { entityIds: ['e1'], q: 'ямз турбо' });
    expect(r).toEqual({ ok: true, ids: [] });
  });
});
