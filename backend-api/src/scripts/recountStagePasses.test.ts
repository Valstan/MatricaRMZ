import { describe, expect, it } from 'vitest';

import type { DatedStage } from '@matricarmz/shared';

import { recountVerdict } from './recountStagePasses.js';

const DAY1 = Date.UTC(2026, 9, 6, 21, 0, 0);
const DAY2 = Date.UTC(2026, 9, 7, 21, 0, 0);

function sib(code: string, at: number, id = 'sib'): DatedStage {
  return { code: code as DatedStage['code'], at, id };
}

function row(patch: { id?: string; code?: string; at?: number; pass?: number; reason?: string }) {
  return { id: 'r1', code: 'sborka', at: DAY1, pass: 2, reason: '', ...patch };
}

describe('recountVerdict — снять только ложные системные пометки', () => {
  it('поздно внесённая сборка с ранней датой — clear', () => {
    expect(recountVerdict(row({}), [sib('shipped', DAY2)])).toBe('clear');
  });

  it('настоящий возврат (сборка позже обкатки) — keep', () => {
    expect(recountVerdict(row({ at: DAY2 }), [sib('obkatka', DAY1)])).toBe('keep');
  });

  it('подтверждение оператора не трогаем даже при ложных датах', () => {
    expect(recountVerdict(row({ reason: 'вернули из ОТК' }), [sib('shipped', DAY2)])).toBe('keep-operator');
  });

  it('первый проход — keep', () => {
    expect(recountVerdict(row({ pass: 1 }), [sib('shipped', DAY2)])).toBe('keep');
  });

  it('строка не сравнивает саму с собой', () => {
    expect(recountVerdict(row({ id: 'r1' }), [sib('sborka', DAY1, 'r1')])).toBe('clear');
  });
});
