import { describe, expect, it } from 'vitest';

import {
  inferListExportKind,
  parseExportDate,
  parseExportNumber,
  sanitizeExportFileName,
} from './listExport.js';

describe('разбор значений для выгрузки', () => {
  it('числа читаются в русской записи: разряды пробелом, дробь запятой', () => {
    expect(parseExportNumber('1 234,56')).toBe(1234.56);
    expect(parseExportNumber('12,5')).toBe(12.5);
    expect(parseExportNumber('-40')).toBe(-40);
    expect(parseExportNumber('1\u00A0234,56')).toBe(1234.56);
  });

  it('не число — остаётся текстом, а не нулём', () => {
    expect(parseExportNumber('007')).toBe(7);
    expect(parseExportNumber('8 926 123-45-67')).toBeNull();
    expect(parseExportNumber('вал')).toBeNull();
    expect(parseExportNumber('')).toBeNull();
  });

  it('дата разбирается в UTC, время — по желанию', () => {
    const day = parseExportDate('19.10.2026');
    expect(day?.date.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(day?.hasTime).toBe(false);

    const withTime = parseExportDate('19.10.2026 14:30');
    expect(withTime?.date.toISOString()).toBe('2026-10-19T14:30:00.000Z');
    expect(withTime?.hasTime).toBe(true);
  });

  it('дата с запятой и секундами (форма самой программы) — тоже дата', () => {
    const local = parseExportDate('19.10.2026, 01:26:16');
    expect(local?.date.toISOString()).toBe('2026-10-19T01:26:16.000Z');
    expect(local?.hasTime).toBe(true);
  });

  it('несуществующая дата не превращается в соседний день', () => {
    expect(parseExportDate('31.02.2026')).toBeNull();
    expect(parseExportDate('19/10/2026')).toBeNull();
  });
});

describe('тип колонки', () => {
  it('колонка из дат становится датой', () => {
    expect(inferListExportKind('Дата этапа', ['19.10.2026', '01.09.2026', '—'])).toBe('date');
  });

  it('разряженные и дробные числа числовые без подсказки подписи', () => {
    expect(inferListExportKind('Стоимость', ['1 234,56', '980,00'])).toBe('number');
    expect(inferListExportKind('Прочее', ['12,5', '13'])).toBe('number');
  });

  it('целые числа без считающей подписи остаются текстом', () => {
    expect(inferListExportKind('Артикул', ['007', '1234'])).toBe('text');
    expect(inferListExportKind('Телефон', ['89261234567'])).toBe('text');
  });

  it('подпись «Количество» открывает счёт целым числам', () => {
    expect(inferListExportKind('Количество', ['12', '3'])).toBe('number');
  });

  it('смешанная колонка не притворяется числовой', () => {
    expect(inferListExportKind('Сумма', ['1 234,56', 'по договору', '—'])).toBe('text');
  });

  it('пустая колонка — текст: считать в ней нечего', () => {
    expect(inferListExportKind('Сумма', ['', '—', '-'])).toBe('text');
  });
});

describe('имя файла', () => {
  it('запрещённые Windows знаки заменяются, хвостовые точки уходят', () => {
    expect(sanitizeExportFileName('Список / двигателей: "ТЕСТ"?')).toBe('Список двигателей ТЕСТ');
    expect(sanitizeExportFileName('Наряды...')).toBe('Наряды');
  });

  it('пустое имя не оставляет файл без имени', () => {
    expect(sanitizeExportFileName('   ')).toBe('Список');
  });
});
