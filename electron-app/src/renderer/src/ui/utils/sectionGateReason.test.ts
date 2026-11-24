import { describe, expect, it } from 'vitest';

import { sectionGateReason, sectionGateReasonText } from './sectionGateReason.js';

// Раздел не должен исчезать молча (промт КАРМАНА #84): оператор должен
// узнать, каким фильтром его срезали. Проверяем чистую логику — интерфейс
// (App.tsx) только показывает её словами.
describe('причина среза раздела', () => {
  it('открытый раздел не имеет причины', () => {
    expect(sectionGateReason({ allowedByRight: true, allowedByMembership: true, allowedByTabletPreset: true })).toBeNull();
  });

  it('нет права — первая причина, даже если раздел ещё и не выдан', () => {
    expect(
      sectionGateReason({ allowedByRight: false, allowedByMembership: false, allowedByTabletPreset: false }),
    ).toBe('no_right');
  });

  it('раздел не выдан учётной записи', () => {
    expect(
      sectionGateReason({ allowedByRight: true, allowedByMembership: false, allowedByTabletPreset: false }),
    ).toBe('no_membership');
  });

  it('раздел не входит в пресет клиента', () => {
    expect(
      sectionGateReason({ allowedByRight: true, allowedByMembership: true, allowedByTabletPreset: false }),
    ).toBe('not_in_tablet_preset');
  });

  it('тексты причин различаются и читаются оператором', () => {
    const texts = (['no_right', 'no_membership', 'not_in_tablet_preset'] as const).map(sectionGateReasonText);
    expect(new Set(texts).size, 'причины не должны звучать одинаково').toBe(3);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(5);
      expect(text).not.toMatch(/undefined|reason/i);
    }
  });
});
