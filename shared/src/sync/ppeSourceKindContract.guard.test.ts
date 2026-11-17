// Сторож: контракт синка не должен отставать от домена — и в источнике строки.
//
// 17.11.2026 в домен добавили третий источник строки — `local` (заводская норма:
// вещь, которой в приказе 767н нет, но её выдают по решению владельца). Перечисление
// в DTO жило отдельно и нового источника не знало: строка не проходила валидатор,
// и ВЕСЬ проход зеркала СИЗ падал на `sync_invalid_row: ppe_norm_line_specs` —
// новые нормы не доходили до парка, а обновления СИЗ не проходили вовсе.
//
// Теперь список один (`PPE_SOURCE_KINDS`), а этот тест падает, если в контракт
// вернётся источник, которого в домене нет, или если из контракта выпадет
// источник, который в домене есть.
import { describe, expect, it } from 'vitest';

import { PPE_SOURCE_KINDS } from '../domain/ppe.js';
import { ppeNormLineSpecRowSchema, ppeNormSetRowSchema } from './dto.js';

const SCHEMAS: Array<[string, { shape: { source_kind: { safeParse: (v: unknown) => { success: boolean } } } }]> = [
  ['ppe_norm_line_specs', ppeNormLineSpecRowSchema],
  ['ppe_norm_sets', ppeNormSetRowSchema],
];

describe('контракт синка: источник строки приказа', () => {
  it('принимает каждый источник, который есть в домене', () => {
    for (const [table, schema] of SCHEMAS) {
      for (const kind of PPE_SOURCE_KINDS) {
        expect(
          schema.shape.source_kind.safeParse(kind).success,
          `${table}: источник «${kind}» не проходит валидатор контракта`,
        ).toBe(true);
      }
    }
  });

  it('в домене есть источники, из-за которых зеркало уже падало', () => {
    // `local` — заводская норма (решение владельца 17.11.2026), `ton` — ЕТН 767н,
    // `order766` — приказ 766н Прил.4. Все три обязаны жить в контракте.
    expect(PPE_SOURCE_KINDS).toContain('local');
    expect(PPE_SOURCE_KINDS).toContain('ton');
    expect(PPE_SOURCE_KINDS).toContain('order766');
  });
});
