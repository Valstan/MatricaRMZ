import { describe, expect, it } from 'vitest';

import { sectionGateReason, sectionGateReasonText } from './sectionGateReason.js';

// Раздел не должен исчезать молча (промт КАРМАНА #84): оператор должен
// узнать, каким фильтром его срезали. Проверяем чистую логику — интерфейс
// (App.tsx) только показывает её словами.
//
// Промт КАРМАНА #142: третий фильтр — операторский пресет меню, а не рамка
// разделов для планшета. Правка на «не входит в операторский пресет» — иначе
// причина звучала бы как «урезано по платформе», а это и есть прежняя жалоба.
describe('причина среза раздела', () => {
  it('открытый раздел не имеет причины', () => {
    expect(sectionGateReason({ allowedByRight: true, allowedByMembership: true, allowedByOperatorPreset: true })).toBeNull();
  });

  it('нет права — первая причина, даже если раздел ещё и не выдан', () => {
    expect(
      sectionGateReason({ allowedByRight: false, allowedByMembership: false, allowedByOperatorPreset: false }),
    ).toBe('no_right');
  });

  it('раздел не выдан учётной записи', () => {
    expect(
      sectionGateReason({ allowedByRight: true, allowedByMembership: false, allowedByOperatorPreset: false }),
    ).toBe('no_membership');
  });

  it('раздел не входит в операторский пресет меню', () => {
    expect(
      sectionGateReason({ allowedByRight: true, allowedByMembership: true, allowedByOperatorPreset: false }),
    ).toBe('not_in_operator_preset');
  });

  it('тексты причин различаются и читаются оператором', () => {
    const texts = (['no_right', 'no_membership', 'not_in_operator_preset'] as const).map(sectionGateReasonText);
    expect(new Set(texts).size, 'причины не должны звучать одинаково').toBe(3);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(5);
      expect(text).not.toMatch(/undefined|reason/i);
    }
  });

  it('причина пресета говорит про НАСТРОЙКУ, а не про планшет', () => {
    // Прежний текст «раздел не входит в меню планшета» выглядел как «урезано по
    // платформе» — и это и было причиной жалобы «недостаточно прав».
    expect(sectionGateReasonText('not_in_operator_preset')).toContain('операторский пресет');
    expect(sectionGateReasonText('not_in_operator_preset')).not.toContain('планшет');
  });

  /**
   * Слепой источник membership (промт КАРМАНА #84, разбор планшета 25.11.2026):
   * клиент смотрит в ЗАМОРОЖЕННОЕ EAV-зеркало `section_access`, где разделов,
   * выданных после миграции 0103, нет ни у кого. Ответ такого источника не
   * авторитетен: «нет в зеркале» ≠ «не выдан». Раньше меню говорило «не выдан» —
   * и уводило людей искать выдачу прав, которой может и быть.
   */
  it('замороженное зеркало — причина не «не выдан», а «данные о доступах не обновлены»', () => {
    expect(
      sectionGateReason({
        allowedByRight: true,
        allowedByMembership: false,
        allowedByOperatorPreset: false,
        membershipSource: 'legacy_eav',
      }),
    ).toBe('no_membership_stale');
    expect(sectionGateReasonText('no_membership_stale')).toContain('не обновлены');
    expect(sectionGateReasonText('no_membership_stale')).toContain('синх');
  });

  it('из реплики причина прежняя — «не выдан» (ответ авторитетен)', () => {
    expect(
      sectionGateReason({
        allowedByRight: true,
        allowedByMembership: false,
        allowedByOperatorPreset: false,
        membershipSource: 'replica',
      }),
    ).toBe('no_membership');
  });

  it('право остаётся первой причиной даже при слепом источнике', () => {
    expect(
      sectionGateReason({
        allowedByRight: false,
        allowedByMembership: false,
        allowedByOperatorPreset: false,
        membershipSource: 'legacy_eav',
      }),
    ).toBe('no_right');
  });

  it('«нет доступа» и «данные не обновлены» — разные тексты', () => {
    expect(sectionGateReasonText('no_membership')).not.toBe(sectionGateReasonText('no_membership_stale'));
  });
});
