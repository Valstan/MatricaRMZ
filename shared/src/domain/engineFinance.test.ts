import { describe, expect, it } from 'vitest';

import {
  buildEngineFinanceTable,
  engineFinanceStatusLabel,
  type EngineFinanceEngine,
} from './engineFinance.js';
import { emptyContractPayments, type ContractPayments, type PaymentSlot } from './payments.js';

let seq = 0;
const nextId = () => `id-${++seq}`;

function slot(partial: Partial<PaymentSlot> = {}): PaymentSlot {
  return { id: nextId(), sectionKey: 'primary', payments: [], ...partial };
}

function engine(partial: Partial<EngineFinanceEngine> = {}): EngineFinanceEngine {
  return { id: nextId(), engineNumber: 'E-1', engineBrand: 'В-59', ...partial };
}

describe('buildEngineFinanceTable', () => {
  it('строка двигателя: цена по контракту, расчётный аванс 50%, внесено и долг', () => {
    const cp: ContractPayments = {
      version: 1,
      slots: [
        slot({
          id: 's1',
          sectionKey: 'primary',
          engineBrandId: 'brand-1',
          engineId: 'e1',
          contractPriceKop: 1_000_000,
          payments: [{ id: 'p1', date: '2026-11-01', amountKop: 500_000, kind: 'advance' }],
        }),
      ],
    };
    const table = buildEngineFinanceTable({
      contractPayments: cp,
      engines: [engine({ id: 'e1', engineNumber: 'И01', engineBrand: 'В-59', engineBrandId: 'brand-1' })],
      advancePercent: 50,
    });
    const row = table.sections[0]?.rows[0];
    expect(row?.priceKop).toBe(1_000_000);
    expect(row?.plannedAdvanceKop).toBe(500_000);
    expect(row?.paidAdvanceKop).toBe(500_000);
    expect(row?.paidFinalKop).toBe(0);
    expect(row?.dueKop).toBe(500_000);
    expect(table.totals.dueKop).toBe(500_000);
  });

  it('разделы: основной договор, затем ДС — с итогами по каждому', () => {
    const cp: ContractPayments = {
      version: 1,
      slots: [
        slot({ id: 's1', sectionKey: 'primary', engineId: 'e1', contractPriceKop: 100_000 }),
        slot({ id: 's2', sectionKey: 'ДС 1', engineId: 'e2', contractPriceKop: 200_000 }),
      ],
    };
    const table = buildEngineFinanceTable({
      contractPayments: cp,
      engines: [engine({ id: 'e1' }), engine({ id: 'e2' })],
    });
    expect(table.sections.map((s) => s.sectionKey)).toEqual(['primary', 'ДС 1']);
    expect(table.sections[0]?.totals.priceKop).toBe(100_000);
    expect(table.sections[1]?.totals.priceKop).toBe(200_000);
    expect(table.totals.priceKop).toBe(300_000);
  });

  it('движок без места попадает в свой раздел, а его цена — по плану марки', () => {
    const cp: ContractPayments = { version: 1, slots: [] };
    const table = buildEngineFinanceTable({
      contractPayments: cp,
      engines: [engine({ id: 'e1', engineBrandId: 'brand-1', contractSectionNumber: 'ДС 2' })],
      plan: [{ sectionKey: 'ДС 2', engineBrandId: 'brand-1', qty: 3, unitPrice: 500 }],
    });
    const row = table.sections[0]?.rows[0];
    expect(table.sections[0]?.sectionKey).toBe('ДС 2');
    expect(row?.priceKop).toBe(50_000);
    expect(row?.priceFromPlan).toBe(true);
    expect(row?.noSlot).toBe(true);
    expect(row?.paidAdvanceKop).toBe(0);
  });

  it('марка, запланированная в двух разделах, — цена не угадывается', () => {
    const table = buildEngineFinanceTable({
      contractPayments: emptyContractPayments(),
      engines: [engine({ id: 'e1', engineBrandId: 'brand-1' })],
      plan: [
        { sectionKey: 'primary', engineBrandId: 'brand-1', qty: 1, unitPrice: 500 },
        { sectionKey: 'ДС 1', engineBrandId: 'brand-1', qty: 1, unitPrice: 700 },
      ],
    });
    const row = table.sections[0]?.rows[0];
    expect(row?.priceKop).toBe(0);
    expect(row?.priceFromPlan).toBe(false);
  });

  it('плановое место без движка видно отдельной строкой: его ждём', () => {
    const cp: ContractPayments = {
      version: 1,
      slots: [slot({ id: 's1', sectionKey: 'primary', contractPriceKop: 300_000, payments: [{ id: 'p1', date: '2026-11-01', amountKop: 150_000, kind: 'advance' }] })],
    };
    const table = buildEngineFinanceTable({ contractPayments: cp, engines: [] });
    const row = table.sections[0]?.rows[0];
    expect(row?.emptySlot).toBe(true);
    expect(row?.statusLabel).toBe('двигатель не пришёл');
    expect(row?.priceKop).toBe(300_000);
    expect(row?.paidAdvanceKop).toBe(150_000);
    expect(row?.dueKop).toBe(150_000);
  });

  it('окончательный расчёт уменьшает долг, а не увеличивает его', () => {
    const cp: ContractPayments = {
      version: 1,
      slots: [
        slot({
          id: 's1',
          sectionKey: 'primary',
          engineId: 'e1',
          contractPriceKop: 1_000_000,
          payments: [
            { id: 'p1', date: '2026-11-01', amountKop: 500_000, kind: 'advance' },
            { id: 'p2', date: '2026-11-20', amountKop: 400_000, kind: 'final' },
          ],
        }),
      ],
    };
    const table = buildEngineFinanceTable({
      contractPayments: cp,
      engines: [engine({ id: 'e1' })],
    });
    const row = table.sections[0]?.rows[0];
    expect(row?.paidAdvanceKop).toBe(500_000);
    expect(row?.paidFinalKop).toBe(400_000);
    expect(row?.dueKop).toBe(100_000);
  });

  it('доаванс считается вместе с авансом', () => {
    const cp: ContractPayments = {
      version: 1,
      slots: [
        slot({
          id: 's1',
          sectionKey: 'primary',
          engineId: 'e1',
          contractPriceKop: 1_000_000,
          payments: [{ id: 'p1', date: '2026-11-01', amountKop: 200_000, kind: 'extra_advance' }],
        }),
      ],
    };
    const table = buildEngineFinanceTable({
      contractPayments: cp,
      engines: [engine({ id: 'e1' })],
    });
    expect(table.sections[0]?.rows[0]?.paidAdvanceKop).toBe(200_000);
  });

  it('состояние двигателя: терминальные исходы важнее промежуточных', () => {
    expect(engineFinanceStatusLabel({ statusFlags: { status_rejected: true, status_repaired: true } })).toBe('Забракован');
    expect(engineFinanceStatusLabel({ statusFlags: { status_customer_accepted: true } })).toBe('Принято заказчиком');
    expect(engineFinanceStatusLabel({ statusFlags: { status_repair_started: true } })).toBe('Начат ремонт');
    expect(engineFinanceStatusLabel({ arrivalDate: 1 })).toBe('Приход на завод');
    expect(engineFinanceStatusLabel({})).toBe('—');
  });

  it('итоги по договору — сумма итогов по разделам', () => {
    const cp: ContractPayments = {
      version: 1,
      slots: [
        slot({ id: 's1', sectionKey: 'primary', engineId: 'e1', contractPriceKop: 100_000 }),
        slot({ id: 's2', sectionKey: 'ДС 1', engineId: 'e2', contractPriceKop: 250_000 }),
        slot({ id: 's3', sectionKey: 'ДС 1', contractPriceKop: 50_000 }),
      ],
    };
    const table = buildEngineFinanceTable({
      contractPayments: cp,
      engines: [engine({ id: 'e1' }), engine({ id: 'e2' })],
    });
    expect(table.totals.count).toBe(3);
    expect(table.totals.priceKop).toBe(400_000);
    expect(table.totals.dueKop).toBe(400_000);
  });
});
