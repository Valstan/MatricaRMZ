import { describe, expect, it } from 'vitest';

import {
  buildPpeEmployeeIssueRows,
  buildPpeRequestPositions,
  ppePositionLabel,
  ppeResolvePositionId,
  ppeShortage,
  type PpeIssuedItem,
  type PpeSupplyItem,
} from './ppeIssueCoverage.js';

function item(overrides: Partial<PpeSupplyItem> = {}): PpeSupplyItem {
  return {
    employeeId: 'e1',
    positionId: 'base-1',
    name: 'Обувь специальная для защиты от механических воздействий',
    size: '44',
    sizeId: 'base-1-44',
    normQty: 1,
    issuedInPeriod: 0,
    issuedTotal: 0,
    status: 'neverIssued',
    wearText: '12 мес.',
    nextDueAt: null,
    ...overrides,
  };
}

describe('ppe: нехватка по позиции', () => {
  it('не выдавали ни разу — не хватает всей нормы', () => {
    expect(ppeShortage(item({ normQty: 2 }))).toEqual({ qty: 2, reason: 'never_issued' });
  });

  it('выдано частично — не хватает остатка нормы', () => {
    const result = ppeShortage(item({ normQty: 4, issuedInPeriod: 1, issuedTotal: 1, status: 'ok' }));
    expect(result).toEqual({ qty: 3, reason: 'partial' });
  });

  it('срок вышел — нужна новая вещь, а не остаток нормы', () => {
    const result = ppeShortage(item({ normQty: 1, issuedInPeriod: 1, issuedTotal: 1, status: 'overdue' }));
    expect(result).toEqual({ qty: 1, reason: 'overdue' });
  });

  it('вещь сдали — у сотрудника её нет', () => {
    const result = ppeShortage(item({ normQty: 1, issuedInPeriod: 1, issuedTotal: 1, status: 'returned' }));
    expect(result).toEqual({ qty: 1, reason: 'returned' });
  });

  it('выдано по норме и срок не вышел — нехватки нет', () => {
    const result = ppeShortage(item({ normQty: 1, issuedInPeriod: 1, issuedTotal: 1, status: 'ok' }));
    expect(result).toEqual({ qty: 0, reason: 'none' });
  });
});

describe('ppe: сопоставление выдачи с нормой', () => {
  it('выдача по размеру относится к базовой позиции нормы', () => {
    const positionIds = new Set(['base-1']);
    expect(ppeResolvePositionId({ nomenclatureId: 'base-1-44', parentId: 'base-1', positionIds })).toBe('base-1');
  });

  it('точное совпадение важнее базы', () => {
    const positionIds = new Set(['base-1-44']);
    expect(ppeResolvePositionId({ nomenclatureId: 'base-1-44', parentId: 'base-1', positionIds })).toBe('base-1-44');
  });

  it('выдано сверх нормы — позиция не найдена', () => {
    const positionIds = new Set(['base-1']);
    expect(ppeResolvePositionId({ nomenclatureId: 'other-9', parentId: null, positionIds })).toBeNull();
  });
});

describe('ppe: подпись позиции', () => {  it('размер числа — с «р.», буквенный — без', () => {
    expect(ppePositionLabel('Костюм зимний', '48')).toBe('Костюм зимний (р. 48)');
    expect(ppePositionLabel('Плащ ФОРЕСТ', 'XXL')).toBe('Плащ ФОРЕСТ (XXL)');
    expect(ppePositionLabel('Костюм зимний', null)).toBe('Костюм зимний');
  });
});

