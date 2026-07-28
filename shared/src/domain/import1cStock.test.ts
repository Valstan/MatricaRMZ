import { describe, expect, it } from 'vitest';

import {
  canonical1cNomenclature,
  clean1cName,
  match1cKey,
  match1cNomenclature,
  parse1cNumber,
  parse1cStockReport,
  revise1cAgainstBalances,
} from './import1cStock.js';

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

describe('revise1cAgainstBalances — ревизия против текущего остатка программы', () => {
  it('остаток приводится к числу из файла; совпадающие не проводятся', () => {
    const deltas = revise1cAgainstBalances({
      file: [
        { nomenclatureId: 'a', qty: 100 }, // остаток 90 → +10
        { nomenclatureId: 'b', qty: 5 }, // остаток 5 → без изменений
        { nomenclatureId: 'd', qty: 4 }, // остатка нет → +4
      ],
      prevSnapshot: [],
      balances: [
        { nomenclatureId: 'a', qty: 90 },
        { nomenclatureId: 'b', qty: 5 },
      ],
    });
    expect(deltas).toHaveLength(2);
    expect(deltas.find((x) => x.nomenclatureId === 'a')).toMatchObject({ delta: 10, prevQty: 90, nextQty: 100 });
    expect(deltas.find((x) => x.nomenclatureId === 'd')).toMatchObject({ delta: 4, prevQty: 0 });
  });

  it('расход нарядом НЕ списывается дважды: 1С догнала программу → дельта нулевая', () => {
    // Наряд списал 10 (остаток 90); свежий файл 1С тоже показывает 90 → изменений нет.
    const deltas = revise1cAgainstBalances({
      file: [{ nomenclatureId: 'a', qty: 90 }],
      prevSnapshot: [{ nomenclatureId: 'a', qty: 100 }],
      balances: [{ nomenclatureId: 'a', qty: 90 }],
    });
    expect(deltas).toHaveLength(0);
  });

  it('позиция пропала из отчёта → обнуляется по текущему остатку; чисто программные не трогаются', () => {
    const deltas = revise1cAgainstBalances({
      file: [],
      prevSnapshot: [{ nomenclatureId: 'gone', qty: 7 }],
      balances: [
        { nomenclatureId: 'gone', qty: 6 }, // 1 уже списан нарядом — обнуляем остаток 6, не 7
        { nomenclatureId: 'program-only', qty: 33 }, // детали от разборки — импорт не знает и не трогает
      ],
    });
    expect(deltas).toEqual([{ nomenclatureId: 'gone', delta: -6, prevQty: 6, nextQty: 0, zeroed: true }]);
  });

  it('дробные округляются; дубль в файле берётся один раз', () => {
    const deltas = revise1cAgainstBalances({
      file: [
        { nomenclatureId: 'kg', qty: 123.813 },
        { nomenclatureId: 'kg', qty: 999 },
      ],
      prevSnapshot: [],
      balances: [],
    });
    expect(deltas).toEqual([{ nomenclatureId: 'kg', delta: 124, prevQty: 0, nextQty: 124, zeroed: false }]);
  });
});

describe('canonical1cNomenclature — имя без артикула, артикул отдельным полем', () => {
  it('срезает артикул из начала и конца имени (compact-сравнение)', () => {
    expect(canonical1cNomenclature('303-11-2', '303-11-2 Кольцо')).toEqual({ article: '303-11-2', name: 'Кольцо' });
    expect(canonical1cNomenclature('3304-08-11', 'Кольцо поршневое маслосбрасывающее 3304-08-11')).toEqual({
      article: '3304-08-11',
      name: 'Кольцо поршневое маслосбрасывающее',
    });
  });

  it('артикул из нескольких токенов имени тоже срезается', () => {
    expect(canonical1cNomenclature('306-89', '306 - 89 уплотнение,')).toEqual({ article: '306-89', name: 'уплотнение' });
  });

  it('без артикула имя не трогаем; несовпадающий артикул имя не режет', () => {
    expect(canonical1cNomenclature('', '009-012-19-2-2 ГОСТ 9833-73(кольцо),')).toEqual({
      article: '',
      name: '009-012-19-2-2 ГОСТ 9833-73(кольцо)',
    });
    expect(canonical1cNomenclature('26х32', '26*32*1,5 Шайба (медь)')).toEqual({ article: '26х32', name: '26*32*1,5 Шайба (медь)' });
  });

  it('имя, целиком равное артикулу, не схлопывается в пустоту', () => {
    expect(canonical1cNomenclature('3335-38', '3335-38,')).toEqual({ article: '3335-38', name: '3335-38' });
  });
});

describe('match1cNomenclature — ярусы артикул → имя → имя+артикул', () => {
  const item = (article: string, name: string, qty = 1) => ({ article, name, unit: 'шт', qty });

  it('артикул 1С матчится на артикул программы (code/sku) при разных именах', () => {
    const r = match1cNomenclature([item('3304-08-11', 'Кольцо поршневое маслосбрасывающее 3304-08-11')], [
      { id: 'n1', name: 'Кольцо поршневое маслосбрасывающее', article: '3304-08-11' },
    ]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.nom.id).toBe('n1');
  });

  it('без артикула 1С: имя с дописанным артикулом матчится на имя+артикул программы', () => {
    const r = match1cNomenclature([item('', 'Кольцо поршневое маслосбрасывающее 504-08-6')], [
      { id: 'n1', name: 'Кольцо поршневое маслосбрасывающее', article: '504-08-6' },
      { id: 'n2', name: 'Кольцо поршневое маслосбрасывающее', article: '3304-08-11' },
    ]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.nom.id).toBe('n1');
  });

  it('артикул в начале имени 1С тоже матчится (перестановка артикул+имя)', () => {
    const r = match1cNomenclature([item('', '303-11-2 Кольцо')], [{ id: 'n1', name: 'Кольцо', article: '303-11-2' }]);
    expect(r.matched).toHaveLength(1);
  });

  it('несколько кандидатов = неоднозначно, ноль = не найдено', () => {
    const noms = [
      { id: 'n1', name: 'Ветошь', article: '' },
      { id: 'n2', name: 'Ветошь', article: '' },
    ];
    const r = match1cNomenclature([item('', 'Ветошь'), item('', 'Азелит')], noms);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.unmatched).toHaveLength(1);
  });

  it('точный артикул выигрывает раньше имени и не путается с однофамильцами', () => {
    const noms = [
      { id: 'n1', name: 'Кольцо', article: '303-11-2' },
      { id: 'n2', name: 'Кольцо', article: '303-12' },
    ];
    const r = match1cNomenclature([item('303-12', 'Кольцо')], noms);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.nom.id).toBe('n2');
  });
});
