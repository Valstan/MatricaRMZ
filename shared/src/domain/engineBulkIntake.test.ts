import { describe, expect, it } from 'vitest';

import {
  engineBulkIntakeKey,
  engineBulkIntakeSummary,
  ENGINE_BULK_INTAKE_MAX,
  parseEngineBulkIntake,
} from './engineBulkIntake.js';

describe('parseEngineBulkIntake', () => {
  it('режет по пробелам, запятым и переводам строк', () => {
    expect(parseEngineBulkIntake('111 222,333\n444\r\n555').numbers).toEqual([
      '111',
      '222',
      '333',
      '444',
      '555',
    ]);
  });

  it('таб и точка с запятой — тоже разделители', () => {
    expect(parseEngineBulkIntake('111\t222;333').numbers).toEqual(['111', '222', '333']);
  });

  it('косую черту разделителем не считает — она часть номера', () => {
    expect(parseEngineBulkIntake('41/26 41/27').numbers).toEqual(['41/26', '41/27']);
  });

  it('сливает внутренние повторы по канон-ключу и называет их', () => {
    const parsed = parseEngineBulkIntake('1234 1234\n1234,\nAB12 ab12');
    expect(parsed.numbers).toEqual(['1234', 'AB12']);
    expect(parsed.repeated).toEqual(['1234', 'ab12']);
  });

  it('не даёт пустых строк из лишних разделителей', () => {
    expect(parseEngineBulkIntake(' , 111 ,,\n\n  , ').numbers).toEqual(['111']);
  });

  it('пустой текст — пустой список', () => {
    expect(parseEngineBulkIntake('')).toEqual({ numbers: [], repeated: [] });
  });
});

describe('engineBulkIntakeKey', () => {
  it('не зависит от регистра и пробелов внутри номера', () => {
    expect(engineBulkIntakeKey(' ab 12 ')).toBe(engineBulkIntakeKey('AB12'));
  });
});

describe('engineBulkIntakeSummary', () => {
  it('считает создание, повторный заезд и пропуск', () => {
    const existing = {
      id: 'e1',
      engineNumber: '111',
      arrivalDate: null,
      engineBrand: null,
      customerId: null,
      contractId: null,
    };
    const summary = engineBulkIntakeSummary([
      { action: 'create', existing: null },
      { action: 'repeat_arrival', existing },
      { action: 'skip', existing },
      { action: 'create', existing },
    ]);
    expect(summary).toEqual({ create: 1, skip: 2, repeat: 1 });
  });
});

describe('ENGINE_BULK_INTAKE_MAX', () => {
  it('порог описан числом, а не магией в форме', () => {
    expect(ENGINE_BULK_INTAKE_MAX).toBeGreaterThanOrEqual(100);
  });
});
