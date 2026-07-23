import { describe, expect, it } from 'vitest';

import type { MenuTabId } from '../layout/Tabs.js';
import { buildV2Buttons } from './v2ButtonCatalog.js';

const ALL: MenuTabId[] = ['engines', 'work_orders', 'parts', 'contracts', 'employees', 'admin', 'stock_balances'];
const EMPTY_LAYOUT = { pinned: [], hidden: [], order: [] };

function ids(list: Array<{ id: MenuTabId }>): MenuTabId[] {
  return list.map((b) => b.id);
}

describe('buildV2Buttons — планшетное операторское меню', () => {
  it('в режиме «Комп» меню полное', () => {
    const b = buildV2Buttons(ALL, {}, EMPTY_LAYOUT, false);
    expect(ids(b.main)).toEqual(expect.arrayContaining(['contracts', 'employees', 'admin']));
  });

  it('в режиме «Планшет» остаются только разделы пресета', () => {
    const b = buildV2Buttons(ALL, {}, EMPTY_LAYOUT, true);
    expect(ids(b.main).sort()).toEqual(['engines', 'parts', 'stock_balances', 'work_orders']);
  });

  it('закреплённый бухгалтерский раздел не пролезает в планшет через pinned', () => {
    const b = buildV2Buttons(ALL, {}, { pinned: ['contracts'], hidden: [], order: [] }, true);
    expect(ids(b.pinned)).toEqual([]);
    expect(ids(b.main)).not.toContain('contracts');
  });

  it('спрятанные бухгалтерские разделы не всплывают в списке «восстановить»', () => {
    const b = buildV2Buttons(ALL, {}, { pinned: [], hidden: ['admin'], order: [] }, true);
    expect(ids(b.hidden)).toEqual([]);
  });

  it('пресет не расширяет меню сверх прав: недоступный таб не появляется', () => {
    const b = buildV2Buttons(['engines'], {}, EMPTY_LAYOUT, true);
    expect(ids(b.main)).toEqual(['engines']);
  });
});
