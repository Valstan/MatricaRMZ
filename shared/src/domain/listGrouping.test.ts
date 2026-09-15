import { describe, expect, it } from 'vitest';

import { flattenGrouped } from './listGrouping.js';

type R = { id: string; customer: string; stage: string; rank: number };
const rows: R[] = [
  { id: 'a', customer: 'Альфа', stage: 'Пришёл', rank: 0 },
  { id: 'b', customer: 'Бета', stage: 'Обкатка', rank: 13 },
  { id: 'c', customer: 'Альфа', stage: 'Обкатка', rank: 13 },
  { id: 'd', customer: 'Бета', stage: 'Пришёл', rank: 0 },
];
const byStage = { keyOf: (r: R) => ({ key: r.stage, label: r.stage, rank: r.rank }) };
const byCustomer = { keyOf: (r: R) => ({ key: r.customer, label: r.customer }) };

describe('flattenGrouped', () => {
  it('без уровней — просто строки со сквозной нумерацией', () => {
    const items = flattenGrouped(rows, []);
    expect(items.map((i) => (i.kind === 'row' ? `${i.number}:${i.row.id}` : i.kind))).toEqual(['1:a', '2:b', '3:c', '4:d']);
  });

  it('один уровень: группы по рангу от большего, заголовок несёт счётчик, нумерация сквозная', () => {
    const items = flattenGrouped(rows, [byStage]);
    expect(items.map((i) => (i.kind === 'group' ? `[${i.label}×${i.count}]` : `${i.number}:${i.row.id}`))).toEqual([
      '[Обкатка×2]', '1:b', '2:c', '[Пришёл×2]', '3:a', '4:d',
    ]);
  });

  it('без ранга группы идут по подписи; два уровня вкладываются с depth', () => {
    const items = flattenGrouped(rows, [byCustomer, byStage]);
    expect(items.map((i) => (i.kind === 'group' ? `${'-'.repeat(i.depth)}${i.label}` : i.row.id))).toEqual([
      'Альфа', '-Обкатка', 'c', '-Пришёл', 'a', 'Бета', '-Обкатка', 'b', '-Пришёл', 'd',
    ]);
    expect(items.filter((i) => i.kind === 'row').map((i) => (i.kind === 'row' ? i.number : 0))).toEqual([1, 2, 3, 4]);
  });

  it('ключи групп уникальны между уровнями', () => {
    const keys = flattenGrouped(rows, [byCustomer, byStage]).filter((i) => i.kind === 'group').map((i) => (i.kind === 'group' ? i.key : ''));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
