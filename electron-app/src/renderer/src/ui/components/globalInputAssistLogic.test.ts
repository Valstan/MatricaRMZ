import { describe, expect, it } from 'vitest';

import { buildAssistPopupItems, canRememberAssistValue } from './globalInputAssistLogic.js';

describe('globalInputAssistLogic', () => {
  it('shows history when field is empty', () => {
    const items = buildAssistPopupItems({
      value: '',
      historyEntries: ['А-1', 'А-2'],
      databaseOptions: null,
      databaseOnly: false,
    });
    expect(items.map((item) => item.value)).toEqual(['А-1', 'А-2']);
    expect(items.every((item) => item.kind === 'history')).toBe(true);
  });

  it('shows first database options when field is empty', () => {
    const items = buildAssistPopupItems({
      value: '',
      historyEntries: [],
      databaseOptions: ['Д-1', 'Д-2', 'Д-3', 'Д-4', 'Д-5', 'Д-6', 'Д-7'],
      databaseOnly: true,
    });
    expect(items.map((item) => item.value)).toEqual(['Д-1', 'Д-2', 'Д-3', 'Д-4', 'Д-5']);
    expect(items.every((item) => item.kind === 'source')).toBe(true);
  });

  it('filters history to database options only in database mode', () => {
    const items = buildAssistPopupItems({
      value: 'Д-1',
      historyEntries: ['черновик', 'Д-2'],
      databaseOptions: ['Д-1', 'Д-2'],
      databaseOnly: true,
    });
    expect(items.map((item) => item.value)).toEqual(['Д-1', 'Д-2']);
    expect(items.some((item) => item.value === 'черновик')).toBe(false);
  });

  it('does not remember invalid manual database input', () => {
    expect(
      canRememberAssistValue({
        value: 'черновик',
        databaseOptions: ['Д-1', 'Д-2'],
        databaseOnly: true,
      }),
    ).toBe(false);
    expect(
      canRememberAssistValue({
        value: 'Д-2',
        databaseOptions: ['Д-1', 'Д-2'],
        databaseOnly: true,
      }),
    ).toBe(true);
  });
});
