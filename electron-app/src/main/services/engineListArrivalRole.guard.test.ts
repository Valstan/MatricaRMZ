import { describe, expect, it } from 'vitest';

import { arrivalPlacements, type EngineListItem } from '@matricarmz/shared';

// Сторож последнего шага listEngines: роль заезда считается НА СЕРВЕРЕ один раз по полному
// списку и уезжает в строку (`arrival`). Сам listEngines тянет за собой всю схему EAV, поэтому
// здесь воспроизведён ровно его хвост — вместе с сортировкой, чтобы было видно: роль
// привязана к строке, а не к позиции в массиве (владелец 22.09.2026).
function listArrivalTail(rows: EngineListItem[]): EngineListItem[] {
  const placements = arrivalPlacements(rows);
  for (const row of rows) {
    const placement = placements.get(row.id);
    if (placement) row.arrival = placement;
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

describe('роль заезда в строке списка двигателей', () => {
  it('две карточки одного номера с флагом повторного заезда: у обеих archived и current', () => {
    const sorted = listArrivalTail([
      {
        id: 'old',
        engineNumber: '2Ж03АТ0479',
        arrivalDate: Date.UTC(2025, 5, 10),
        updatedAt: 10,
        syncStatus: 'synced',
      },
      {
        id: 'new',
        engineNumber: '2Ж03АТ0479',
        isRepeatArrival: true,
        arrivalDate: Date.UTC(2026, 5, 10),
        updatedAt: 20,
        syncStatus: 'synced',
      },
    ]);
    const byId = new Map(sorted.map((r) => [r.id, r]));
    expect(byId.get('old')?.arrival).toEqual({ role: 'archived', index: 1, total: 2, year: 2025 });
    expect(byId.get('new')?.arrival).toEqual({ role: 'current', index: 2, total: 2, year: 2026 });
  });
});
