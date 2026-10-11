import { beforeEach, describe, expect, it, vi } from 'vitest';

// Цена «с 1-го числа» из приказа должна попадать в карточку услуги ночным
// проходом, а не только событием правки. Проход трогает только карточки,
// чья цена разошлась с действующей, — иначе каждая ночь писала бы весь
// каталог в журнал (запись без изменений у `setEntityAttribute` журналируется).

const state = vi.hoisted(() => ({
  selectByTable: new Map<unknown, any[][]>(),
  changes: [] as any[],
}));

vi.mock('../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) })) })),
  };
  return { db };
});

vi.mock('./sync/syncChangeService.js', () => ({
  recordSyncChanges: vi.fn(async (_actor: unknown, changes: unknown[]) => {
    state.changes.push(changes);
  }),
}));

const { attributeDefs, attributeValues, entities, rowOwners, servicePriceHistory } = await import(
  '../database/schema.js'
);
const { stopServicePriceSweepJob, sweepDueServicePrices } = await import('./servicePricingService.js');

const SVC = 'cccccccc-0000-0000-0000-000000000001';
const TYPE_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const DEF_PRICE = 'dddddddd-0000-0000-0000-000000000003';
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const priceRow = (price: number, effectiveFrom: number) => ({
  id: 'h1',
  nomenclatureId: SVC,
  orderId: 'o1',
  price,
  priceCurrency: 'RUB',
  effectiveFrom,
  notes: null,
  createdAt: 1,
  updatedAt: 1,
});

const priceDef = () => [{ id: DEF_PRICE, code: 'price', dataType: 'number' }];

function seedCardWrite() {
  state.selectByTable.set(entities, [[{ id: SVC, typeId: TYPE_ID, createdAt: 1, updatedAt: 1, deletedAt: null }]]);
  state.selectByTable.set(attributeDefs, [priceDef(), priceDef()]);
  state.selectByTable.set(attributeValues, [[]]);
  state.selectByTable.set(rowOwners, [[]]);
}

function priceWrites(): string[] {
  return state.changes.flat().map((c: any) => String(c?.payload?.value_json ?? ''));
}

beforeEach(() => {
  state.selectByTable.clear();
  state.changes.length = 0;
});

describe('ночной проход цен по приказам', () => {
  it('наступившая цена применяется в протухшую карточку', async () => {
    const history = [priceRow(1500, NOW - DAY)];
    state.selectByTable.set(servicePriceHistory, [[{ nomenclatureId: SVC }], history, history]);
    state.selectByTable.set(attributeValues, [[{ valueJson: '1000' }]]);
    seedCardWrite();
    const r = await sweepDueServicePrices(NOW);
    expect(r).toMatchObject({ checked: 1, applied: 1, skipped: 0, failed: 0 });
    expect(priceWrites()).toContain('1500');
  });

  it('сошедшаяся цена карточку не трогает — журнал не спамится', async () => {
    state.selectByTable.set(servicePriceHistory, [[{ nomenclatureId: SVC }], [priceRow(1500, NOW - DAY)]]);
    state.selectByTable.set(attributeValues, [[{ valueJson: '1500' }]]);
    const r = await sweepDueServicePrices(NOW);
    expect(r).toMatchObject({ checked: 1, applied: 0, skipped: 1, failed: 0 });
    expect(state.changes).toHaveLength(0);
  });

  it('будущая строка не наступает и проход пуст', async () => {
    state.selectByTable.set(servicePriceHistory, [[]]);
    const r = await sweepDueServicePrices(NOW);
    expect(r).toMatchObject({ checked: 0, applied: 0, skipped: 0, failed: 0 });
    expect(state.changes).toHaveLength(0);
  });

  it('строка без наступивших — пропуск без записи', async () => {
    state.selectByTable.set(servicePriceHistory, [[{ nomenclatureId: SVC }], [priceRow(1500, NOW + DAY)]]);
    const r = await sweepDueServicePrices(NOW);
    expect(r).toMatchObject({ checked: 1, applied: 0, skipped: 1, failed: 0 });
    expect(state.changes).toHaveLength(0);
  });

  it('останов без старта не падает', () => {
    expect(() => stopServicePriceSweepJob()).not.toThrow();
  });
});
