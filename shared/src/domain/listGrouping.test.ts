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

// Разрез «По договору» списка двигателей (промт КАРМАНА #105). Доменный движок
// не менялся — этот тест фиксирует его поведение на форме уровня «договор»:
// ключ — договор карточки, подпись — номер договора, пусто — «Без договора».
describe('уровень «договор»', () => {
  type C = { id: string; customer: string; contractId: string; contractName: string };
  const contractRows: C[] = [
    { id: 'a', customer: 'Альфа', contractId: 'c1', contractName: '12/2024' },
    { id: 'b', customer: 'Альфа', contractId: 'c1', contractName: '12/2024' },
    { id: 'c', customer: 'Бета', contractId: 'c2', contractName: '07/2024' },
    { id: 'd', customer: 'Альфа', contractId: '', contractName: '' },
  ];
  const byContract = {
    keyOf: (r: C) => {
      const label = r.contractName.trim();
      const id = r.contractId.trim();
      return { key: id || `name:${label.toLowerCase()}`, label: label || 'Без договора' };
    },
  };
  const byCustomer = { keyOf: (r: C) => ({ key: r.customer, label: r.customer }) };

  it('группы по договорам, счётчики — число строк, без ранга — по подписи', () => {
    const items = flattenGrouped(contractRows, [byContract]);
    expect(items.map((i) => (i.kind === 'group' ? `[${i.label}×${i.count}]` : i.row.id))).toEqual([
      '[07/2024×1]', 'c', '[12/2024×2]', 'a', 'b', '[Без договора×1]', 'd',
    ]);
  });

  it('«Заказчик → договор»: два уровня вкладываются, договор внутри заказчика', () => {
    const items = flattenGrouped(contractRows, [byCustomer, byContract]);
    expect(items.map((i) => (i.kind === 'group' ? `${'-'.repeat(i.depth)}${i.label}×${i.count}` : i.row.id))).toEqual([
      'Альфа×3', '-12/2024×2', 'a', 'b', '-Без договора×1', 'd', 'Бета×1', '-07/2024×1', 'c',
    ]);
  });
});
