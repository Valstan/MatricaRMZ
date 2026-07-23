import { describe, expect, it } from 'vitest';

import { isScrapEngine, type StatusCode } from '@matricarmz/shared';

// Подсветка утиля в списке двигателей и утиль в отчётах должны считаться по одним меткам.
// До 2026-07-23 список видел только «Забракован» + картер в утиле, а отчёты — «Признан утильным»
// / «Утиль — отправлен заказчику»: двигатель, помеченный утильным, в списке выглядел обычным.

function listIsScrap(flags: Partial<Record<StatusCode, boolean>>, crankcaseScrapped = false): boolean {
  const statusRejected = flags.status_rejected === true;
  const statusScrapMarked = isScrapEngine(flags);
  return statusRejected || statusScrapMarked || crankcaseScrapped;
}

describe('признак утиля в списке двигателей', () => {
  it('подсвечивает двигатель, помеченный «Признан утильным»', () => {
    expect(listIsScrap({ status_scrap_confirmed: true })).toBe(true);
  });

  it('подсвечивает «Утиль — отправлен заказчику»', () => {
    expect(listIsScrap({ status_rework_sent: true })).toBe(true);
  });

  it('по-прежнему подсвечивает «Забракован» и картер в утиле', () => {
    expect(listIsScrap({ status_rejected: true })).toBe(true);
    expect(listIsScrap({}, true)).toBe(true);
  });

  it('обычный двигатель не подсвечивается', () => {
    expect(listIsScrap({ status_repair_started: true, status_repaired: true })).toBe(false);
    expect(listIsScrap({})).toBe(false);
  });

  it('совпадает с тем, что считает утилем shared (отчёты и гейт наряда)', () => {
    for (const code of ['status_scrap_confirmed', 'status_rework_sent'] as StatusCode[]) {
      const flags = { [code]: true } as Partial<Record<StatusCode, boolean>>;
      expect(listIsScrap(flags)).toBe(isScrapEngine(flags));
    }
  });
});
