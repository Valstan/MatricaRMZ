import { describe, expect, it, vi } from 'vitest';

vi.mock('../../database/db.js', () => ({ db: {}, pool: { query: vi.fn() } }));

import { isPermanentSkipReason } from './ledgerTxService.js';

describe('isPermanentSkipReason — ретрай бессмыслен (09.10.2026)', () => {
  it('forbidden — permanent, reserved — нет', () => {
    expect(isPermanentSkipReason('forbidden:repair_stage_row')).toBe(true);
    expect(isPermanentSkipReason('forbidden:contract')).toBe(true);
    expect(isPermanentSkipReason('reserved:ivanov:1791497177309')).toBe(false);
  });

  it('invalid_reference — только на удалённое', () => {
    expect(isPermanentSkipReason('invalid_reference: [{"path":"x","referenceId":"y","reason":"deleted"}]')).toBe(true);
    expect(isPermanentSkipReason('invalid_reference: [{"path":"x","referenceId":"y","reason":"not_found"}]')).toBe(false);
  });

  it('гейты дублей карточки (b34e8518, 10.10.2026) — permanent', () => {
    expect(isPermanentSkipReason('engine_number_dup')).toBe(true);
    expect(isPermanentSkipReason('engine_pair_dup')).toBe(true);
  });

  it('прочее (missing_dependency и т.п.) — временное', () => {
    expect(isPermanentSkipReason('missing_dependency')).toBe(false);
    expect(isPermanentSkipReason('')).toBe(false);
  });
});
