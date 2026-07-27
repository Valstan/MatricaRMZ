import { describe, expect, it } from 'vitest';

import { clean1cName, diff1cSnapshot, match1cKey, parse1cNumber, parse1cStockReport } from './import1cStock.js';

// Фрагмент реального отчёта «Остатки и доступность товаров» (D:\...\отчет склад 27.txt).
const SAMPLE = [
  '\ufeff',
  'Остатки и доступность товаров',
  '',
  'Параметры:\tПоказать обособленные товары: Нет',
  'Отбор:\tНоменклатура.Артикул Содержит ""',
  '',
  'Склад\t\t\tСейчас\t\t\t\tВсего\t\t\t',
  'Артикул\tНоменклатура, Характеристика\tЕд. изм.\tВ наличии\tОтгружается\tВ резерве\tДоступно\tДоступно\tК обеспечению\tДефицит\tИзлишек',
  'Основной склад\t\t\t\t\t\t\t\t\t\t',
  '\t009-012-19-2-2 ГОСТ 9833-73(кольцо),\tшт\t17,000\t\t\t17,000\t17,000\t\t\t17,000',
  '26х32\t26*32*1,5 Шайба (медь),\tшт\t411,000\t\t\t411,000\t411,000\t\t\t411,000',
  '\t3335-38,\tкг\t123,813\t\t\t123,813\t123,813\t\t\t123,813',
  'Склад цех №3\t\t\t\t\t\t\t\t\t\t',
  '\tШайба 10*16,\tшт\t30 165,000\t\t\t30 165,000\t30 165,000\t\t\t30 165,000',
  'Итого\t\t\t\t\t\t\t\t\t\t',
].join('\r\n');

describe('parse1cStockReport — TSV отчёта 1С', () => {
  it('разбирает группы-склады и строки с количеством «В наличии»', () => {
    const r = parse1cStockReport(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.warehouses.map((w) => w.warehouseName)).toEqual(['Основной склад', 'Склад цех №3']);
    const main = r.report.warehouses[0]!;
    expect(main.items).toHaveLength(3);
    expect(main.items[0]).toEqual({ article: '', name: '009-012-19-2-2 ГОСТ 9833-73(кольцо)', unit: 'шт', qty: 17 });
    expect(main.items[1]!.article).toBe('26х32');
    expect(main.items[2]!.qty).toBeCloseTo(123.813);
    expect(r.report.warehouses[1]!.items[0]!.qty).toBe(30165);
  });

  it('отвергает не-отчёт и пустой файл', () => {
    expect(parse1cStockReport('').ok).toBe(false);
    expect(parse1cStockReport('просто текст\nбез маркера').ok).toBe(false);
  });

  it('терминатор «Итого» останавливает разбор', () => {
    const withTail = SAMPLE + '\r\nОсновной склад\t\t\t\t\t\t\t\t\t\t\r\n\tПризрак,\tшт\t1,000\t\t\t1,000\t1,000\t\t\t1,000';
    const r = parse1cStockReport(withTail);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.warehouses.reduce((s, w) => s + w.items.length, 0)).toBe(4);
  });
});

describe('parse1cNumber / clean1cName / match1cKey', () => {
  it('числа 1С: запятая-десятичная, пробел/NBSP-разряды', () => {
    expect(parse1cNumber('17,000')).toBe(17);
    expect(parse1cNumber('30 165,000')).toBe(30165);
    expect(parse1cNumber('123,813')).toBeCloseTo(123.813);
    expect(parse1cNumber('')).toBeNull();
    expect(parse1cNumber('abc')).toBeNull();
  });

  it('хвостовая запятая (пустая характеристика) убирается; матч нечувствителен к дефисам/пробелам', () => {
    expect(clean1cName('306-89 уплотнение,')).toBe('306-89 уплотнение');
    const a = match1cKey('', 'В-84 кольцо');
    const b = match1cKey('', 'в84  КОЛЬЦО');
    expect(a.nameKey).toBe(b.nameKey);
  });
});

describe('diff1cSnapshot — ревизия внутри слоя 1С', () => {
  it('новая позиция = +qty, изменение = разница, пропавшая = обнуление', () => {
    const prev = [
      { nomenclatureId: 'a', qty: 10 },
      { nomenclatureId: 'b', qty: 5 },
      { nomenclatureId: 'c', qty: 7 },
    ];
    const next = [
      { nomenclatureId: 'a', qty: 10 }, // без изменений — не проводится
      { nomenclatureId: 'b', qty: 8 }, // +3
      { nomenclatureId: 'd', qty: 4 }, // новая — +4
      // c пропала → −7, zeroed
    ];
    const deltas = diff1cSnapshot(prev, next);
    expect(deltas).toHaveLength(3);
    expect(deltas.find((x) => x.nomenclatureId === 'b')).toMatchObject({ delta: 3, prevQty: 5, nextQty: 8, zeroed: false });
    expect(deltas.find((x) => x.nomenclatureId === 'd')).toMatchObject({ delta: 4, prevQty: 0 });
    expect(deltas.find((x) => x.nomenclatureId === 'c')).toMatchObject({ delta: -7, nextQty: 0, zeroed: true });
  });

  it('дробные количества округляются до целых (складской учёт целочисленный)', () => {
    const deltas = diff1cSnapshot([], [{ nomenclatureId: 'kg', qty: 123.813 }]);
    expect(deltas[0]!.delta).toBe(124);
  });

  it('первый импорт (prev пуст) — все позиции плюсом; дубль в снапшоте берётся один раз', () => {
    const deltas = diff1cSnapshot(
      [],
      [
        { nomenclatureId: 'a', qty: 2 },
        { nomenclatureId: 'a', qty: 99 },
      ],
    );
    expect(deltas).toEqual([{ nomenclatureId: 'a', delta: 2, prevQty: 0, nextQty: 2, zeroed: false }]);
  });
});
