/**
 * Журнал приёмки СИЗ: факты и нормы — разные величины, и это проверяется тестом.
 */
import { describe, expect, it } from 'vitest';

import { buildAcceptanceJournal, buildUndeliveredReport } from './ppeAcceptance.js';
import type { PpeAcceptanceFact, PpeEmployeeNormContext } from './ppeAcceptance.js';

const NOW = Date.UTC(2026, 10, 5);

function fact(over: Partial<PpeAcceptanceFact> = {}): PpeAcceptanceFact {
  return {
    issuedAt: NOW - 86_400_000,
    employeeId: 'emp-1',
    personnelNo: '0001',
    fullName: 'Иванов Иван',
    postTitle: 'Кладовщик',
    departmentName: 'Склад',
    nomenclatureId: 'nom-1',
    itemName: 'Куртка зимняя, р.52',
    size: '52',
    qty: 1,
    documentNo: 'ТД-12',
    ...over,
  };
}

function context(over: Partial<PpeEmployeeNormContext> = {}): PpeEmployeeNormContext {
  return {
    employeeId: 'emp-1',
    nomenclatureId: 'nom-1',
    qty: 12,
    wearKind: 'annual',
    wearMonths: null,
    itemName: 'Куртка зимняя',
    ...over,
  };
}

describe('журнал приёмки СИЗ', () => {
  it('количество по норме и срок — разные колонки', () => {
    const rows = buildAcceptanceJournal([fact()], [context()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.normQty).toBe(12); // количество на год
    expect(rows[0]!.qty).toBe(1); // выдано
    expect(rows[0]!.wearText).toBe('срок не задан');
    expect(rows[0]!.wearMonths).toBeNull();
  });

  it('выдача сверх нормы попадает в журросвсегда, но без количества по норме', () => {
    const rows = buildAcceptanceJournal([fact({ nomenclatureId: 'nom-x' })], [context()]);
    expect(rows[0]!.inNorm).toBe(false);
    expect(rows[0]!.normQty).toBeNull();
  });

  it('вид нормы не теряется: срок кладовщика виден как «(кладовщик)»', () => {
    const rows = buildAcceptanceJournal(
      [fact()],
      [context({ wearKind: 'months_clerk', wearMonths: 6 })],
    );
    expect(rows[0]!.wearText).toBe('6 мес. (кладовщик)');
  });

  it('порядок журнала: по дате выдачи, иначе строки прыгают', () => {
    const rows = buildAcceptanceJournal(
      [fact({ issuedAt: NOW - 86_400_000 }), fact({ issuedAt: NOW - 172_800_000 })],
      [context()],
    );
    expect(rows[0]!.issuedAt).toBe(NOW - 172_800_000);
  });

  it('счёт по количеству и счёт по сроку — независимые величины', () => {
    const rows = buildUndeliveredReport({
      contexts: [
        context({ qty: 2, wearKind: 'months', wearMonths: 12 }),
        context({ nomenclatureId: 'nom-2', qty: 5, wearKind: 'months', wearMonths: 12 }),
      ],
      issuedByEmployeePosition: [
        { employeeId: 'emp-1', nomenclatureId: 'nom-1', qty: 2 },
        { employeeId: 'emp-1', nomenclatureId: 'nom-2', qty: 1 },
      ],
      employeeInfo: [
        { employeeId: 'emp-1', personnelNo: '0001', fullName: 'Иванов Иван', postTitle: 'Кладовщик' },
      ],
      nextDueAt: new Map([
        ['emp-1|nom-1', NOW - 86_400_000], // срок просрочен
        ['emp-1|nom-2', NOW + 86_400_000],
      ]),
      now: NOW,
    });

    const full = rows.find((r) => r.nomenclatureId === 'nom-1')!;
    expect(full.issuedQty).toBe(2);
    expect(full.qtyShort).toBe(0); // количество выдано целиком
    expect(full.periodOverdue).toBe(true); // а срок просрочен — это другое

    const short = rows.find((r) => r.nomenclatureId === 'nom-2')!;
    expect(short.qtyShort).toBe(4);
    expect(short.periodOverdue).toBe(false);
  });

  it('норма без срока не бывает просроченной: её меняют по износу', () => {
    const rows = buildUndeliveredReport({
      contexts: [context({ wearKind: 'annual', wearMonths: null })],
      issuedByEmployeePosition: [],
      employeeInfo: [
        { employeeId: 'emp-1', personnelNo: '0001', fullName: 'Иванов Иван', postTitle: 'Кладовщик' },
      ],
      nextDueAt: new Map([['emp-1|nom-1', null]]),
      now: NOW,
    });
    expect(rows[0]!.periodOverdue).toBe(false);
    expect(rows[0]!.wearText).toBe('срок не задан');
  });
});
