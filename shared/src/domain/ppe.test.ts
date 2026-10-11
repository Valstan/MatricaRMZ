import { describe, expect, it } from 'vitest';

import {
  addWearMonths,
  nextIssueDates,
  PPE_DAY_MS,
  resolveEmployeeNorms,
  upcomingIssues,
} from './ppe.js';

const NOM_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const NOM_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const T0 = Date.UTC(2026, 9, 11);

describe('ppe: слияние норм', () => {
  it('количества суммируются, срок — минимальный, порядок детерминирован', () => {
    const merged = resolveEmployeeNorms([
      { normSetId: 'ns-2', nomenclatureId: NOM_B, qty: 1, wearMonths: 24 },
      { normSetId: 'ns-1', nomenclatureId: NOM_A, qty: 2, wearMonths: 12 },
      { normSetId: 'ns-2', nomenclatureId: NOM_A, qty: 1, wearMonths: 6 },
    ]);
    expect(merged).toEqual([
      { nomenclatureId: NOM_A, qty: 3, wearMonths: 6 },
      { nomenclatureId: NOM_B, qty: 1, wearMonths: 24 },
    ]);
  });

  it('пустой вход — пустой выход', () => {
    expect(resolveEmployeeNorms([])).toEqual([]);
  });
});

describe('ppe: месяцы календарные', () => {
  it('12 мес от 11.10.2026 — 11.10.2027', () => {
    expect(addWearMonths(T0, 12)).toBe(Date.UTC(2027, 9, 11));
  });
});

describe('ppe: даты следующих выдач', () => {
  const merged = [
    { nomenclatureId: NOM_A, qty: 2, wearMonths: 12 },
    { nomenclatureId: NOM_B, qty: 1, wearMonths: 1 },
  ];

  it('без выдач — neverIssued, срок не тикает из пустоты', () => {
    const [a, b] = nextIssueDates(merged, [], T0);
    expect(a.status).toBe('neverIssued');
    expect(a.nextDueAt).toBeNull();
    expect(b.status).toBe('neverIssued');
  });

  it('свежая выдача — ok, старая — overdue', () => {
    const yearAgo = Date.UTC(2025, 9, 10);
    const [a] = nextIssueDates(merged, [{ nomenclatureId: NOM_A, qty: 2, issuedAt: yearAgo }], T0);
    expect(a.status).toBe('overdue');
    expect(a.nextDueAt).toBe(Date.UTC(2026, 9, 10));
    const [fresh] = nextIssueDates(merged, [{ nomenclatureId: NOM_A, qty: 2, issuedAt: T0 }], T0);
    expect(fresh.status).toBe('ok');
  });

  it('граница dueSoon: 10 дней до срока — dueSoon, 20 — ok', () => {
    const dueIn10 = T0 + 10 * PPE_DAY_MS;
    const last10 = new Date(dueIn10);
    const issued10 = Date.UTC(last10.getUTCFullYear(), last10.getUTCMonth() - 1, last10.getUTCDate());
    const [n10] = nextIssueDates(
      [{ nomenclatureId: NOM_B, qty: 1, wearMonths: 1 }],
      [{ nomenclatureId: NOM_B, qty: 1, issuedAt: issued10 }],
      T0,
    );
    expect(n10.status).toBe('dueSoon');
    const dueIn20 = T0 + 20 * PPE_DAY_MS;
    const last20 = new Date(dueIn20);
    const issued20 = Date.UTC(last20.getUTCFullYear(), last20.getUTCMonth() - 1, last20.getUTCDate());
    const [n20] = nextIssueDates(
      [{ nomenclatureId: NOM_B, qty: 1, wearMonths: 1 }],
      [{ nomenclatureId: NOM_B, qty: 1, issuedAt: issued20 }],
      T0,
    );
    expect(n20.status).toBe('ok');
  });

  it('берётся последняя выдача, а не первая', () => {
    const old = Date.UTC(2024, 0, 1);
    const [a] = nextIssueDates(merged, [
      { nomenclatureId: NOM_A, qty: 2, issuedAt: old },
      { nomenclatureId: NOM_A, qty: 2, issuedAt: T0 },
    ], T0);
    expect(a.lastIssuedAt).toBe(T0);
    expect(a.status).toBe('ok');
  });
});

describe('ppe: ближайшие выдачи', () => {
  it('в горизонт попадают просрочка и близкие сроки, сортировка по дате', () => {
    const merged = [
      { nomenclatureId: NOM_A, qty: 2, wearMonths: 12 },
      { nomenclatureId: NOM_B, qty: 1, wearMonths: 12 },
    ];
    const rows = upcomingIssues(
      merged,
      [
        { nomenclatureId: NOM_B, qty: 1, issuedAt: Date.UTC(2025, 9, 11) },
        { nomenclatureId: NOM_A, qty: 2, issuedAt: Date.UTC(2020, 0, 1) },
      ],
      T0,
      30,
    );
    expect(rows.map((r) => r.nomenclatureId)).toEqual([NOM_A, NOM_B]);
    expect(rows.every((r) => r.status === 'overdue')).toBe(true);
  });

  it('далёкие сроки в короткий горизонт не попадают', () => {
    const rows = upcomingIssues(
      [{ nomenclatureId: NOM_A, qty: 2, wearMonths: 12 }],
      [{ nomenclatureId: NOM_A, qty: 2, issuedAt: T0 }],
      T0,
      30,
    );
    expect(rows).toEqual([]);
  });
});
