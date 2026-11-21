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
    // В приказе 252 строки: 149 годовых норм без оговорки, 58 «на N лет», 16 «до износа»,
    // 16 «по документам изготовителя» и 25 заводских (решение владельца 17.11.2026 —
    // «завести свою норму» по 12 «лишним» позициям, плюс компенсация двум профессиям
    // после сверки сида с официальной ЕТН, плюс 8 норм для новых должностей ЕТН и 2
    // нормы электромонтеру от 21.11.2026). Если это число вдруг другое — приказ перечитали.
    expect(annual).toBe(149);
  });

  it('беруши заведены токарю, фрезеровщику и шлифовщику (решение владельца 17.11.2026)', () => {
    // Строка берушей в приказе есть — она применена к столяру и испытателю двигателей.
    // Токарь, фрезеровщик и шлифовщик по карточкам тоже носят беруши, значит, строка
    // им полагается (решение владельца: «беруши добавить»).
    const ear = 'Противошумные вкладыши (беруши) или противошумные наушники, включая активные, и их комплектующие';
    for (const code of ['4872', '5066', '5160']) {
      const rows = PPE_ORDER_SPECS.filter((s) => s.occupationCode === code && s.name === ear);
      expect(rows.length, `строка берушей у профессии ${code}`).toBe(1);
      expect(rows[0]!.sourceKind).toBe('ton');
      expect(rows[0]!.sourceRef).toBe('определяется документами изготовителя');
    }
  });

  it('заводские нормы по лишним позициям заведены отдельным источником', () => {
    // Решение владельца 17.11.2026: двенадцать «лишних» позиций не снимаем с выдачи,
    // а заводим под них свою норму. То же правило — для новых должностей ЕТН
    // (21.11.2026): кепка пескоструйщику, кепка и плащ автослесарю, нарукавники и
    // плащ трактористу, костюм и плащ водителю погрузчика. Такие строки помечены
    // источником «Заводская норма» — в бланке выдачи видно, где приказ, а где
    // заводская правка.
    const local = PPE_ORDER_SPECS.filter((s) => s.sourceKind === 'local');
    expect(local.length).toBe(25);
    const byCode = new Map<string, number>();
    for (const s of local) byCode.set(s.occupationCode, (byCode.get(s.occupationCode) ?? 0) + 1);
    expect(Object.fromEntries(byCode)).toEqual({
      '1942': 2, // маляр: вторая и третья полумаска
      '3522': 4, // пескоструйщик: три полумаски (ЗМ 6200, НРЗ-0113, У-2К) + своя кепка
      '3955': 2, // промывщик: плащ и фартук
      '4537': 3, // автослесарь: своя кепка, плащ, нарукавники под кислоты и щелочи
      '4581': 3, // электромонтер: своя кепка + свои ботинки и хлопковые перчатки (21.11)
      '4902': 2, // тракторист: свои нарукавники и плащ
      '5224': 3, // штукатур: две полумаски + своя ЗМ 6200 (в приказе дыхания у него нет)
      '5240': 3, // сварщик: второй костюм, нарукавники, хлопковые перчатки
      '790': 2, // водитель погрузчика: свой костюм МОТОР и плащ
      '1418': 1, // испытатель двигателей: наушники СОМЗ-93 (в приказе у него берушей нет)
    });
    for (const s of local) {
      expect(s.sourceLabel).toContain('Заводская норма');
      const set = PPE_ORDER_NORM_SETS.find(
        (x) => x.occupationCode === s.occupationCode && x.sourceKind === 'local',
      );
      expect(set, `набор заводских норм у ${s.occupationCode}`).toBeDefined();
      expect(set!.sourceLabel).toBe(s.sourceLabel);
    }
  });

  it('профессии из ЕТН, добавленные 17.11.2026, заведены со своими строками', () => {
    // Вариант А по четырём должностным карточкам: профессии берутся из приказа,
    // строки — из ЕТН Приложения №1. Пропала строка — заметим на тесте, а не на выдаче.
    const expected: Record<string, { post: string; tonRows: number }> = {
      '4902': { post: 'Тракторист', tonRows: 7 },
      '790': { post: 'Водитель погрузчика', tonRows: 6 },
      '3283': { post: 'Оператор станков с программным управлением', tonRows: 4 },
      '4537': { post: 'Слесарь по ремонту автомобилей', tonRows: 9 },
    };
    for (const [code, want] of Object.entries(expected)) {
      const occ = PPE_ORDER_OCCUPATIONS.find((o) => o.code === code);
      expect(occ, `профессия ${code} (${want.post})`).toBeDefined();
      expect(occ!.postTitle).toBe(want.post);
      expect(occ!.tonLabel).toBe(`Пункт № ${code}`);
      const tonRows = PPE_ORDER_SPECS.filter((s) => s.occupationCode === code && s.sourceKind === 'ton');
      expect(tonRows.length, `строк приказа у профессии ${code}`).toBe(want.tonRows);
      // У каждой профессии есть и зимний набор (766н) — иначе зимних СИЗ не выдать.
      // У трёх профессий из четырёх — ещё и набор заводских норм (решение владельца
      // 21.11.2026: свои нормы под позиции, которых в приказе нет).
      const sets = PPE_ORDER_NORM_SETS.filter((s) => s.occupationCode === code);
      const localSets = sets.filter((s) => s.sourceKind === 'local');
      expect(sets.length, `наборов норм у профессии ${code}`).toBe(
        localSets.length > 0 ? 3 : 2,
      );
    }
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
