import { describe, expect, it } from 'vitest';

import { resolveEngineTruthDates } from './engineReclamation.js';

const DAY_01 = Date.UTC(2026, 2, 1, 9, 0, 0);
const DAY_15 = Date.UTC(2026, 2, 15, 9, 0, 0);
const DAY_20 = Date.UTC(2026, 2, 20, 9, 0, 0);

describe('источник правды по датам: рекламация выше основного цикла', () => {
  it('без рекламации работают обычные даты', () => {
    const r = resolveEngineTruthDates({
      isReclamation: false,
      reclamationAcceptedDate: null,
      reclamationShippedDate: null,
      mainArrivalDate: DAY_01,
      mainShippingDate: DAY_15,
    });
    expect(r).toEqual({ arrivalDate: DAY_01, shippingDate: DAY_15 });
  });

  it('рекламация: приёмка по рекламации вместо старого прихода', () => {
    const r = resolveEngineTruthDates({
      isReclamation: true,
      reclamationAcceptedDate: DAY_20,
      reclamationShippedDate: null,
      mainArrivalDate: DAY_01,
      mainShippingDate: DAY_15,
    });
    expect(r.arrivalDate).toBe(DAY_20);
  });

  it('рекламация: старая отправка по основному циклу НЕ подставляется', () => {
    // Двигатель пришёл по рекламации и сейчас на заводе — «отгружен» он будет только
    // после ремонта по рекламации. Старая отправка заказчику по основному циклу
    // перебивала рекламацию — этого быть не должно.
    const r = resolveEngineTruthDates({
      isReclamation: true,
      reclamationAcceptedDate: DAY_20,
      reclamationShippedDate: null,
      mainArrivalDate: DAY_01,
      mainShippingDate: DAY_15,
    });
    expect(r.shippingDate).toBeNull();
  });

  it('рекламация: отправка с рекламации — своя дата', () => {
    const r = resolveEngineTruthDates({
      isReclamation: true,
      reclamationAcceptedDate: DAY_20,
      reclamationShippedDate: DAY_20 + 5 * 86_400_000,
      mainArrivalDate: DAY_01,
      mainShippingDate: DAY_15,
    });
    expect(r.shippingDate).toBe(DAY_20 + 5 * 86_400_000);
  });

  it('рекламация без даты приёмки — движок ещё в основном цикле, правда о его датах', () => {
    // Рекламация может быть только заявлена: заезда по ней ещё не было. Тогда «пришёл» и
    // «ушёл» — по основному циклу, а не пустота (прежняя ветка подставляла пустую отгрузку
    // и делала движок «на заводе» навсегда).
    const r = resolveEngineTruthDates({
      isReclamation: true,
      reclamationAcceptedDate: null,
      reclamationShippedDate: null,
      mainArrivalDate: DAY_01,
      mainShippingDate: DAY_15,
    });
    expect(r.arrivalDate).toBe(DAY_01);
    expect(r.shippingDate).toBe(DAY_15);
  });

  it('пустые значения не превращаются в нулевые даты', () => {
    const r = resolveEngineTruthDates({
      isReclamation: false,
      reclamationAcceptedDate: null,
      reclamationShippedDate: null,
      mainArrivalDate: null,
      mainShippingDate: 0,
    });
    expect(r.arrivalDate).toBeNull();
    expect(r.shippingDate).toBeNull();
  });
});
