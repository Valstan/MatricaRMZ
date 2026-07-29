import { describe, expect, it } from 'vitest';

import {
  addPayment,
  burningEnginesCount,
  collectContractPaymentsEngineIds,
  countdownStatus,
  distributeAmount,
  emptyContractPayments,
  findSlotForEngine,
  formatKopMoney,
  parseContractPayments,
  parseMoneyToKop,
  paymentRowLabel,
  removePayment,
  slotTotals,
  syncSlotsWithPlan,
  updatePayment,
  type ContractPayments,
  type PaymentSlot,
} from './payments.js';

let seq = 0;
const nextId = () => `id-${++seq}`;

function slot(partial: Partial<PaymentSlot> = {}): PaymentSlot {
  return { id: 's1', sectionKey: 'primary', payments: [], ...partial };
}

describe('parseContractPayments', () => {
  it('tolerates garbage', () => {
    expect(parseContractPayments(null)).toEqual(emptyContractPayments());
    expect(parseContractPayments('not json')).toEqual(emptyContractPayments());
    expect(parseContractPayments('{"slots":42}')).toEqual(emptyContractPayments());
    expect(parseContractPayments({ slots: [{ id: '', sectionKey: 'primary' }] }).slots).toHaveLength(0);
  });

  it('round-trips a valid structure and drops broken rows', () => {
    const cp = parseContractPayments({
      version: 1,
      slots: [
        {
          id: 's1',
          sectionKey: 'ДС 2',
          engineBrandId: 'brand-1',
          engineId: 'eng-1',
          contractPriceKop: 100_00,
          payments: [
            { id: 'p1', date: '2026-07-01', amountKop: 50_00, kind: 'advance', countdownStart: true },
            { id: 'broken', date: '2026-07-02', amountKop: 'NaN', kind: 'advance' },
            { id: 'p2', date: '2026-07-03', amountKop: 10_00, kind: 'unknown_kind' },
          ],
        },
      ],
    });
    expect(cp.slots).toHaveLength(1);
    expect(cp.slots[0]?.payments.map((p) => p.id)).toEqual(['p1']);
    expect(cp.slots[0]?.engineId).toBe('eng-1');
  });
});

describe('slotTotals', () => {
  it('sums paid, computes delta vs contract price, finds dates', () => {
    const t = slotTotals(
      slot({
        contractPriceKop: 300_00,
        payments: [
          { id: 'p1', date: '2026-07-10', amountKop: 100_00, kind: 'advance' },
          { id: 'p2', date: '2026-07-01', amountKop: 50_00, kind: 'extra_advance' },
          { id: 'p3', date: '2026-08-01', amountKop: 100_00, kind: 'final' },
        ],
      }),
    );
    expect(t.paidKop).toBe(250_00);
    expect(t.priceKop).toBe(300_00);
    expect(t.deltaKop).toBe(-50_00);
    expect(t.lastPaymentDate).toBe('2026-08-01');
    expect(t.firstAdvanceDate).toBe('2026-07-01');
    expect(t.countdownStartDate).toBe('2026-07-01'); // нет флага — самый ранний аванс
  });

  it('contract_price rows are the price fallback, not payments', () => {
    const t = slotTotals(
      slot({
        payments: [
          { id: 'p0', date: '2026-06-01', amountKop: 500_00, kind: 'contract_price' },
          { id: 'p1', date: '2026-07-01', amountKop: 200_00, kind: 'advance' },
        ],
      }),
    );
    expect(t.priceKop).toBe(500_00);
    expect(t.paidKop).toBe(200_00);
  });

  it('countdownStart flag wins over first advance', () => {
    const t = slotTotals(
      slot({
        payments: [
          { id: 'p1', date: '2026-07-01', amountKop: 1, kind: 'advance' },
          { id: 'p2', date: '2026-07-15', amountKop: 1, kind: 'extra_advance', countdownStart: true },
        ],
      }),
    );
    expect(t.countdownStartDate).toBe('2026-07-15');
  });
});

