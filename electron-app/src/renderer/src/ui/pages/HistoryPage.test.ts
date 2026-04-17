import { describe, expect, it } from 'vitest';

import { __historyPageTestUtils } from './HistoryPage.js';

describe('HistoryPage pinned shortcuts', () => {
  it('resolves report shortcut deep-link with reportPresetId', () => {
    const tile = __historyPageTestUtils.resolveShortcutTile('report:assembly_forecast_7d', [
      { id: 'assembly_forecast_7d', title: 'Прогноз сборки двигателей' },
    ]);

    expect(tile).not.toBeNull();
    expect(tile?.title).toBe('Прогноз сборки двигателей');
    expect(tile?.link).toMatchObject({
      kind: 'app_link',
      tab: 'report_preset',
      reportPresetId: 'assembly_forecast_7d',
    });
  });

  it('returns null for unknown report shortcut', () => {
    const tile = __historyPageTestUtils.resolveShortcutTile('report:missing', [
      { id: 'assembly_forecast_7d', title: 'Прогноз сборки двигателей' },
    ]);
    expect(tile).toBeNull();
  });
});