describe('ppe: ведомость по сотрудникам', () => {
  const items: PpeSupplyItem[] = [
    item({ employeeId: 'e1', positionId: 'base-1', name: 'Обувь', size: '44', sizeId: 'base-1-44', status: 'neverIssued', normQty: 1 }),
    item({
      employeeId: 'e1',
      positionId: 'base-2',
      name: 'Жилет сигнальный',
      size: '48',
      sizeId: 'base-2-48',
      status: 'ok',
      normQty: 2,
      issuedInPeriod: 2,
      issuedTotal: 2,
    }),
  ];
  const issued: PpeIssuedItem[] = [
    { employeeId: 'e1', positionId: 'base-2', name: 'Жилет сигнальный', size: '48', sizeId: 'base-2-48', qty: 2 },
  ];

  it('одна строка на сотрудника: набор выданного и перечень нехватки', () => {
    const rows = buildPpeEmployeeIssueRows({
      employees: [{ employeeId: 'e1', fullName: 'Иванов Иван', personnelNo: '0001', postTitle: 'Слесарь' }],
      items,
      issued,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.issuedText).toBe('Жилет сигнальный (р. 48) × 2');
    expect(rows[0]!.missingText).toBe('Обувь (р. 44) — не выдано (1 шт)');
    expect(rows[0]!.state).toBe('не обеспечен');
    expect(rows[0]!.missingCount).toBe(1);
    expect(rows[0]!.positionsCount).toBe(2);
  });

  it('обеспеченный сотрудник: набор есть, нехватки нет', () => {
    const rows = buildPpeEmployeeIssueRows({
      employees: [{ employeeId: 'e2', fullName: 'Петров Пётр' }],
      items: [item({ employeeId: 'e2', status: 'ok', normQty: 1, issuedInPeriod: 1, issuedTotal: 1 })],
      issued: [],
    });
    expect(rows[0]!.state).toBe('обеспечен');
    expect(rows[0]!.missingText).toBe('');
  });

  it('у сотрудника без норм — состояние «нет норм»', () => {
    const rows = buildPpeEmployeeIssueRows({
      employees: [{ employeeId: 'e3', fullName: 'Сидоров Сидор' }],
      items: [],
      issued: [],
    });
    expect(rows[0]!.state).toBe('нет норм');
  });
});

describe('ppe: заявка на закупку', () => {
  const items: PpeSupplyItem[] = [
    item({ employeeId: 'e1', positionId: 'base-1', name: 'Обувь', size: '44', sizeId: 'base-1-44', normQty: 1, status: 'neverIssued' }),
    item({ employeeId: 'e2', positionId: 'base-1', name: 'Обувь', size: '44', sizeId: 'base-1-44', normQty: 1, status: 'neverIssued' }),
    item({
      employeeId: 'e3',
      positionId: 'base-1',
      name: 'Обувь',
      size: '46',
      sizeId: 'base-1-46',
      normQty: 1,
      status: 'neverIssued',
    }),
  ];

  it('к закупке = потребность минус остаток; остаток вычитается один раз', () => {
    const rows = buildPpeRequestPositions({
      items,
      issued: [],
      stockByNomenclature: new Map([['base-1-44', 1]]),
    });
    const r44 = rows.find((r) => r.size === '44')!;
    const r46 = rows.find((r) => r.size === '46')!;
    expect(r44.demandQty).toBe(2);
    expect(r44.stockQty).toBe(1);
    expect(r44.toBuyQty).toBe(1);
    expect(r44.employeesCount).toBe(2);
    // У позиции без остатка остаток неизвестен — прочерк, а не ноль.
    expect(r46.stockQty).toBeNull();
    expect(r46.toBuyQty).toBe(1);
  });

  it('сумма строк заявки сходится с итогом', () => {
    const rows = buildPpeRequestPositions({
      items,
      issued: [],
      stockByNomenclature: new Map([['base-1-44', 1]]),
    });
    const total = rows.reduce((s, r) => s + r.toBuyQty, 0);
    expect(total).toBe(2);
  });

  it('выданное попадает в заявку как отдельная величина и не вычитается дважды', () => {
    const rows = buildPpeRequestPositions({
      items: [
        item({
          employeeId: 'e1',
          normQty: 2,
          status: 'ok',
          issuedInPeriod: 2,
          issuedTotal: 2,
        }),
      ],
      issued: [{ employeeId: 'e1', positionId: 'base-1', name: 'Обувь', size: '44', sizeId: 'base-1-44', qty: 2 }],
      stockByNomenclature: new Map([['base-1-44', 3]]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.issuedQty).toBe(2);
    expect(rows[0]!.demandQty).toBe(0);
    expect(rows[0]!.toBuyQty).toBe(0);
  });

  it('цена и сумма считаются от к закупке', () => {
    const rows = buildPpeRequestPositions({
      items: [item({ normQty: 3, status: 'neverIssued' })],
      issued: [],
      stockByNomenclature: new Map([['base-1-44', 1]]),
      prices: new Map([['base-1-44', 1200]]),
    });
    expect(rows[0]!.toBuyQty).toBe(2);
    expect(rows[0]!.priceRub).toBe(1200);
    expect(rows[0]!.amountRub).toBe(2400);
  });

  it('цены нет — прочерк, а не ноль', () => {
    const rows = buildPpeRequestPositions({
      items: [item({ normQty: 1, status: 'neverIssued' })],
      issued: [],
    });
    expect(rows[0]!.priceRub).toBeNull();
    expect(rows[0]!.amountRub).toBeNull();
  });
});