describe('countdownStatus', () => {
  const started = slot({ payments: [{ id: 'p1', date: '2026-01-01', amountKop: 1, kind: 'advance' }] });

  it('none without a start date or when repaired', () => {
    expect(countdownStatus(slot(), '2026-07-01', false).state).toBe('none');
    expect(countdownStatus(started, '2026-07-01', true).state).toBe('none');
  });

  it('ok / warning / danger thresholds', () => {
    expect(countdownStatus(started, '2026-01-31', false)).toEqual({ state: 'ok', daysElapsed: 30, daysLeft: 60 });
    expect(countdownStatus(started, '2026-02-16', false).state).toBe('warning'); // 46 дней
    expect(countdownStatus(started, '2026-03-12', false).state).toBe('danger'); // осталось 20
    expect(countdownStatus(started, '2026-06-01', false).state).toBe('danger'); // просрочка
  });
});

describe('syncSlotsWithPlan', () => {
  const plan = [{ sectionKey: 'primary', engineBrandId: 'brand-1', qty: 3, unitPrice: 1000 }];

  it('creates slots up to planned qty with seeded price and is idempotent', () => {
    seq = 0;
    const cp1 = syncSlotsWithPlan(emptyContractPayments(), plan, [], nextId);
    expect(cp1.slots).toHaveLength(3);
    expect(cp1.slots[0]?.contractPriceKop).toBe(100_000);
    const cp2 = syncSlotsWithPlan(cp1, plan, [], nextId);
    expect(cp2).toEqual(cp1);
  });

  it('removes only empty excess slots', () => {
    seq = 0;
    const cp1 = syncSlotsWithPlan(emptyContractPayments(), plan, [], nextId);
    const withMoney = addPayment(cp1, cp1.slots[0]!.id, { id: 'p1', date: '2026-07-01', amountKop: 1, kind: 'advance' });
    const shrunk = syncSlotsWithPlan(withMoney, [{ ...plan[0]!, qty: 0 }], [], nextId);
    expect(shrunk.slots).toHaveLength(1);
    expect(shrunk.slots[0]?.payments).toHaveLength(1);
  });

  it('binds an engine to a paid slot first, unbinds a departed engine keeping money', () => {
    seq = 0;
    let cp = syncSlotsWithPlan(emptyContractPayments(), plan, [], nextId);
    cp = addPayment(cp, cp.slots[1]!.id, { id: 'p1', date: '2026-07-01', amountKop: 1, kind: 'advance' });
    cp = syncSlotsWithPlan(cp, plan, [{ engineId: 'eng-1', sectionKey: 'primary', engineBrandId: 'brand-1' }], nextId);
    expect(findSlotForEngine(cp, 'eng-1')?.payments).toHaveLength(1); // слот с деньгами выбран первым
    const detached = syncSlotsWithPlan(cp, plan, [], nextId);
    expect(findSlotForEngine(detached, 'eng-1')).toBeUndefined();
    expect(detached.slots.find((s) => s.payments.length > 0)).toBeTruthy();
  });

  it('creates an extra slot when engines exceed the plan', () => {
    seq = 0;
    const cp = syncSlotsWithPlan(
      emptyContractPayments(),
      [{ sectionKey: 'primary', engineBrandId: 'brand-1', qty: 1, unitPrice: 0 }],
      [
        { engineId: 'eng-1', sectionKey: 'primary' },
        { engineId: 'eng-2', sectionKey: 'primary' },
      ],
      nextId,
    );
    expect(cp.slots).toHaveLength(2);
    expect(findSlotForEngine(cp, 'eng-2')).toBeTruthy();
  });
});

