import { describe, expect, it } from 'vitest';

import {
  STUCK_PENDING_MINUTES,
  emptyStuckPendingSummary,
  formatStuckPendingReport,
  isStuckPending,
  stuckAgeMinutes,
  stuckPendingCutoff,
} from './stuckPending.js';

describe('порог «застряло»', () => {
  it('по умолчанию 15 минут — синк ходит раз в минуту, строка старше — уже не в пути', () => {
    expect(STUCK_PENDING_MINUTES).toBe(15);
  });

  it('отсечка отступает на порог назад', () => {
    const now = 1_700_000_000_000;
    expect(stuckPendingCutoff(now)).toBe(now - 15 * 60_000);
    expect(stuckPendingCutoff(now, 30)).toBe(now - 30 * 60_000);
  });

  it('строка старше отсечки — застряла, свежая — нет', () => {
    const now = 1_700_000_000_000;
    expect(isStuckPending(now - 20 * 60_000, now)).toBe(true);
    expect(isStuckPending(now - 14 * 60_000, now)).toBe(false);
    expect(isStuckPending(now, now)).toBe(false);
  });

  it('без времени правки строка застрявшей не считается — неизвестное не страшнее нуля', () => {
    const now = 1_700_000_000_000;
    expect(isStuckPending(null, now)).toBe(false);
    expect(isStuckPending(undefined, now)).toBe(false);
    expect(isStuckPending(0, now)).toBe(false);
    expect(isStuckPending(Number.NaN, now)).toBe(false);
  });

  it('пустая сводка честная: ноль и нет времени', () => {
    expect(emptyStuckPendingSummary()).toEqual({ count: 0, oldestPendingAt: null, thresholdMinutes: 15 });
  });

  it('возраст в минутах округляется вверх — меньше минуты тоже говорим', () => {
    const now = 1_700_000_000_000;
    expect(stuckAgeMinutes(now - 30_000, now)).toBe(1);
    expect(stuckAgeMinutes(now - 5 * 60_000, now)).toBe(5);
    expect(stuckAgeMinutes(null, now)).toBe(0);
  });
});

describe('отчёт администратору о застрявшей очереди', () => {
  const NOW = Date.parse('2026-11-19T10:00:00Z');
  const stuck = {
    count: 617,
    oldestPendingAt: NOW - 83 * 60_000,
    thresholdMinutes: 15,
    byTable: [
      { table: 'attribute_values', n: 617, oldestPendingAt: NOW - 83 * 60_000 },
      { table: 'entities', n: 3, oldestPendingAt: NOW - 20 * 60_000 },
    ],
    lastError: 'sync failed: server rejected row',
    lastSyncAt: NOW - 90 * 60_000,
  };

  it('в отчёте есть всё, без чего разбор не начать: машина, время, оператор, по таблицам, причина', () => {
    const text = formatStuckPendingReport({
      clientId: 'rmz4val-1a2b3c4d-1111-2222-3333-444455556666',
      clientName: 'rmz4val',
      operator: { username: 'operator', fullName: 'Иванов Иван Иванович', position: 'инженер' },
      stuck,
      detectedAt: NOW,
      trigger: 'manual',
      appVersion: '3.134.0',
    });
    expect(text).toContain('Машина: rmz4val');
    expect(text).toContain('83 мин');
    expect(text).toContain('Иванов Иван Иванович');
    expect(text).toContain('инженер');
    expect(text).toContain('attribute_values: 617');
    expect(text).toContain('entities: 3');
    expect(text).toContain('sync failed: server rejected row');
    expect(text).toContain('3.134.0');
    expect(text).toContain('оператор нажал');
  });

  it('без оператора и без машины отчёт всё равно читается — «неизвестно» вместо пустоты', () => {
    const text = formatStuckPendingReport({
      clientId: '',
      stuck: { ...stuck, byTable: [] },
      detectedAt: NOW,
      trigger: 'auto',
    });
    expect(text).toContain('оператор неизвестен');
    expect(text).toContain('клиент неизвестен');
    expect(text).toContain('сработало автоматически');
  });

  it('таблицы в отчёте идут от большего к меньшему — по самой большой видно и причину', () => {
    const text = formatStuckPendingReport({
      clientId: 'c-1',
      stuck,
      detectedAt: NOW,
    });
    expect(text.indexOf('attribute_values: 617')).toBeLessThan(text.indexOf('entities: 3'));
  });
});
