import { describe, expect, it } from 'vitest';

import { ACCESS_SECTION_CATALOG, AccessSection } from './sectionAccess.js';
import { DEFAULT_GROUP_TABS, GROUP_LABELS, MENU_TAB_LABELS, groupForTab, resolveMenuTab } from './uiSections.js';

// Кладовщик (СИЗ), MVP, PR-4: четыре вкладки живут в своей группе «Кладовщик»,
// доступом их держит раздел «Склад». Карточка ppe_card — детальная, родитель —
// список ppe_cards (подсветка меню). Тест ловит рассинхрон трёх словарей.
describe('ppe: вкладки Кладовщика в меню и доступах', () => {
  const tabs = ['ppe_cards', 'ppe_norms', 'ppe_stock', 'ppe_reports'] as const;

  it('все четыре — пункты меню со своими подписями', () => {
    for (const t of tabs) {
      expect(resolveMenuTab(t)).toBe(t);
      expect(MENU_TAB_LABELS[t].length).toBeGreaterThan(0);
    }
    expect(MENU_TAB_LABELS.ppe_cards).toBe('Карточки СИЗ');
    expect(MENU_TAB_LABELS.ppe_norms).toBe('Нормы выдачи');
  });

  it('все четыре — в группе «Кладовщик», и только они', () => {
    expect(DEFAULT_GROUP_TABS.workwear).toEqual([...tabs]);
    expect(GROUP_LABELS.workwear).toBe('Кладовщик');
    for (const t of tabs) expect(groupForTab(t)).toBe('workwear');
  });

  it('карточка ppe_card сводится к списку ppe_cards', () => {
    expect(resolveMenuTab('ppe_card')).toBe('ppe_cards');
  });

  it('раздел «Склад» открывает все четыре вкладки', () => {
    const warehouse = ACCESS_SECTION_CATALOG.find((s) => s.id === AccessSection.Warehouse);
    expect(warehouse).toBeDefined();
    for (const t of tabs) expect(warehouse!.menuTabs).toContain(t);
  });
});