describe('distributeAmount', () => {
  function threeSlots(): ContractPayments {
    seq = 0;
    return syncSlotsWithPlan(
      emptyContractPayments(),
      [{ sectionKey: 'primary', engineBrandId: 'b', qty: 3, unitPrice: 0 }],
      [],
      nextId,
    );
  }

  it('splits evenly, kopeck remainder to the first slot', () => {
    const cp = distributeAmount(threeSlots(), 'primary', 100_00, 'advance', '2026-07-01', nextId);
    const amounts = cp.slots.map((s) => s.payments[0]?.amountKop);
    expect(amounts).toEqual([33_34, 33_33, 33_33]);
    expect(amounts.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(100_00);
  });

  it('respects slotCount and marks countdown start once per slot', () => {
    const cp = distributeAmount(threeSlots(), 'primary', 100_00, 'advance', '2026-07-01', nextId, 2);
    expect(cp.slots[0]?.payments).toHaveLength(1);
    expect(cp.slots[2]?.payments).toHaveLength(0);
    expect(cp.slots[0]?.payments[0]?.countdownStart).toBe(true);
    const again = distributeAmount(cp, 'primary', 50_00, 'extra_advance', '2026-08-01', nextId, 2);
    // старт уже есть — второй платёж флага не получает
    expect(again.slots[0]?.payments[1]?.countdownStart).toBeUndefined();
  });

  it('no-op on empty section or bad amount', () => {
    const cp = threeSlots();
    expect(distributeAmount(cp, 'ДС 9', 100, 'advance', '2026-07-01', nextId)).toBe(cp);
    expect(distributeAmount(cp, 'primary', 0, 'advance', '2026-07-01', nextId)).toBe(cp);
  });
});

describe('payment row mutations', () => {
  const base: ContractPayments = {
    version: 1,
    slots: [slot({ payments: [{ id: 'p1', date: '2026-07-01', amountKop: 1, kind: 'advance', countdownStart: true }] })],
  };

  it('addPayment moves the countdown flag when the new row claims it', () => {
    const cp = addPayment(base, 's1', { id: 'p2', date: '2026-07-02', amountKop: 2, kind: 'extra_advance', countdownStart: true });
    const flags = cp.slots[0]!.payments.filter((p) => p.countdownStart).map((p) => p.id);
    expect(flags).toEqual(['p2']);
  });

  it('updatePayment and removePayment work by id', () => {
    const updated = updatePayment(base, 's1', { id: 'p1', date: '2026-07-05', amountKop: 9, kind: 'final' });
    expect(updated.slots[0]?.payments[0]?.amountKop).toBe(9);
    const removed = removePayment(base, 's1', 'p1');
    expect(removed.slots[0]?.payments).toHaveLength(0);
  });
});

describe('burningEnginesCount', () => {
  it('counts danger slots, repaired engines excluded', () => {
    const cp: ContractPayments = {
      version: 1,
      slots: [
        slot({ id: 'a', engineId: 'eng-1', payments: [{ id: 'p', date: '2026-01-01', amountKop: 1, kind: 'advance' }] }),
        slot({ id: 'b', engineId: 'eng-2', payments: [{ id: 'p', date: '2026-01-01', amountKop: 1, kind: 'advance' }] }),
        slot({ id: 'c', payments: [{ id: 'p', date: '2026-01-01', amountKop: 1, kind: 'advance' }] }),
      ],
    };
    expect(burningEnginesCount(cp, '2026-06-01', new Set(['eng-2']))).toBe(2); // eng-1 + пустой слот
  });
});

describe('money helpers', () => {
  it('formats and parses kopecks', () => {
    expect(formatKopMoney(123_456_789)).toBe('1 234 567,89');
    expect(formatKopMoney(-50)).toBe('−0,50');
    expect(parseMoneyToKop('1 234 567,89')).toBe(123_456_789);
    expect(parseMoneyToKop('100')).toBe(10_000);
    expect(parseMoneyToKop('мусор')).toBeNull();
  });
});

describe('labels and refs', () => {
  it('numbers extra advances only when there are several', () => {
    const s = slot({
      payments: [
        { id: 'p1', date: '', amountKop: 1, kind: 'extra_advance' },
        { id: 'p2', date: '', amountKop: 1, kind: 'extra_advance' },
      ],
    });
    expect(paymentRowLabel(s, s.payments[0]!)).toBe('Доаванс №1');
    expect(paymentRowLabel(s, s.payments[1]!)).toBe('Доаванс №2');
    const single = slot({ payments: [{ id: 'p1', date: '', amountKop: 1, kind: 'extra_advance' }] });
    expect(paymentRowLabel(single, single.payments[0]!)).toBe('Доаванс');
  });

  it('collects engine ids for the reverse index', () => {
    const cp: ContractPayments = {
      version: 1,
      slots: [slot({ id: 'a', engineId: 'eng-1' }), slot({ id: 'b' })],
    };
    expect(collectContractPaymentsEngineIds(cp)).toEqual([{ path: 'slots[0].engineId', engineId: 'eng-1' }]);
  });
});
