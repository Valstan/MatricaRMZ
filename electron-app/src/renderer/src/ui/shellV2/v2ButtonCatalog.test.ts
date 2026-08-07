import { describe, expect, it } from 'vitest';

import type { MenuTabId } from '../layout/Tabs.js';
import { buildV2Buttons } from './v2ButtonCatalog.js';

const ALL: MenuTabId[] = ['engines', 'work_orders', 'parts', 'contracts', 'employees', 'admin', 'stock_balances'];
const EMPTY_LAYOUT = { pinned: [], hidden: [], order: [] };

function allItems(buttons: ReturnType<typeof buildV2Buttons>): MenuTabId[] {
  return buttons.sections.flatMap((s) => s.items.map((b) => b.id as MenuTabId));
}

describe('buildV2Buttons — планшетное операторское меню', () => {
  it('в режиме «Комп» меню полное', () => {
    const b = buildV2Buttons(ALL, {}, EMPTY_LAYOUT, false);
    expect(allItems(b)).toEqual(expect.arrayContaining(['contracts', 'employees', 'admin']));
  });

  it('в режиме «Планшет» остаются только разделы пресета', () => {
    const b = buildV2Buttons(ALL, {}, EMPTY_LAYOUT, true);
    const navIds = allItems(b).filter((id) => !['theme','tablet_mode','decor','palette','search','basket','column_mode','sync','chat_link','notes_link','chat','ai_chat','user'].includes(id));
    expect(navIds.sort()).toEqual(['engines', 'parts', 'stock_balances', 'work_orders']);
  });

  it('закреплённый бухгалтерский раздел не пролезает в планшет через pinned', () => {
    const b = buildV2Buttons(ALL, {}, { pinned: ['contracts'], hidden: [], order: [] }, true);
    expect(b.pinned.map((x) => x.id)).toEqual([]);
    expect(allItems(b)).not.toContain('contracts');
  });

  it('спрятанные бухгалтерские разделы не всплывают в списке «восстановить»', () => {
    const b = buildV2Buttons(ALL, {}, { pinned: [], hidden: ['admin'], order: [] }, true);
    expect(b.hidden.map((x) => x.id)).toEqual([]);
  });

  it('пресет не расширяет меню сверх прав: недоступный таб не появляется', () => {
    const b = buildV2Buttons(['engines'], {}, EMPTY_LAYOUT, true);
    expect(allItems(b)).toContain('engines');
    expect(allItems(b)).not.toContain('contracts');
  });
});
