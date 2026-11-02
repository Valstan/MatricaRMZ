/**
 * Приказ о СИЗ (Минтруд 767н, Приложение №1): разбор норм и работа позиций
 * без срока носки.
 *
 * Формы строк взяты из самого документа — включая его мусор («1пара на 2года»,
 * «12 парсрок определяется…»): разбор должен брать их одинаково.
 */
import { describe, expect, it } from 'vitest';

import {
  formatOrderNormQty,
  nextIssueDates,
  parseOrderNormQty,
  PPE_ORDER_UNITS,
  resolveEmployeeNorms,
} from './ppe.js';

const NOM_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const T0 = Date.UTC(2026, 9, 11);

describe('ppe: разбор нормы приказа', () => {
  it('количество в год: «1 шт.» — единица и годовой срок 12 мес.', () => {
    expect(parseOrderNormQty('1 шт.')).toEqual({
      qty: 1,
      unit: 'шт.',
      wearKind: 'months',
      wearMonths: 12,
      periodText: null,
    });
  });

  it('«12 пар» в год — пара в месяц (1 мес. носки)', () => {
    expect(parseOrderNormQty('12 пар')).toMatchObject({ qty: 12, unit: 'пар', wearMonths: 1 });
  });

  it('«6 пар» в год — раз в 2 месяца', () => {
    expect(parseOrderNormQty('6 пар')).toMatchObject({ qty: 6, unit: 'пар', wearMonths: 2 });
  });

  it('«4 шт.» в год — раз в 3 месяца', () => {
    expect(parseOrderNormQty('4 шт.')).toMatchObject({ qty: 4, unit: 'шт.', wearMonths: 3 });
  });

  it('«2 шт.» в год — раз в 6 месяцев', () => {
    expect(parseOrderNormQty('2 шт.')).toMatchObject({ qty: 2, unit: 'шт.', wearMonths: 6 });
  });

  it('«1 пара» — пара в год', () => {
    expect(parseOrderNormQty('1 пара')).toMatchObject({ qty: 1, unit: 'пара', wearMonths: 12 });
  });

  it('«1 шт. на 2 года» — 24 месяца', () => {
    expect(parseOrderNormQty('1 шт. на 2 года')).toMatchObject({
      qty: 1,
      unit: 'шт.',
      wearKind: 'months',
      wearMonths: 24,
      periodText: 'на 2 года',
    });
  });

  it('мусор документа «1шт. на 2года» читается так же', () => {
    expect(parseOrderNormQty('1шт. на 2года')).toMatchObject({ qty: 1, unit: 'шт.', wearMonths: 24 });
  });

  it('мусор документа «1пара на 2года» читается так же', () => {
    expect(parseOrderNormQty('1пара на 2года')).toMatchObject({ qty: 1, unit: 'пара', wearMonths: 24 });
  });

  it('ещё одна форма без пробела: «1шт на 2года»', () => {
    expect(parseOrderNormQty('1шт на 2года')).toMatchObject({ qty: 1, unit: 'шт.', wearMonths: 24 });
  });

  it('«1 шт. на год» — 12 месяцев', () => {
    expect(parseOrderNormQty('1 шт. на год')).toMatchObject({ qty: 1, unit: 'шт.', wearMonths: 12 });
  });

  it('«до износа» — срока нет', () => {
    expect(parseOrderNormQty('до износа')).toEqual({
      qty: 1,
      unit: 'шт.',
      wearKind: 'until_wearout',
      wearMonths: null,
      periodText: 'до износа',
    });
  });

  it('«срок определяется документами изготовителя» — срока нет, вид известен', () => {
    expect(parseOrderNormQty('определяется документами изготовителя')).toMatchObject({
      wearKind: 'by_manufacturer',
      wearMonths: null,
    });
  });

  it('«1 пара срок определяется документами изготовителя» — количество сохранено', () => {
    expect(parseOrderNormQty('1 пара срок определяется документами изготовителя')).toMatchObject({
      qty: 1,
      unit: 'пара',
      wearKind: 'by_manufacturer',
      wearMonths: null,
    });
  });

  it('«12 пар срок определяется документами изготовителя» — количество сохранено', () => {
    expect(parseOrderNormQty('12 пар срок определяется документами изготовителя')).toMatchObject({
      qty: 12,
      unit: 'пар',
      wearKind: 'by_manufacturer',
    });
  });

  it('мусор «1парасрок определяется…» читается так же', () => {
    expect(parseOrderNormQty('1парасрок определяется документами изготовителя')).toMatchObject({
      qty: 1,
      unit: 'пара',
      wearKind: 'by_manufacturer',
    });
  });

  it('мусор «12 парсрок определяется…» читается так же', () => {
    expect(parseOrderNormQty('12 парсрок определяется документами изготовителя')).toMatchObject({
      qty: 12,
      unit: 'пар',
      wearKind: 'by_manufacturer',
    });
  });

  it('мусор «1 шт.срок определяется…» читается так же', () => {
    expect(parseOrderNormQty('1 шт.срок определяется документами изготовителя')).toMatchObject({
      qty: 1,
      unit: 'шт.',
      wearKind: 'by_manufacturer',
    });
  });

  it('мусор «1шт срок определяется…» читается так же', () => {
    expect(parseOrderNormQty('1шт срок определяется документами изготовителя')).toMatchObject({
      qty: 1,
      unit: 'шт.',
      wearKind: 'by_manufacturer',
    });
  });

  it('пустая строка — годовая норма по умолчанию, а не ноль', () => {
    expect(parseOrderNormQty('')).toMatchObject({ qty: 1, unit: 'шт.', wearMonths: 12 });
  });
});

