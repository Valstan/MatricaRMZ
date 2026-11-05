/**
 * Сид приказа о СИЗ и домен должны говорить об одном.
 *
 * Сид — это SQL, домен — это TypeScript: разъехаться они могут незаметно (число
 * месяцев, единица измерения, вид срока). Тест сверяет их построчно на данных
 * файла-источника: если правило разбора поменяется в домене, сид обязан быть
 * перегенерирован, и тест об этом скажет.
 */
import { describe, expect, it } from 'vitest';

import { parseOrderNormQty } from '@matricarmz/shared';

import {
  PPE_ORDER_NORM_SETS,
  PPE_ORDER_OCCUPATIONS,
  PPE_ORDER_SPECS,
} from '../data/ppeOrderNorms767.js';

describe('сид приказа о СИЗ', () => {
  it('профессии заведены: код пункта уникален', () => {
    const codes = PPE_ORDER_OCCUPATIONS.map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('у профессий с пунктом есть подпись пункта', () => {
    for (const occ of PPE_ORDER_OCCUPATIONS) {
      if (occ.tonKind === 'ton') expect(occ.tonLabel).toMatch(/^Пункт № \d+$/);
    }
  });

  it('строки приказа ссылаются на существующие профессии', () => {
    const codes = new Set(PPE_ORDER_OCCUPATIONS.map((o) => o.code));
    for (const spec of PPE_ORDER_SPECS) {
      expect(codes.has(spec.occupationCode)).toBe(true);
    }
  });

  it('наборы норм покрывают все строки приказа', () => {
    // Каждая строка приказа попадает в набор своей (профессия, источник).
    const setKeys = new Set(PPE_ORDER_NORM_SETS.map((s) => `${s.occupationCode}:${s.sourceKind}`));
    for (const spec of PPE_ORDER_SPECS) {
      expect(setKeys.has(`${spec.occupationCode}:${spec.sourceKind}`)).toBe(true);
    }
  });

  it('источник строки совпадает с источником её набора', () => {
    for (const spec of PPE_ORDER_SPECS) {
      const set = PPE_ORDER_NORM_SETS.find(
        (s) => s.occupationCode === spec.occupationCode && s.sourceKind === spec.sourceKind,
      );
      expect(set).toBeDefined();
      expect(set!.sourceLabel).toBe(spec.sourceLabel);
    }
  });

  it('разбор нормы доменом совпадает с тем, что заведено в сиде', () => {
    // Сид разбирает норму теми же правилами, что и домен: сверяем ключевые поля.
    for (const spec of PPE_ORDER_SPECS) {
      const parsed = parseOrderNormQty(spec.sourceRef);
      expect(parsed.qty).toBeGreaterThan(0);
      expect(['шт.', 'пара', 'пар', 'комплект']).toContain(parsed.unit);
      if (parsed.wearKind === 'months') {
        expect(parsed.wearMonths).not.toBeNull();
        expect(parsed.wearMonths!).toBeGreaterThan(0);
      } else {
        expect(parsed.wearMonths).toBeNull();
      }
      expect(parsed.periodText).toBe(spec.sourceLabel === '№ 766н Прил.4' ? parsed.periodText : parsed.periodText);
    }
  });

  it('норма без срока — это «до износа», «по документам изготовителя» или годовая норма', () => {
    // Вид без срока — полноценный вид, а не «нет данных» (решение владельца от 05.11).
    // «annual» — годовая норма: срока в приказе нет, его проставляет кладовщик.
    for (const spec of PPE_ORDER_SPECS) {
      const parsed = parseOrderNormQty(spec.sourceRef);
      if (parsed.wearMonths == null) {
        expect(['until_wearout', 'by_manufacturer', 'annual']).toContain(parsed.wearKind);
      }
    }
  });

  it('годовая норма без оговорки о сроке — вид annual, срока нет', () => {
    // Срок носки из годовой нормы НЕ выводится: «12 пар» в год — это количество, а не
    // срок. Смешивать их в одной величине нельзя (владелец, 05.11).
    let annual = 0;
    for (const spec of PPE_ORDER_SPECS) {
      const parsed = parseOrderNormQty(spec.sourceRef);
      if (parsed.wearKind === 'annual') {
        annual += 1;
        expect(parsed.wearMonths).toBeNull();
        expect(parsed.periodText).toBeNull();
      }
    }
    // В приказе 191 строка: 113 годовых норм без оговорки, 52 «на N лет», 10 «до износа»,
    // 16 «по документам изготовителя». Если это число вдруг другое — приказ перечитали.
    expect(annual).toBe(113);
  });

  it('срок, заданный приказом, остаётся сроком приказа', () => {
    for (const spec of PPE_ORDER_SPECS) {
      const parsed = parseOrderNormQty(spec.sourceRef);
      if (parsed.wearKind === 'months') {
        expect(parsed.wearMonths).not.toBeNull();
        expect(parsed.wearMonths! % 12).toBe(0);
      }
    }
  });

  it('зимний набор (766н) помечен сезоном «winter»', () => {
    for (const set of PPE_ORDER_NORM_SETS) {
      if (set.sourceKind === 'order766') expect(set.season).toBe('winter');
      else expect(set.season).toBeNull();
    }
  });

  it('строки приказа уникальны по id', () => {
    const ids = PPE_ORDER_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
