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

  it('suggests a database option across separators (compact-substring 2401 ≡ 240-1)', () => {
    const items = buildAssistPopupItems({
      value: '2401',
      historyEntries: [],
      databaseOptions: ['240-1', '999'],
      databaseOnly: false,
    });
    const sources = items.filter((item) => item.kind === 'source').map((item) => item.value);
    expect(sources).toContain('240-1');
    expect(sources).not.toContain('999');
  });

  it('suggests by multi-token AND regardless of token order', () => {
    const items = buildAssistPopupItems({
      value: 'бета альфа',
      historyEntries: [],
      databaseOptions: ['альфа бета гамма', 'дельта'],
      databaseOnly: false,
    });
    const sources = items.filter((item) => item.kind === 'source').map((item) => item.value);
    expect(sources).toContain('альфа бета гамма');
    expect(sources).not.toContain('дельта');
  });

  it('ranks prefix matches ahead of mid-string matches', () => {
    const items = buildAssistPopupItems({
      value: 'д',
      historyEntries: [],
      databaseOptions: ['АД-2', 'Д-1'],
      databaseOnly: false,
    });
    const sources = items.filter((item) => item.kind === 'source').map((item) => item.value);
    expect(sources[0]).toBe('Д-1');
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
