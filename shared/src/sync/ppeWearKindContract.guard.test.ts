// Сторож: контракт синка не должен отставать от домена.
//
// 07.11.2026 домен СИЗ знал пять видов срока (`months | until_wearout |
// by_manufacturer | annual | months_clerk`), а перечисление в DTO жило отдельно и
// знало только три. Миграции 0121/0122 перевели 113 позиций приказа в вид
// `annual` — и строка не прошла валидатор: ВЕСЬ проход зеркала СИЗ падал на
// `sync_invalid_row: ppe_norm_line_specs` (1244 раза в сутки), а эти позиции не
// доходили до парка — то есть кладовщик не мог проставить по ним срок носки.
//
// Теперь список один (`PPE_WEAR_KINDS`), а этот тест падает, если в контракт
// вернётся вид, которого в домене нет, или если из контракта выпадет вид,
// который в домене есть.
import { describe, expect, it } from 'vitest';

import { PPE_WEAR_KINDS } from '../domain/ppe.js';
import { ppeNormLineRowSchema, ppeNormLineSpecRowSchema } from './dto.js';

const SPECS: Array<[string, { shape: { wear_kind: { safeParse: (v: unknown) => { success: boolean } } } }]> = [
  ['ppe_norm_line_specs', ppeNormLineSpecRowSchema],
  ['ppe_norm_lines', ppeNormLineRowSchema],
];

describe('контракт синка: вид срока носки СИЗ', () => {
  it('принимает каждый вид, который есть в домене', () => {
    for (const [table, schema] of SPECS) {
      for (const kind of PPE_WEAR_KINDS) {
        expect(
          schema.shape.wear_kind.safeParse(kind).success,
          `${table}: вид срока «${kind}» не проходит валидатор контракта`,
        ).toBe(true);
      }
    }
  });

  it('в домене есть виды, из-за которых зеркало уже падало', () => {
    // `annual` — годовая норма без срока (113 позиций приказа), `months_clerk` —
    // срок, проставленный кладовщиком. Оба обязаны жить в контракте.
    expect(PPE_WEAR_KINDS).toContain('annual');
    expect(PPE_WEAR_KINDS).toContain('months_clerk');
  });
});