describe('ppe: обратный ход — печать нормы как в приказе', () => {
  const roundTrip = (raw: string): string => formatOrderNormQty(parseOrderNormQty(raw));

  it('годовая норма печатается количеством', () => {
    expect(roundTrip('1 шт.')).toBe('1 шт.');
    expect(roundTrip('12 пар')).toBe('12 пар');
  });

  it('оговорка о сроке печатается приказной фразой', () => {
    expect(roundTrip('1 шт. на 2 года')).toBe('1 шт. на 2 года');
  });

  it('«до износа» печатается двумя словами, без количества', () => {
    expect(roundTrip('до износа')).toBe('до износа');
  });

  it('«по документам изготовителя» печатается с количеством', () => {
    expect(roundTrip('1 пара срок определяется документами изготовителя')).toBe(
      '1 пара срок определяется документами изготовителя',
    );
  });
});

describe('ppe: позиция без срока носки', () => {
  it('при слиянии строка со сроком побеждает строку без срока', () => {
    const merged = resolveEmployeeNorms([
      { normSetId: 'ns-1', nomenclatureId: NOM_A, qty: 1, wearMonths: null },
      { normSetId: 'ns-2', nomenclatureId: NOM_A, qty: 1, wearMonths: 12 },
    ]);
    expect(merged).toEqual([{ nomenclatureId: NOM_A, qty: 2, wearMonths: 12 }]);
  });

  it('если срока нет ни у одной строки — срок не задаётся', () => {
    const merged = resolveEmployeeNorms([
      { normSetId: 'ns-1', nomenclatureId: NOM_A, qty: 1, wearMonths: null },
    ]);
    expect(merged).toEqual([{ nomenclatureId: NOM_A, qty: 1, wearMonths: null }]);
  });

  it('выданная позиция без срока не бывает «пора» и не «просрочена»', () => {
    const [item] = nextIssueDates(
      [{ nomenclatureId: NOM_A, qty: 1, wearMonths: null }],
      [{ nomenclatureId: NOM_A, qty: 1, issuedAt: T0 }],
      T0,
    );
    expect(item).toMatchObject({ nextDueAt: null, status: 'ok' });
  });

  it('невыданная позиция без срока остаётся neverIssued', () => {
    const [item] = nextIssueDates([{ nomenclatureId: NOM_A, qty: 1, wearMonths: null }], [], T0);
    expect(item).toMatchObject({ nextDueAt: null, status: 'neverIssued' });
  });

  it('старое поведение со сроком не меняется', () => {
    const [item] = nextIssueDates(
      [{ nomenclatureId: NOM_A, qty: 1, wearMonths: 12 }],
      [{ nomenclatureId: NOM_A, qty: 1, issuedAt: T0 }],
      T0,
    );
    expect(item).toMatchObject({ nextDueAt: Date.UTC(2027, 9, 11), status: 'ok' });
  });
});

describe('ppe: единицы приказа', () => {
  it('комплект, пара, пар, шт — в наборе формы', () => {
    expect(PPE_ORDER_UNITS).toEqual(['комплект', 'пара', 'пар', 'шт']);
  });
});
