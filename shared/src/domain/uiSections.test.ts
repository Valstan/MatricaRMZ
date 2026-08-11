import { describe, expect, it } from 'vitest';

import { GROUP_LABELS, MENU_TAB_LABELS, groupForTab, resolveMenuTab, sectionLabelForTabKey } from './uiSections.js';

describe('uiSections', () => {
  it('maps menu tab keys to Russian labels', () => {
    expect(sectionLabelForTabKey('engines')).toBe('Двигатели');
    expect(sectionLabelForTabKey('timesheets')).toBe('Табель');
    expect(sectionLabelForTabKey('stock_balances')).toBe('Остатки');
  });

  it('maps detail tab keys through the parent menu tab', () => {
    expect(sectionLabelForTabKey('engine')).toBe('Двигатели');
    expect(sectionLabelForTabKey('work_order')).toBe('Наряды');
    expect(sectionLabelForTabKey('timesheet')).toBe('Табель');
    expect(sectionLabelForTabKey('report_preset')).toBe('Отчёты');
  });

  it('keeps unknown keys visible instead of dropping them', () => {
    expect(sectionLabelForTabKey('mystery_tab')).toBe('«mystery_tab»');
    expect(sectionLabelForTabKey('')).toBe('—');
    expect(sectionLabelForTabKey('  ')).toBe('—');
  });

  it('resolveMenuTab falls back to null for unknown keys', () => {
    expect(resolveMenuTab('engine')).toBe('engines');
    expect(resolveMenuTab('engines')).toBe('engines');
    expect(resolveMenuTab('nope')).toBeNull();
  });

  it('every menu tab has a label and a group', () => {
    for (const key of Object.keys(MENU_TAB_LABELS) as Array<keyof typeof MENU_TAB_LABELS>) {
      expect(MENU_TAB_LABELS[key]).toBeTruthy();
      expect(GROUP_LABELS[groupForTab(key)]).toBeTruthy();
    }
  });
});
