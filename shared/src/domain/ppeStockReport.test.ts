import { describe, expect, it } from 'vitest';

import {
  parsePpeStockReport,
  parsePpeStockReportNumber,
  parseRussianDate,
  splitWorkwearSize,
} from './ppeStockReport.js';

/**
 * Фикстура повторяет шапку отчёта владельца («Остатки товаров 1 ноября 2026 г.»):
 * организация, заголовок, отбор по счёту, пустая строка, шапка колонок, позиции, «Итого».
 */
const REPORT_ROWS: (string | number | null)[][] = [
  ['Акционерное общество "МАЛМЫЖСКИЙ ЗАВОД ПО РЕМОНТУ ДИЗЕЛЬНЫХ ДВИГАТЕЛЕЙ"'],
  ['Остатки товаров на 1 ноября 2026 г.'],
  ['Отбор: Счет Равно "10.10"'],
  [],
  ['Номенклатура', 'Единица', 'Количество', 'Сумма'],
  ['Бейсболка ЛИДЕР-100, цв.темно-синий, 280 г/м2, 100% хлопок', 'шт', 9, 3150],
  ['Ботинки DELTA, ПУ,МП (43)', 'пар', 1, 1391.67],
  ['Сапоги Лидер ПУ/НИТРИЛ, КП р. 42', 'пар', 1, 2333.33],
  ['Костюм МОТОР цв. чер-зел. тк. смесовая (96-100/170-176)', 'шт', 6, 17028.18],
  ['Итого', null, null, 482531.79],
];

describe('parsePpeStockReport', () => {
  it('читает позиции отчёта и пропускает строку «Итого»', () => {
    const report = parsePpeStockReport(REPORT_ROWS);

    expect(report.rows).toHaveLength(4);
    expect(report.rows[0]).toEqual({
      name: 'Бейсболка ЛИДЕР-100, цв.темно-синий, 280 г/м2, 100% хлопок',
      unit: 'шт',
      qty: 9,
      sum: 3150,
    });
    expect(report.rows[1]?.name).toBe('Ботинки DELTA, ПУ,МП (43)');
    expect(report.rows[1]?.qty).toBe(1);
    expect(report.rows.map((r) => r.name)).not.toContain('Итого');
  });

  it('берёт дату отчёта из заголовка', () => {
    const report = parsePpeStockReport(REPORT_ROWS);
    const date = report.reportDate ? new Date(report.reportDate) : null;

    expect(date).not.toBeNull();
    expect(date?.getUTCFullYear()).toBe(2026);
    expect(date?.getUTCMonth()).toBe(10);
    expect(date?.getUTCDate()).toBe(1);
  });

  it('шапку отчёта отдаёт оператору для показа', () => {
    const report = parsePpeStockReport(REPORT_ROWS);

    expect(report.title.some((line) => line.includes('Остатки товаров на'))).toBe(true);
    expect(report.title.some((line) => line.includes('Счет Равно'))).toBe(true);
  });

  it('отчёт без шапки таблицы — пустой результат, а не «нулевой отчёт»', () => {
    const report = parsePpeStockReport([['Организация'], ['Что-то']]);

    expect(report.rows).toEqual([]);
    expect(report.reportDate).toBeNull();
  });

  it('пустой файл не ломает разбор', () => {
    const report = parsePpeStockReport([]);

    expect(report.rows).toEqual([]);
    expect(report.title).toEqual([]);
  });

  it('количество с запятой читается числом, мусор — пропускается', () => {
    const report = parsePpeStockReport([
      ['Номенклатура', 'Единица', 'Количество', 'Сумма'],
      ['Перчатки ЛИКОМ 22/М (11)', 'пар', '11', '2323,20'],
      ['Без количества', 'шт', '—', null],
    ]);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.qty).toBe(11);
    expect(report.rows[0]?.sum).toBe(2323.2);
    expect(report.skipped).toBe(1);
  });
});

describe('parsePpeStockReportNumber', () => {
  it('читает числа с пробелами и запятой', () => {
    expect(parsePpeStockReportNumber('1 234,5')).toBe(1234.5);
    expect(parsePpeStockReportNumber(9)).toBe(9);
    expect(parsePpeStockReportNumber('')).toBeNull();
    expect(parsePpeStockReportNumber('—')).toBeNull();
  });
});

describe('parseRussianDate', () => {
  it('понимает русские месяцы в родительном падеже', () => {
    const ts = parseRussianDate('1 ноября 2026 г.');
    expect(ts).not.toBeNull();
    expect(new Date(ts!).getUTCMonth()).toBe(10);
  });

  it('понимает точечный и iso-формат', () => {
    expect(parseRussianDate('01.11.2026')).toBe(parseRussianDate('2026-11-01'));
  });

  it('на мусоре возвращает null', () => {
    expect(parseRussianDate('когда-нибудь')).toBeNull();
  });
});

describe('splitWorkwearSize', () => {
  it('вынимает размер из скобок', () => {
    expect(splitWorkwearSize('Костюм МОТОР цв. чер-зел. тк. смесовая (96-100/170-176)')).toEqual({
      base: 'Костюм МОТОР цв. чер-зел. тк. смесовая',
      size: '96-100/170-176',
    });
  });

  it('вынимает «р. 42» и «, 36»', () => {
    expect(splitWorkwearSize('Сапоги Лидер ПУ/НИТРИЛ, КП р. 42')).toEqual({
      base: 'Сапоги Лидер ПУ/НИТРИЛ, КП',
      size: '42',
    });
    expect(splitWorkwearSize('Ботинки ТОФФ ТРУД мп кож/текст цв.чер. металлический 200Дж ПУ, 36')).toEqual({
      base: 'Ботинки ТОФФ ТРУД мп кож/текст цв.чер. металлический 200Дж ПУ',
      size: '36',
    });
  });

  it('вынимает «разм.37» из скобок', () => {
    expect(splitWorkwearSize('Ботинки ЛИДЕР-ЗИМА МП, ПУ/Нитрил, шерсть (разм.37)')).toEqual({
      base: 'Ботинки ЛИДЕР-ЗИМА МП, ПУ/Нитрил, шерсть',
      size: '37',
    });
  });

  it('буквенный размер в конце названия', () => {
    expect(splitWorkwearSize('Плащ ФОРЕСТ цв. син, XXL')).toEqual({ base: 'Плащ ФОРЕСТ цв. син', size: 'XXL' });
  });

  it('без размера остаётся целиком', () => {
    expect(splitWorkwearSize('Каска РОСОМЗ СОМЗ-55 FAVORIT 75514')).toEqual({
      base: 'Каска РОСОМЗ СОМЗ-55 FAVORIT 75514',
      size: null,
    });
  });
});
