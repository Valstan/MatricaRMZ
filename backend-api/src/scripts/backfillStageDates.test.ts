import { describe, expect, it } from 'vitest';

import { isFutureDate, parseEavDate, stageRowId } from './backfillStageDates.js';

// Бэкфилл недостающих этапов «Отгрузка»/«Приёмка заказчиком» из дат карточки
// (дефект 07.10.2026: даты писались, этапы у ролей без `work_sheets.edit` — нет).

describe('stageRowId — детерминированный id (повтор не плодит)', () => {
  it('тот же вход — тот же id, другой день — другой', () => {
    const a = stageRowId('eng-1', 'shipped', '2026-10-05');
    expect(a).toBe(stageRowId('eng-1', 'shipped', '2026-10-05'));
    expect(a).not.toBe(stageRowId('eng-1', 'shipped', '2026-10-06'));
    expect(a).not.toBe(stageRowId('eng-2', 'shipped', '2026-10-05'));
    expect(a).not.toBe(stageRowId('eng-1', 'accepted', '2026-10-05'));
  });

  it('формат uuid', () => {
    expect(stageRowId('eng-1', 'shipped', '2026-10-05')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe('parseEavDate — обе формы значения + строка-число', () => {
  it('число и строка-число', () => {
    expect(parseEavDate(1788814800000)).toBe(1788814800000);
    expect(parseEavDate('1788814800000')).toBe(1788814800000);
  });

  it('объект {kind:"date", value}', () => {
    expect(parseEavDate('{"kind":"date","value":1789938000000}')).toBe(1789938000000);
  });

  it('мусор и пустое — null (дату не выдумываем)', () => {
    expect(parseEavDate(null)).toBeNull();
    expect(parseEavDate('')).toBeNull();
    expect(parseEavDate('не дата')).toBeNull();
    expect(parseEavDate('{"kind":"date"}')).toBeNull();
    expect(parseEavDate(-100)).toBeNull();
  });
});

describe('isFutureDate — факт ремонта не в будущем', () => {
  const now = 1_800_000_000_000;
  it('прошлое и сегодня — не будущее', () => {
    expect(isFutureDate(now - 86_400_000, now)).toBe(false);
    expect(isFutureDate(now, now)).toBe(false);
  });
  it('дальше суток вперёд — будущее (пропуск)', () => {
    expect(isFutureDate(now + 2 * 86_400_000, now)).toBe(true);
  });
});
