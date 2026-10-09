import { describe, expect, it } from 'vitest';

import { isScrapEngine, isScrapResolvedFor, type StatusCode } from '@matricarmz/shared';

// Подсветка утиля в списке двигателей и утиль в отчётах должны считаться по одним меткам.
// До 2026-07-23 список видел только «Забракован» + картер в утиле, а отчёты — «Признан утильным»
// / «Утиль — отправлен заказчику»: двигатель, помеченный утильным, в списке выглядел обычным.

function listIsScrap(
  flags: Partial<Record<StatusCode, boolean>>,
  crankcaseScrapped = false,
  lastStageCode?: string | null,
  scrapResolvedAt?: number | null,
  defectAt?: number | null,
  lastStageAt?: number | null,
): boolean {
  const statusRejected = flags.status_rejected === true;
  const statusScrapMarked = isScrapEngine(flags);
  // Снятие утиля (10.10.2026): «Картер отремонтирован/заменён» гасит источники
  // того же или более раннего момента — акт не переписываем, след живёт в истории.
  const crankcase = crankcaseScrapped && !isScrapResolvedFor(scrapResolvedAt ?? null, defectAt ?? null);
  const branch = lastStageCode === 'scrap_branch' && !isScrapResolvedFor(scrapResolvedAt ?? null, lastStageAt ?? null);
  return statusRejected || statusScrapMarked || crankcase || branch;
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

  it('отметка боковой ветки подсвечивает и без галочки (шаг 8/2)', () => {
    expect(listIsScrap({}, false, 'scrap_branch')).toBe(true);
    expect(listIsScrap({}, false, 'sborka')).toBe(false);
  });

  it('совпадает с тем, что считает утилем shared (отчёты и гейт наряда)', () => {
    for (const code of ['status_scrap_confirmed', 'status_rework_sent'] as StatusCode[]) {
      const flags = { [code]: true } as Partial<Record<StatusCode, boolean>>;
      expect(listIsScrap(flags)).toBe(isScrapEngine(flags));
    }
  });

  it('снятие утиля гасит картер и ветку того же или более раннего момента', () => {
    // Картер: без снятия — утиль; снятие позже дефектовки — нет; снятие РАНЬШЕ — утиль снова.
    expect(listIsScrap({}, true, null, null, 1000)).toBe(true);
    expect(listIsScrap({}, true, null, 2000, 1000)).toBe(false);
    expect(listIsScrap({}, true, null, 500, 1000)).toBe(true);
    // Ветка: та же логика; источник без даты снятие тоже гасит (сознательная рука).
    expect(listIsScrap({}, false, 'scrap_branch', 1500, null, 1000)).toBe(false);
    expect(listIsScrap({}, false, 'scrap_branch', 500, null, 1000)).toBe(true);
    expect(listIsScrap({}, false, 'scrap_branch', 1500, null, null)).toBe(false);
    // Флаги снятием НЕ гасятся — их решает само действие дверью карточки.
    expect(listIsScrap({ status_rejected: true }, false, null, 2000, 1000)).toBe(true);
  });
});
