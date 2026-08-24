import { describe, expect, it } from 'vitest';

import {
  DIGEST_TITLE,
  formatPersonLabel,
  isoWeekKey,
  reportLabelForPresetId,
} from '../services/ai/aiUsageDigestService.js';

describe('aiUsageDigestService pure helpers', () => {
  it('isoWeekKey follows ISO-8601 week numbering', () => {
    expect(isoWeekKey(2026, 8, 10)).toBe('2026-W33'); // Monday
    expect(isoWeekKey(2026, 8, 16)).toBe('2026-W33'); // Sunday of the same week
    expect(isoWeekKey(2026, 8, 17)).toBe('2026-W34'); // next Monday
    // year boundary: 2026-01-01 (Thursday) belongs to W01 of 2026
    expect(isoWeekKey(2026, 1, 1)).toBe('2026-W01');
    // 2027-01-01 (Friday) belongs to the last ISO week of 2026
    expect(isoWeekKey(2027, 1, 1)).toBe('2026-W53');
    expect(isoWeekKey(2026, 12, 28)).toBe('2026-W53');
  });

  it('formatPersonLabel prefers ФИО (login) and never drops an operator', () => {
    const names = { ivanova: 'Иванова Мария Петровна' };
    expect(formatPersonLabel('ivanova', names)).toBe('Иванова Мария Петровна (ivanova)');
    expect(formatPersonLabel('IVANOVA', names)).toBe('Иванова Мария Петровна (IVANOVA)');
    expect(formatPersonLabel('ghost', names)).toBe('ghost');
    expect(formatPersonLabel('', names)).toBe('—');
  });

  it('reportLabelForPresetId maps known presets and quotes unknown ids', () => {
    expect(reportLabelForPresetId('parts_demand')).toBe('Потребность в деталях');
    expect(reportLabelForPresetId('engine_stages')).toBe('Стадии двигателей по контрактам');
    expect(reportLabelForPresetId('no_such_preset')).toBe('«no_such_preset»');
    expect(reportLabelForPresetId('')).toBe('—');
  });

  it('digest title matches the old routine title (dedupe filter depends on it)', () => {
    expect(DIGEST_TITLE).toBe('📊 Еженедельный отчёт по использованию программы');
  });
});
