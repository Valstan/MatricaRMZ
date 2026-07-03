import { describe, expect, it } from 'vitest';

import {
  RECLAMATION_REPAIR_STATUS_LABELS,
  RECLAMATION_VERDICT_LABELS,
  hasReclamationData,
  isReclamationEngine,
  isReclamationRepairStatus,
  isReclamationVerdict,
} from './reclamation.js';

describe('reclamation domain', () => {
  it('flag drives isReclamationEngine', () => {
    expect(isReclamationEngine({ reclamation_flag: true })).toBe(true);
    expect(isReclamationEngine({ reclamation_flag: false })).toBe(false);
    expect(isReclamationEngine({})).toBe(false);
    expect(isReclamationEngine(null)).toBe(false);
  });

  it('hasReclamationData detects any filled field', () => {
    expect(hasReclamationData(null)).toBe(false);
    expect(hasReclamationData({})).toBe(false);
    expect(hasReclamationData({ reclamation_flag: false })).toBe(false);
    expect(hasReclamationData({ reclamation_comment: '   ' })).toBe(false);
    expect(hasReclamationData({ reclamation_flag: true })).toBe(true);
    expect(hasReclamationData({ reclamation_customer_reason: 'стук' })).toBe(true);
    expect(hasReclamationData({ reclamation_accepted_date: 1750000000000 })).toBe(true);
    // Чужие атрибуты двигателя не считаются рекламацией
    expect(hasReclamationData({ engine_number: 'X', status_repaired: true })).toBe(false);
  });

  it('verdict/repair-status guards accept only known codes', () => {
    expect(isReclamationVerdict('our_fault')).toBe(true);
    expect(isReclamationVerdict('customer_fault')).toBe(true);
    expect(isReclamationVerdict('not_confirmed')).toBe(true);
    expect(isReclamationVerdict('guilty')).toBe(false);
    expect(isReclamationVerdict('')).toBe(false);
    expect(isReclamationRepairStatus('accepted')).toBe(true);
    expect(isReclamationRepairStatus('closed_no_repair')).toBe(true);
    expect(isReclamationRepairStatus('done')).toBe(false);
  });

  it('labels cover every enum code', () => {
    expect(Object.keys(RECLAMATION_VERDICT_LABELS)).toHaveLength(3);
    expect(Object.keys(RECLAMATION_REPAIR_STATUS_LABELS)).toHaveLength(4);
    for (const v of Object.values({ ...RECLAMATION_VERDICT_LABELS, ...RECLAMATION_REPAIR_STATUS_LABELS })) {
      expect(v.trim()).not.toBe('');
    }
  });
});
