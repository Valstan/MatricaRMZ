import { describe, expect, it } from 'vitest';

import { orderRowsForPublication } from './usersSyncPublisherService.js';

// B3/R3 — самый дорогой из возможных отказов этой нитки, поэтому он проверяется
// отдельно от живой приёмки. На живой базе нужный порядок может получиться
// случайно (он зависит от плана запроса), и зелёный прогон ничего не доказывал бы.

describe('порядок публикации зеркала', () => {
  const tombstone = { id: 'a', login: 'oper1', updatedAt: 200, deletedAt: 200 };
  const heir = { id: 'b', login: 'oper1', updatedAt: 100, deletedAt: null };

  it('тумбстоун идёт раньше живой строки, даже если он новее', () => {
    // Именно эта пара и есть передача логина: у прежнего владельца строка
    // погашена ПОЗЖЕ (updatedAt=200), у наследника заведена раньше (100).
    // Сортировка только по времени поставила бы наследника первым, клиент
    // упёрся бы в частичный unique логина и встал бы навсегда.
    expect(orderRowsForPublication([heir, tombstone]).map((r) => r.id)).toEqual(['a', 'b']);
    expect(orderRowsForPublication([tombstone, heir]).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('внутри группы порядок стабильный: по времени, при равенстве — по id', () => {
    const rows = [
      { id: 'z', updatedAt: 10, deletedAt: null },
      { id: 'a', updatedAt: 10, deletedAt: null },
      { id: 'm', updatedAt: 5, deletedAt: null },
    ];
    expect(orderRowsForPublication(rows).map((r) => r.id)).toEqual(['m', 'a', 'z']);
  });

  it('пустой вход и вход без тумбстоунов не ломаются', () => {
    expect(orderRowsForPublication([])).toEqual([]);
    const live = [{ id: 'a', updatedAt: 1, deletedAt: null }];
    expect(orderRowsForPublication(live).map((r) => r.id)).toEqual(['a']);
  });
});
