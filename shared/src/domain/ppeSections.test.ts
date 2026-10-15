import { describe, expect, it } from 'vitest';

import { ACCESS_SECTION_CATALOG, AccessSection } from './sectionAccess.js';
import { DEFAULT_GROUP_TABS, GROUP_LABELS, MENU_TAB_LABELS, groupForTab, resolveMenuTab } from './uiSections.js';

// Кладовщик (СИЗ): вкладки живут в своей группе «Кладовщик» (MVP — четыре,
// фаза 2 добавила группы, коллективную выдачу и импорт), доступом их держит
// раздел «Склад». Карточка ppe_card — детальная, родитель — список ppe_cards
// (подсветка меню). Тест ловит рассинхрон трёх словарей.
describe('ppe: вкладки Кладовщика в меню и доступах', () => {
  const tabs = ['ppe_cards', 'ppe_norms', 'ppe_groups', 'ppe_collective', 'ppe_import', 'ppe_stock', 'ppe_reports'] as const;

  it('все семь — пункты меню со своими подписями', () => {
    for (const t of tabs) {
      expect(resolveMenuTab(t)).toBe(t);
      expect(MENU_TAB_LABELS[t].length).toBeGreaterThan(0);
    }
    expect(MENU_TAB_LABELS.ppe_cards).toBe('Карточки СИЗ');
    expect(MENU_TAB_LABELS.ppe_norms).toBe('Нормы выдачи');
    expect(MENU_TAB_LABELS.ppe_collective).toBe('Коллективная выдача');
  });

  it('все семь — в группе «Кладовщик», и только они', () => {
    expect(DEFAULT_GROUP_TABS.workwear).toEqual([...tabs]);
    expect(GROUP_LABELS.workwear).toBe('Кладовщик');
    for (const t of tabs) expect(groupForTab(t)).toBe('workwear');
  });

  it('карточка ppe_card сводится к списку ppe_cards', () => {
    expect(resolveMenuTab('ppe_card')).toBe('ppe_cards');
  });

  it('раздел «Склад» открывает все семь вкладок', () => {
    const warehouse = ACCESS_SECTION_CATALOG.find((s) => s.id === AccessSection.Warehouse);
    expect(warehouse).toBeDefined();
    for (const t of tabs) expect(warehouse!.menuTabs).toContain(t);
  });
});
