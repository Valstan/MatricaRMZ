import { describe, expect, it } from 'vitest';

import { canToggleRepairedStatus, type RepairFundInstanceClassification } from '@matricarmz/shared';

import { planStampedInstanceCapture, type ResolvedInstance } from '../services/repairFundInstanceService.js';

function inst(
  nomenclatureId: string,
  stampedNumber: string,
  classification: RepairFundInstanceClassification = 'repairable',
): ResolvedInstance {
  return { nomenclatureId, partId: nomenclatureId, partLabel: 'Деталь', stampedNumber, classification };
}

describe('planStampedInstanceCapture (Ф3 идемпотентность)', () => {
  it('новые экземпляры → все на вставку', () => {
    const plan = planStampedInstanceCapture(new Map(), [inst('n1', 'A-1'), inst('n2', 'B-2', 'scrap')]);
    expect(plan.added).toBe(2);
    expect(plan.updated).toBe(0);
    expect(plan.unchanged).toBe(0);
    expect(plan.inserts).toHaveLength(2);
    expect(plan.inserts.every((i) => i.replacesOpId === null)).toBe(true);
  });

  it('повтор с той же классификацией → no-op (сохраняет продвинутый статус)', () => {
    const prior = new Map([['n1|a-1', { opId: 'op1', classification: 'repairable' as const }]]);
    const plan = planStampedInstanceCapture(prior, [inst('n1', 'A-1')]);
    expect(plan.unchanged).toBe(1);
    expect(plan.added).toBe(0);
    expect(plan.inserts).toHaveLength(0);
  });

  it('смена классификации → перезапись (soft-delete прежней + вставка)', () => {
    const prior = new Map([['n1|a-1', { opId: 'op1', classification: 'repairable' as const }]]);
    const plan = planStampedInstanceCapture(prior, [inst('n1', 'A-1', 'scrap')]);
    expect(plan.updated).toBe(1);
    expect(plan.added).toBe(0);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]!.replacesOpId).toBe('op1');
    expect(plan.inserts[0]!.instance.classification).toBe('scrap');
  });

  it('ключ нечувствителен к регистру номера; дубли во входе схлопываются', () => {
    const plan = planStampedInstanceCapture(new Map(), [inst('n1', 'A-1'), inst('n1', 'a-1')]);
    expect(plan.total).toBe(1);
    expect(plan.inserts).toHaveLength(1);
  });

  it('пустой nomenclatureId/номер отбрасывается', () => {
    const plan = planStampedInstanceCapture(new Map(), [inst('', 'A-1'), inst('n1', '  ')]);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.total).toBe(0);
  });

  it('смешанная партия: один новый, один неизменный, один сменил классификацию', () => {
    const prior = new Map([
      ['n1|a-1', { opId: 'op1', classification: 'repairable' as const }],
      ['n2|b-2', { opId: 'op2', classification: 'repairable' as const }],
    ]);
    const plan = planStampedInstanceCapture(prior, [
      inst('n1', 'A-1'), // unchanged
      inst('n2', 'B-2', 'scrap'), // updated
      inst('n3', 'C-3', 'replace'), // added
    ]);
    expect(plan.unchanged).toBe(1);
    expect(plan.updated).toBe(1);
    expect(plan.added).toBe(1);
    expect(plan.inserts).toHaveLength(2);
  });
});

describe('canToggleRepairedStatus (Ф3.1 ручная отметка)', () => {
  it('in_fund и repaired переключаемы вручную', () => {
    expect(canToggleRepairedStatus('in_fund')).toBe(true);
    expect(canToggleRepairedStatus('repaired')).toBe(true);
  });

  it('терминальные scrapped/replaced вручную не меняются', () => {
    expect(canToggleRepairedStatus('scrapped')).toBe(false);
    expect(canToggleRepairedStatus('replaced')).toBe(false);
  });
});
