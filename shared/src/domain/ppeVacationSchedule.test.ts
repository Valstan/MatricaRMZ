/**
 * График отпусков: сетка и раскладка периодов — проверяются на датах, а не на
 * «как получилось»: половина месяца, отступ полосы и период по умолчанию.
 */
import { describe, expect, it } from 'vitest';

import {
  absenceSegments,
  daysInMonth,
  defaultVacationPeriod,
  findOverlappingAbsence,
  nextMondayStart,
  vacationHalves,
  type VacationAbsence,
} from './ppeVacationSchedule.js';

function ms(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d).getTime();
}

function absence(id: string, employeeId: string, fromMs: number, toMs: number): VacationAbsence {
  return { id, employeeId, fromMs, toMs, kind: 'vacation' };
}

describe('график отпусков: сетка', () => {
  it('в месяце две половины: 1–15 и 16–последний день', () => {
    const halves = vacationHalves(2026);
    expect(halves).toHaveLength(24);
    expect(halves[0]).toMatchObject({ month: 1, half: 1, days: 15, index: 0 });
    expect(halves[1]).toMatchObject({ month: 1, half: 2, days: 16, index: 1 });
    // 2026 — не високосный: в феврале 28 дней, во второй половине 13.
    expect(halves[3]).toMatchObject({ month: 2, half: 2, days: 13 });
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('период по умолчанию — две недели с понедельника', () => {
    // 2026-01-07 — среда. Ближайший понедельник ВПЕРЕДИ — 2026-01-12.
    const period = defaultVacationPeriod(ms(2026, 1, 7));
    expect(new Date(period.fromMs).getDate()).toBe(12);
    expect(new Date(period.fromMs).getDay()).toBe(1);
    // Понедельник + 13 дней = воскресенье второй недели.
    expect(new Date(period.toMs).getDay()).toBe(0);
    expect(Math.floor((period.toMs - period.fromMs) / 86_400_000)).toBe(13);
  });

  it('в понедельник период начинается сегодня', () => {
    const monday = ms(2026, 1, 12);
    expect(nextMondayStart(monday)).toBe(monday);
    expect(defaultVacationPeriod(monday).fromMs).toBe(monday);
  });
});

describe('график отпусков: раскладка периодов', () => {
  it('период внутри первой половины месяца рисуется от своего дня', () => {
    const rows = [absence('a1', 'e1', ms(2026, 1, 10), ms(2026, 1, 14))];
    const segs = absenceSegments(rows, 2026);
    expect(segs).toHaveLength(1);
    expect(segs[0].halfIndex).toBe(0);
    // 10-е из 15 дней первой половины: отступ (10-1)/15, ширина 5/15.
    expect(segs[0].leftPct).toBeCloseTo(((10 - 1) / 15) * 100, 6);
    expect(segs[0].widthPct).toBeCloseTo((5 / 15) * 100, 6);
  });

  it('период через границу месяца виден в обеих половинах', () => {
    const rows = [absence('a1', 'e1', ms(2026, 1, 20), ms(2026, 2, 3))];
    const segs = absenceSegments(rows, 2026);
    expect(segs.map((s) => s.halfIndex)).toEqual([1, 2]);
    // 20–31 января: 12 дней из 16 второй половины января.
    expect(segs[0].leftPct).toBeCloseTo(((20 - 16) / 16) * 100, 6);
    expect(segs[0].widthPct).toBeCloseTo((12 / 16) * 100, 6);
    // 1–3 февраля — это ПЕРВАЯ половина февраля: 3 дня из 15.
    expect(segs[1].halfIndex).toBe(2);
    expect(segs[1].leftPct).toBeCloseTo(0, 6);
    expect(segs[1].widthPct).toBeCloseTo((3 / 15) * 100, 6);
  });

  it('период из прошлого года в сетку не попадает', () => {
    const rows = [absence('a1', 'e1', ms(2025, 12, 20), ms(2026, 1, 5))];
    const segs = absenceSegments(rows, 2026);
    expect(segs).toHaveLength(1);
    expect(segs[0].halfIndex).toBe(0);
    // 1–5 января: 5 дней из 15.
    expect(segs[0].widthPct).toBeCloseTo((5 / 15) * 100, 6);
  });
});

describe('график отпусков: пересечения', () => {
  it('пересечение находится, а чужой сотрудник не мешает', () => {
    const rows = [absence('a1', 'e1', ms(2026, 1, 5), ms(2026, 1, 20))];
    expect(findOverlappingAbsence(rows, 'e1', ms(2026, 1, 15), ms(2026, 1, 25))?.id).toBe('a1');
    expect(findOverlappingAbsence(rows, 'e2', ms(2026, 1, 15), ms(2026, 1, 25))).toBeNull();
    expect(findOverlappingAbsence(rows, 'e1', ms(2026, 2, 1), ms(2026, 2, 10))).toBeNull();
  });
});
