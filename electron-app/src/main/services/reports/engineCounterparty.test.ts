import { describe, expect, it } from 'vitest';

import { attributeDefs, attributeValues, entities, entityTypes } from '../../database/schema.js';

import { buildContractCounterpartyIndex, loadSnapshot, resolveEngineCounterpartyId } from './context.js';
import { buildEnginesReport, buildEngineStagesReport } from './presets/engines.js';
import { buildEngineFlowByCounterpartyReport } from './presets/engineFlowByCounterparty.js';

// Решение владельца 07.09: заказчик двигателя ищется всеми доступными путями и читается
// во всех отчётах одинаково. До этого «Двигатели» брали только поле карточки, и двигатель
// с пустым полем при известном заказчике договора выпадал из отбора молча.
//
//   CP1 → C1 (заказчик в разделе договора): E1 (поле карточки заполнено), E2 (пустое)
//   CP2 → C2 (заказчик в легаси-атрибуте `customer_id`): E3 (пустое поле карточки)
//   E4 — без договора и без заказчика вовсе
const ARRIVAL = Date.UTC(2026, 0, 10);

type Row = Record<string, unknown>;

const typeRows: Row[] = [
  { id: 'T_ENGINE', code: 'engine' },
  { id: 'T_CONTRACT', code: 'contract' },
  { id: 'T_BRAND', code: 'engine_brand' },
  { id: 'T_CP', code: 'counterparty' },
];

const entityRows: Row[] = [
  { id: 'BR1', typeId: 'T_BRAND' },
  { id: 'CP1', typeId: 'T_CP' },
  { id: 'CP2', typeId: 'T_CP' },
  { id: 'C1', typeId: 'T_CONTRACT' },
  { id: 'C2', typeId: 'T_CONTRACT' },
  ...['E1', 'E2', 'E3', 'E4'].map((id) => ({ id, typeId: 'T_ENGINE' })),
];

const defRows: Row[] = [
  'name',
  'engine_number',
  'engine_brand_id',
  'contract_id',
  'counterparty_id',
  'customer_id',
  'contract_sections',
  'arrival_date',
].map((code) => ({ id: code, code }));

const attrData: Record<string, Record<string, unknown>> = {
  BR1: { name: 'Д-245' },
  CP1: { name: 'АО «Первый заказчик»' },
  CP2: { name: 'ООО «Второй заказчик»' },
  C1: {
    contract_sections: {
      primary: { number: '125/2026', internalNumber: '', customerId: 'CP1', signedAt: ARRIVAL, dueAt: null, engineBrands: [], parts: [] },
      addons: [],
    },
  },
  // Договор старого образца: заказчик только в легаси-атрибуте, разделов нет.
  C2: { customer_id: 'CP2' },
  E1: { engine_brand_id: 'BR1', contract_id: 'C1', counterparty_id: 'CP1', arrival_date: ARRIVAL, engine_number: 'E1' },
  E2: { engine_brand_id: 'BR1', contract_id: 'C1', arrival_date: ARRIVAL, engine_number: 'E2' },
  E3: { engine_brand_id: 'BR1', contract_id: 'C2', arrival_date: ARRIVAL, engine_number: 'E3' },
  E4: { engine_brand_id: 'BR1', arrival_date: ARRIVAL, engine_number: 'E4' },
};

const valueRows: Row[] = [];
for (const [entityId, attrs] of Object.entries(attrData)) {
  for (const [code, value] of Object.entries(attrs)) {
    valueRows.push({ entityId, attributeDefId: code, valueJson: JSON.stringify(value) });
  }
}

function stubDb(): any {
  return {
    select() {
      return {
        from(table: unknown) {
          const rows =
            table === entityTypes
              ? typeRows
              : table === entities
                ? entityRows
                : table === attributeDefs
                  ? defRows
                  : table === attributeValues
                    ? valueRows
                    : [];
          const chain: any = {
            where() {
              return chain;
            },
            limit() {
              return Promise.resolve(rows);
            },
          };
          return chain;
        },
      };
    },
  };
}

describe('resolveEngineCounterpartyId', () => {
  it('поле карточки главнее договора', async () => {
    const snapshot = await loadSnapshot(stubDb());
    const index = buildContractCounterpartyIndex(snapshot);
    expect(resolveEngineCounterpartyId({ counterparty_id: 'CP2', contract_id: 'C1' }, index)).toBe('CP2');
  });

  it('пустое поле дочитывается с договора — и через разделы, и через легаси-атрибут', async () => {
    const snapshot = await loadSnapshot(stubDb());
    const index = buildContractCounterpartyIndex(snapshot);
    expect(resolveEngineCounterpartyId({ contract_id: 'C1' }, index)).toBe('CP1');
    expect(resolveEngineCounterpartyId({ contract_id: 'C2' }, index)).toBe('CP2');
  });

  it('нет ни поля, ни договора — пусто, а не идентификатор договора', async () => {
    const snapshot = await loadSnapshot(stubDb());
    const index = buildContractCounterpartyIndex(snapshot);
    expect(resolveEngineCounterpartyId({}, index)).toBe('');
    expect(resolveEngineCounterpartyId({ contract_id: 'C_UNKNOWN' }, index)).toBe('');
    expect(resolveEngineCounterpartyId(undefined, index)).toBe('');
  });
});

describe('фильтр «Заказчики» одинаков во всех отчётах по двигателям', () => {
  it('«Двигатели»: выбор заказчика берёт и двигатель с пустым полем карточки', async () => {
    const report = await buildEnginesReport(stubDb(), {
      groupBy: 'engines',
      periodBasis: 'none',
      counterpartyIds: ['CP1'],
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const numbers = report.rows.map((r) => String(r.engineNumber ?? '')).sort();
    expect(numbers).toEqual(['E1', 'E2']);
  });

  it('«Двигатели»: заказчик из легаси-атрибута договора тоже находится', async () => {
    const report = await buildEnginesReport(stubDb(), {
      groupBy: 'engines',
      periodBasis: 'none',
      counterpartyIds: ['CP2'],
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows.map((r) => String(r.engineNumber ?? ''))).toEqual(['E3']);
  });

  it('«Движение по заказчикам» на тех же данных отбирает ровно то же', async () => {
    const flow = await buildEngineFlowByCounterpartyReport(stubDb(), { counterpartyIds: ['CP1'] });
    expect(flow.ok).toBe(true);
    if (!flow.ok) return;
    expect(flow.totals?.arrivedQty).toBe(2);
  });

  it('«Стадии двигателей» — та же трактовка, а не третья', async () => {
    const stages = await buildEngineStagesReport(stubDb(), { counterpartyIds: ['CP1'] });
    expect(stages.ok).toBe(true);
    if (!stages.ok) return;
    expect(stages.rows.map((r) => String(r.engineNumber ?? '')).sort()).toEqual(['E1', 'E2']);
  });

  it('двигатель без договора и без поля не приписывается никому', async () => {
    const all = await buildEnginesReport(stubDb(), { groupBy: 'engines', periodBasis: 'none' });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.rows.map((r) => String(r.engineNumber ?? '')).sort()).toEqual(['E1', 'E2', 'E3', 'E4']);

    const cp1 = await buildEnginesReport(stubDb(), { groupBy: 'engines', periodBasis: 'none', counterpartyIds: ['CP1'] });
    expect(cp1.ok).toBe(true);
    if (!cp1.ok) return;
    expect(cp1.rows.map((r) => String(r.engineNumber ?? ''))).not.toContain('E4');
  });
});
