import { describe, expect, it } from 'vitest';

import { describeRejectedRow, syncRejectReasonLabel, syncTableLabel } from './syncRejected.js';

describe('syncRejected — подписи rejected-строк для баннера', () => {
  it('таблица по-русски, неизвестная — как есть', () => {
    expect(syncTableLabel('operations')).toBe('Операция');
    expect(syncTableLabel('whatever')).toBe('whatever');
  });

  it('причины переводятся в человеческие', () => {
    expect(syncRejectReasonLabel('forbidden:repair_stage_row')).toBe('нет прав на запись');
    expect(syncRejectReasonLabel('missing_dependency')).toContain('ждёт данные');
    expect(syncRejectReasonLabel('invalid_reference: [{"reason":"deleted"}]')).toBe('ссылка на удалённое');
    expect(syncRejectReasonLabel('reserved:x:1')).toContain('уйдёт само');
  });

  it('строка описывается целиком с коротким id', () => {
    expect(describeRejectedRow({ table: 'operations', rowId: '12345678-aaaa', reason: 'missing_dependency' })).toContain(
      'Операция 12345678…',
    );
  });
});
