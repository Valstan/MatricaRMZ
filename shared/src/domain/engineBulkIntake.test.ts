import { describe, expect, it } from 'vitest';

import {
  engineBulkIntakeConflictingFields,
  engineBulkIntakeKey,
  engineBulkIntakeMissingFields,
  engineBulkIntakeSummary,
  ENGINE_BULK_INTAKE_MAX,
  parseEngineBulkIntake,
  readBulkIntakeInternalNumber,
  engineBulkIntakeInternalNumberDuplicates,
  splitEngineBulkIntakeNumbers,
  type EngineBulkIntakeExisting,
  type EngineBulkIntakeOffer,
} from './engineBulkIntake.js';

const card = (over: Partial<EngineBulkIntakeExisting> = {}): EngineBulkIntakeExisting => ({
  id: 'e1',
  engineNumber: '111',
  arrivalDate: null,
  engineBrandId: null,
  engineBrand: null,
  customerId: null,
  contractId: null,
  internalNumber: null,
  internalNumberYear: null,
  hasDefectStage: false,
  ...over,
});

const offer = (over: Partial<EngineBulkIntakeOffer> = {}): EngineBulkIntakeOffer => ({
  brandId: null,
  customerId: null,
  contractId: null,
  arrivalDate: null,
  internalNumber: null,
  internalNumberYear: null,
  defectDate: null,
  ...over,
});

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

describe('splitEngineBulkIntakeNumbers', () => {
  it('отдаёт токены как есть, без схлопывания повторов — по ним вставляется колонка', () => {
    expect(splitEngineBulkIntakeNumbers('41/26\n41/26, 42\n43')).toEqual(['41/26', '41/26', '42', '43']);
  });
});

describe('engineBulkIntakeKey', () => {
  it('не зависит от регистра и пробелов внутри номера', () => {
    expect(engineBulkIntakeKey(' ab 12 ')).toBe(engineBulkIntakeKey('AB12'));
  });
});

describe('engineBulkIntakeSummary', () => {
  it('считает создание, дополнение, повторный заезд и пропуск', () => {
    const existing = card();
    const summary = engineBulkIntakeSummary([
      { action: 'create', existing: null },
      { action: 'repeat_arrival', existing },
      { action: 'update', existing },
      { action: 'skip', existing },
      { action: 'create', existing },
    ]);
    expect(summary).toEqual({ create: 1, skip: 2, repeat: 1, update: 1 });
  });
});

describe('engineBulkIntakeMissingFields', () => {
  it('пустая карточка — дописывать надо всё, что предложено', () => {
    expect(
      engineBulkIntakeMissingFields(
        card(),
        offer({
          brandId: 'b1',
          customerId: 'c1',
          contractId: 'k1',
          arrivalDate: 1000,
          internalNumber: '41',
          internalNumberYear: 2026,
          defectDate: 2000,
        }),
      ),
    ).toEqual(['engineBrand', 'customer', 'contract', 'arrivalDate', 'internalNumber', 'defectDate']);
  });

  it('заполненное не предлагает дописывать', () => {
    const full = card({
      arrivalDate: 500,
      engineBrandId: 'b1',
      engineBrand: 'Bosch',
      customerId: 'c1',
      contractId: 'k1',
      internalNumber: '41',
      internalNumberYear: 2026,
      hasDefectStage: true,
    });
    expect(
      engineBulkIntakeMissingFields(
        full,
        offer({
          brandId: 'b1',
          customerId: 'c1',
          contractId: 'k1',
          arrivalDate: 1000,
          internalNumber: '41',
          internalNumberYear: 2026,
          defectDate: 2000,
        }),
      ),
    ).toEqual([]);
  });

  it('дату дефектовки дописывает, только пока этапа нет', () => {
    const withStage = card({ hasDefectStage: true });
    expect(engineBulkIntakeMissingFields(withStage, offer({ defectDate: 2000 }))).toEqual([]);
    expect(engineBulkIntakeMissingFields(card(), offer({ defectDate: 2000 }))).toEqual(['defectDate']);
  });

  it('чего форма не предлагает, того не требует: без полей список пуст', () => {
    expect(engineBulkIntakeMissingFields(card(), offer())).toEqual([]);
  });
});

describe('engineBulkIntakeConflictingFields', () => {
  it('называет расхождения — их «обновить» не перезаписывает', () => {
    const existing = card({ customerId: 'c2', contractId: 'k2', internalNumber: '41', internalNumberYear: 2026 });
    expect(
      engineBulkIntakeConflictingFields(
        existing,
        offer({ customerId: 'c1', contractId: 'k1', internalNumber: '42', internalNumberYear: 2026 }),
      ),
    ).toEqual(['customer', 'contract', 'internalNumber']);
  });

  it('совпадающие значения расхождением не считает', () => {
    const existing = card({ contractId: 'k1', internalNumber: '041', internalNumberYear: 2026 });
    expect(
      engineBulkIntakeConflictingFields(existing, offer({ contractId: 'k1', internalNumber: '41', internalNumberYear: 2026 })),
    ).toEqual([]);
  });
});

describe('readBulkIntakeInternalNumber', () => {
  it('полный номер несёт свой год', () => {
    expect(readBulkIntakeInternalNumber('41/26', Date.parse('2027-05-01T12:00:00'))).toEqual({
      number: '41',
      year: 2026,
    });
  });

  it('короткий номер получает ТЕКУЩИЙ год', () => {
    expect(readBulkIntakeInternalNumber('41', Date.parse('2027-05-01T12:00:00'))).toEqual({
      number: '41',
      year: 2027,
    });
  });

  it('пусто — номера нет', () => {
    expect(readBulkIntakeInternalNumber('   ', Date.now())).toEqual({ number: null, year: null });
  });
});

describe('engineBulkIntakeInternalNumberDuplicates', () => {
  it('находит пару, занятую двумя строками пачки', () => {
    expect(
      engineBulkIntakeInternalNumberDuplicates([
        { number: '41', year: 2026 },
        { number: '42', year: 2026 },
        { number: '041', year: 2026 },
      ]),
    ).toEqual(['041/26']);
  });

  it('разные годы — разные номера', () => {
    expect(
      engineBulkIntakeInternalNumberDuplicates([
        { number: '41', year: 2026 },
        { number: '41', year: 2027 },
      ]),
    ).toEqual([]);
  });
});

describe('ENGINE_BULK_INTAKE_MAX', () => {
  it('порог описан числом, а не магией в форме', () => {
    expect(ENGINE_BULK_INTAKE_MAX).toBeGreaterThanOrEqual(100);
  });
});
