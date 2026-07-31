import { describe, expect, it } from 'vitest';

import {
  addPayment,
  attachEngineToSlot,
  burningEnginesCount,
  collectContractPaymentsEngineIds,
  countdownStatus,
  distributeAmount,
  distributeAmountToSlots,
  emptyContractPayments,
  findSlotForEngine,
  formatKopMoney,
  parseContractPayments,
  parseMoneyToKop,
  paymentRowLabel,
  planSlotForEngine,
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

describe('марка слота — инвариант', () => {
  const twoBrands = [
    { sectionKey: 'primary', engineBrandId: 'brand-A', qty: 1, unitPrice: 0 },
    { sectionKey: 'primary', engineBrandId: 'brand-B', qty: 1, unitPrice: 0 },
  ];

  it('двигатель НЕ садится в свободный слот чужой марки — заводится слот сверх плана', () => {
    seq = 0;
    let cp = syncSlotsWithPlan(emptyContractPayments(), twoBrands, [], nextId);
    cp = syncSlotsWithPlan(cp, twoBrands, [{ engineId: 'eng-B1', sectionKey: 'primary', engineBrandId: 'brand-B' }], nextId);
    cp = syncSlotsWithPlan(
      cp,
      twoBrands,
      [
        { engineId: 'eng-B1', sectionKey: 'primary', engineBrandId: 'brand-B' },
        { engineId: 'eng-B2', sectionKey: 'primary', engineBrandId: 'brand-B' },
      ],
      nextId,
    );
    const slotA = cp.slots.find((s) => s.engineBrandId === 'brand-A')!;
    expect(slotA.engineId).toBeUndefined();
    expect(findSlotForEngine(cp, 'eng-B2')?.engineBrandId).toBe('brand-B');
    expect(cp.slots).toHaveLength(3);
  });

  it('двигатель без марки по-прежнему занимает любой свободный слот', () => {
    seq = 0;
    let cp = syncSlotsWithPlan(emptyContractPayments(), twoBrands, [], nextId);
    cp = syncSlotsWithPlan(cp, twoBrands, [{ engineId: 'eng-x', sectionKey: 'primary' }], nextId);
    expect(cp.slots).toHaveLength(2);
    expect(findSlotForEngine(cp, 'eng-x')).toBeTruthy();
  });
});

describe('planSlotForEngine / attachEngineToSlot', () => {
  const plan = [
    { sectionKey: 'primary', engineBrandId: 'brand-A', qty: 1, unitPrice: 0 },
    { sectionKey: 'ДС 1', engineBrandId: 'brand-B', qty: 1, unitPrice: 0 },
  ];
  const sectionKeys = ['primary', 'ДС 1'];

  it('находит свободный слот своей марки в другой секции, если в предпочтённой его нет', () => {
    seq = 0;
    const cp = syncSlotsWithPlan(emptyContractPayments(), plan, [], nextId);
    const placement = planSlotForEngine({ cp, sectionKeys, engineBrandId: 'brand-B', preferredSectionKey: 'primary' });
    expect(placement.sectionKey).toBe('ДС 1');
    expect(placement.overPlan).toBe(false);
    expect(cp.slots.find((s) => s.id === placement.slotId)?.engineBrandId).toBe('brand-B');
  });

  it('предпочитает слот, на котором уже лежат деньги', () => {
    seq = 0;
    let cp = syncSlotsWithPlan(emptyContractPayments(), [{ ...plan[0]!, qty: 2 }], [], nextId);
    cp = addPayment(cp, cp.slots[1]!.id, { id: 'p1', date: '2026-07-01', amountKop: 500, kind: 'advance' });
    const placement = planSlotForEngine({ cp, sectionKeys, engineBrandId: 'brand-A' });
    expect(placement.slotId).toBe(cp.slots[1]!.id);
  });

  it('марка не запланирована → overPlan, слот заводится с маркой двигателя', () => {
    seq = 0;
    const cp = syncSlotsWithPlan(emptyContractPayments(), plan, [], nextId);
    const placement = planSlotForEngine({ cp, sectionKeys, engineBrandId: 'brand-Z', preferredSectionKey: 'primary' });
    expect(placement).toEqual({ sectionKey: 'primary', overPlan: true });
    const next = attachEngineToSlot(cp, placement, 'eng-z', nextId, 'brand-Z');
    expect(next.slots).toHaveLength(cp.slots.length + 1);
    expect(findSlotForEngine(next, 'eng-z')?.engineBrandId).toBe('brand-Z');
  });

  it('переезд двигателя не оставляет его в двух слотах, деньги остаются на прежнем', () => {
    seq = 0;
    let cp = syncSlotsWithPlan(emptyContractPayments(), plan, [], nextId);
    const first = planSlotForEngine({ cp, sectionKeys, engineBrandId: 'brand-A' });
    cp = attachEngineToSlot(cp, first, 'eng-1', nextId, 'brand-A');
    cp = addPayment(cp, first.slotId!, { id: 'p1', date: '2026-07-01', amountKop: 700, kind: 'advance' });
    const second = planSlotForEngine({ cp, sectionKeys, engineBrandId: 'brand-B' });
    cp = attachEngineToSlot(cp, second, 'eng-1', nextId, 'brand-B');
    expect(cp.slots.filter((s) => s.engineId === 'eng-1')).toHaveLength(1);
    expect(cp.slots.find((s) => s.id === first.slotId)?.payments).toHaveLength(1);
  });
});

describe('distributeAmountToSlots', () => {
  const plan = [
    { sectionKey: 'primary', engineBrandId: 'brand-A', qty: 2, unitPrice: 0 },
    { sectionKey: 'primary', engineBrandId: 'brand-B', qty: 2, unitPrice: 0 },
  ];

  function fourSlots(): ContractPayments {
    seq = 0;
    return syncSlotsWithPlan(emptyContractPayments(), plan, [], nextId);
  }

  it('разносит только по выбранным слотам, чужие марки не трогает', () => {
    const cp = fourSlots();
    const brandA = cp.slots.filter((s) => s.engineBrandId === 'brand-A').map((s) => s.id);
    const next = distributeAmountToSlots(cp, brandA, 1_000_000, 'advance', '2026-07-14', nextId);
    for (const s of next.slots) {
      if (s.engineBrandId === 'brand-A') expect(s.payments[0]?.amountKop).toBe(500_000);
      else expect(s.payments).toHaveLength(0);
    }
  });

  it('остаток копеек — первому по порядку слотов, а не по порядку кликов', () => {
    const cp = fourSlots();
    const ids = cp.slots.map((s) => s.id);
    const forward = distributeAmountToSlots(cp, ids, 100, 'advance', '2026-07-14', nextId);
    const reversed = distributeAmountToSlots(cp, [...ids].reverse(), 100, 'advance', '2026-07-14', nextId);
    expect(forward.slots.map((s) => s.payments[0]?.amountKop)).toEqual([25, 25, 25, 25]);
    const amounts = distributeAmountToSlots(cp, ids, 102, 'advance', '2026-07-14', nextId).slots.map(
      (s) => s.payments[0]?.amountKop,
    );
    expect(amounts).toEqual([27, 25, 25, 25]);
    expect(reversed.slots.map((s) => s.payments[0]?.amountKop)).toEqual(
      forward.slots.map((s) => s.payments[0]?.amountKop),
    );
  });

  it('ставит старт отсчёта только там, где его ещё не было', () => {
    let cp = fourSlots();
    const ids = cp.slots.map((s) => s.id);
    cp = addPayment(cp, ids[0]!, { id: 'p0', date: '2026-06-01', amountKop: 10, kind: 'advance', countdownStart: true });
    const next = distributeAmountToSlots(cp, ids, 400, 'advance', '2026-07-14', nextId);
    expect(next.slots[0]!.payments.filter((p) => p.countdownStart)).toHaveLength(1);
    expect(next.slots[0]!.payments[0]!.id).toBe('p0');
    expect(next.slots[1]!.payments[0]!.countdownStart).toBe(true);
  });

  it('чинит слот, у которого стартовых платежей было два', () => {
    let cp = fourSlots();
    const id = cp.slots[0]!.id;
    cp = addPayment(cp, id, { id: 'p1', date: '2026-06-01', amountKop: 10, kind: 'advance', countdownStart: true });
    cp = {
      version: 1,
      slots: cp.slots.map((s) =>
        s.id === id
          ? {
              ...s,
              payments: [
                ...s.payments,
                { id: 'p2', date: '2026-06-02', amountKop: 10, kind: 'advance' as const, countdownStart: true },
              ],
            }
          : s,
      ),
    };
    const next = distributeAmountToSlots(cp, [id], 100, 'final', '2026-07-14', nextId);
    expect(next.slots[0]!.payments.filter((p) => p.countdownStart)).toHaveLength(1);
  });

  it('окончательный расчёт отсчёт не запускает, примечание доезжает', () => {
    const cp = fourSlots();
    const next = distributeAmountToSlots(cp, [cp.slots[0]!.id], 100, 'final', '2026-07-14', nextId, ' по акту №7 ');
    expect(next.slots[0]!.payments[0]!.countdownStart).toBeUndefined();
    expect(next.slots[0]!.payments[0]!.note).toBe('по акту №7');
  });

  it('пустая выборка и мусорная сумма ничего не меняют', () => {
    const cp = fourSlots();
    expect(distributeAmountToSlots(cp, [], 100, 'advance', '2026-07-14', nextId)).toBe(cp);
    expect(distributeAmountToSlots(cp, [cp.slots[0]!.id], 0, 'advance', '2026-07-14', nextId)).toBe(cp);
    expect(distributeAmountToSlots(cp, ['нет-такого'], 100, 'advance', '2026-07-14', nextId)).toBe(cp);
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
