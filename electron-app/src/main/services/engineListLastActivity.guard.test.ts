import { describe, expect, it } from 'vitest';

import { COUNTDOWN_STALE_DAYS, PRIMARY_CONTRACT_SECTION_KEY, countdownStatus } from '@matricarmz/shared';

// Сторож поля `lastActivityAt` строки списка двигателей: listEngines берёт МАКСИМУМ из даты
// любой операции (сгруппированный запрос по operations) и уже посчитанных дат истории ремонта
// и этапа работ. Сам listEngines тянет за собой всю схему EAV, поэтому здесь воспроизведена
// ровно эта формула — и следом то, ради чего она нужна: по этой дате индикатор срока решает,
// горит карточка или по ней просто не закрыт учёт (владелец 22.09.2026).
function lastActivityForRow(input: {
  fromOperations?: number;
  lastHistoryAt?: number;
  lastSheetAt?: number;
}): number {
  return Math.max(input.fromOperations ?? 0, input.lastHistoryAt ?? 0, input.lastSheetAt ?? 0);
}

const TODAY_ISO = '2026-09-22';
/** Поступил в январе: срок ремонта давно вышел, без работ карточка была бы красной. */
const ARRIVAL_ISO = '2026-01-01';
const SLOT = { id: '', sectionKey: PRIMARY_CONTRACT_SECTION_KEY, payments: [] };

function ms(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function countdownFor(lastActivityAt: number) {
  return countdownStatus(SLOT, TODAY_ISO, false, {
    arrivalIso: ARRIVAL_ISO,
    lastActivityIso: lastActivityAt > 0 ? isoDay(lastActivityAt) : null,
  });
}

describe('дата последней работы в строке списка двигателей', () => {
  it('давняя история ремонта, но свежий акт: двигатель считается живым и горит', () => {
    // Акт дефектовки — операция НЕ того типа, что читает lastHistoryAt: по одной истории
    // ремонта двигатель выглядел бы брошенным год назад.
    const lastActivityAt = lastActivityForRow({
      fromOperations: ms('2026-09-19'),
      lastHistoryAt: ms('2025-08-01'),
    });
    expect(isoDay(lastActivityAt)).toBe('2026-09-19');
    expect(countdownFor(lastActivityAt).state).toBe('danger');
  });

  it('без свежей операции та же карточка числится забытой, а не просроченной', () => {
    const lastActivityAt = lastActivityForRow({ lastHistoryAt: ms('2025-08-01') });
    const status = countdownFor(lastActivityAt);
    expect(status.state).toBe('stale');
    expect(status.daysIdle ?? 0).toBeGreaterThan(COUNTDOWN_STALE_DAYS);
  });

  it('операция не попала в выборку: берём дату истории/этапа, строка не мертвее, чем есть', () => {
    const lastActivityAt = lastActivityForRow({
      lastHistoryAt: ms('2026-09-10'),
      lastSheetAt: ms('2026-09-18'),
    });
    expect(isoDay(lastActivityAt)).toBe('2026-09-18');
    expect(countdownFor(lastActivityAt).state).toBe('danger');
  });
});
