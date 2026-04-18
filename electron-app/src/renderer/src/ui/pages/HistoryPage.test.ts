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

  it('falls back to preset id title when preset is not in the loaded list', () => {
    const tile = __historyPageTestUtils.resolveShortcutTile('report:assembly_forecast_7d', []);
    expect(tile).not.toBeNull();
    expect(tile?.title).toBe('Отчёт (assembly_forecast_7d)');
    expect(tile?.link).toMatchObject({
      kind: 'app_link',
      tab: 'report_preset',
      reportPresetId: 'assembly_forecast_7d',
    });
  });
});
