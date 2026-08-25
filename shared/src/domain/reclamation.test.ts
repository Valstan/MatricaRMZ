import { describe, expect, it } from 'vitest';

import {
  DEFECT_NATURE_SEED_LABELS,
  DEFECT_NATURE_TYPE_CODE,
  RECLAMATION_ATTR_CODES,
  RECLAMATION_LEGACY_ATTR_CODES,
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

// Переделка вкладки под разбор по акту исследования (план reclamation-tab-redesign-2026-08).
describe('reclamation redesign 2026-08', () => {
  it('counts the new fields as reclamation data', () => {
    expect(hasReclamationData({ reclamation_actual_defect: 'задир шейки вала' })).toBe(true);
    expect(hasReclamationData({ reclamation_defect_nature: 'Производственный' })).toBe(true);
    expect(hasReclamationData({ reclamation_act_number: '14/26' })).toBe(true);
    expect(RECLAMATION_ATTR_CODES).toContain('reclamation_actual_defect');
    expect(RECLAMATION_ATTR_CODES).toContain('reclamation_defect_nature_id');
    expect(RECLAMATION_ATTR_CODES).toContain('reclamation_defect_nature');
    expect(RECLAMATION_ATTR_CODES).toContain('reclamation_act_number');
    expect(RECLAMATION_ATTR_CODES).toContain('reclamation_attachments');
  });

  it('does not mistake an empty attachment list for filled data', () => {
    expect(hasReclamationData({ reclamation_attachments: [] })).toBe(false);
    expect(hasReclamationData({ reclamation_attachments: '[]' })).toBe(false);
    expect(hasReclamationData({ reclamation_attachments: '' })).toBe(false);
    expect(hasReclamationData({ reclamation_attachments: [{ id: 'f1' }] })).toBe(true);
    expect(hasReclamationData({ reclamation_attachments: '[{"id":"f1"}]' })).toBe(true);
  });

  it('keeps the retired codes listed but marked as legacy', () => {
    expect(RECLAMATION_LEGACY_ATTR_CODES).toEqual(['reclamation_verdict', 'reclamation_repair_status']);
    for (const code of RECLAMATION_LEGACY_ATTR_CODES) {
      expect(RECLAMATION_ATTR_CODES).toContain(code);
    }
  });

  it('seeds the defect nature dictionary with the four agreed items in order', () => {
    expect(DEFECT_NATURE_TYPE_CODE).toBe('defect_nature');
    expect(DEFECT_NATURE_SEED_LABELS).toEqual([
      'Производственный',
      'Эксплуатационный',
      'Конструктивный',
      'Дефект КИ',
    ]);
  });
});
