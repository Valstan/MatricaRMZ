import { describe, expect, it } from 'vitest';

import type { EngineListItem } from '../ipc/types.js';
import { ENGINE_LIST_GROUP_BY_CUTS, ENGINE_LIST_GROUP_BY_LABELS, engineListGroupLevels } from './engineListGrouping.js';
import { flattenGrouped } from './listGrouping.js';

/**
 * Реестр разрезов группировки списка двигателей (промт КАРМАНА #164).
 *
 * Смысл реестра — один: страница и сторож читают **один** список разрезов. Пока разрезы
 * жили в странице, новый разрез можно было добавить «только на экран» — печать, выгрузка и
 * меню о нём не знали, и никто этого не замечал.
 */

const row = (over: Partial<EngineListItem>): EngineListItem => ({ id: 'x', ...over } as EngineListItem);

const rows: EngineListItem[] = [
  row({ id: 'a', customerId: 'c1', customerName: 'Альфа', contractId: 'k1', contractName: '12/2024' }),
  row({ id: 'b', customerId: 'c1', customerName: 'Альфа', contractId: 'k1', contractName: '12/2024', statusFlags: { status_repaired: true } }),
  row({ id: 'c', customerId: 'c2', customerName: 'Бета', contractId: '', contractName: '' }),
];

describe('разрезы группировки списка двигателей', () => {
  it('у каждого разреза есть подпись, и подписи не повторяются', () => {
    const labels = Object.values(ENGINE_LIST_GROUP_BY_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    for (const cut of ENGINE_LIST_GROUP_BY_CUTS) {
      expect(ENGINE_LIST_GROUP_BY_LABELS[cut], cut).toBeTruthy();
    }
  });

  it('«Без группировки» — уровней нет: список плоский', () => {
    expect(engineListGroupLevels('none')).toEqual([]);
  });

  it('каждый разрез раскладывает список по группам, и у строки обе нумерации', () => {
    for (const cut of ENGINE_LIST_GROUP_BY_CUTS) {
      const levels = engineListGroupLevels(cut);
      expect(levels.length, cut).toBeGreaterThan(0);
      const items = flattenGrouped(rows, levels);
      expect(items.filter((i) => i.kind === 'group').length, cut).toBeGreaterThan(0);
      for (const item of items) {
        if (item.kind !== 'row') continue;
        expect(item.number, cut).toBeGreaterThan(0);
        expect(item.groupNumber, cut).toBeGreaterThan(0);
      }
    }
  });

  it('«Заказчик → договор»: договор внутри заказчика, двигатели без договора — отдельная группа', () => {
    const items = flattenGrouped(rows, engineListGroupLevels('customer_contract'));
    const labels = items
      .filter((i) => i.kind === 'group')
      .map((i) => (i.kind === 'group' ? `${i.depth}:${i.label}` : ''));
    expect(labels).toContain('0:Альфа');
    expect(labels).toContain('1:12/2024');
    expect(labels).toContain('0:Бета');
    expect(labels).toContain('1:Без договора');
  });
});
