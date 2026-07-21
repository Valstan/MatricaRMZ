import { describe, expect, it } from 'vitest';

import { attributeDefs, attributeValues, entities, entityTypes } from '../../../database/schema.js';
import { buildEnginesContractsOverviewReport } from './engines.js';

// Синтетический снапшот: loadSnapshot — единственное обращение билдера к БД, поэтому
// db стабится минимальным .select().from(table).where().limit() → фикстурные строки.
// Один контракт (план 8 двигателей), 5 заведённых двигателей в разных состояниях:
//   E1 — только пришёл (на заводе)
//   E2 — отремонтирован, не отгружен (на заводе, готов)
//   E3 — отправлен заказчику (покинул завод), TAT = 10 дн
//   E4 — признан утильным (ещё на заводе)
//   E5 — утиль отправлен заказчику (покинул завод как утиль)
const DAY = 24 * 60 * 60 * 1000;
const ARRIVAL = Date.UTC(2026, 0, 10);
const SHIP_E3 = ARRIVAL + 10 * DAY;

type Row = Record<string, unknown>;

const typeRows: Row[] = [
  { id: 'T_ENGINE', code: 'engine' },
  { id: 'T_CONTRACT', code: 'contract' },
  { id: 'T_BRAND', code: 'engine_brand' },
];

const entityRows: Row[] = [
  { id: 'BR1', typeId: 'T_BRAND' },
  { id: 'C1', typeId: 'T_CONTRACT' },
  { id: 'E1', typeId: 'T_ENGINE' },
  { id: 'E2', typeId: 'T_ENGINE' },
  { id: 'E3', typeId: 'T_ENGINE' },
  { id: 'E4', typeId: 'T_ENGINE' },
  { id: 'E5', typeId: 'T_ENGINE' },
];

const attrCodes = [
  'name',
  'engine_number',
  'engine_brand_id',
  'contract_id',
  'arrival_date',
  'contract_sections',
  'due_date',
  'status_repaired',
  'status_customer_sent',
  'status_customer_sent_date',
  'status_scrap_confirmed',
  'status_rework_sent',
];
const defRows: Row[] = attrCodes.map((code) => ({ id: code, code }));

// entityId → { code: value }
const attrData: Record<string, Record<string, unknown>> = {
  BR1: { name: 'Д-245' },
  C1: {
    contract_sections: {
      primary: {
        number: '100/2026',
        internalNumber: 'вн-1',
        customerId: null,
        signedAt: ARRIVAL,
        dueAt: null,
        engineBrands: [{ engineBrandId: 'BR1', qty: 8, unitPrice: 0 }],
        parts: [],
      },
      addons: [],
    },
    due_date: ARRIVAL + 5 * DAY,
  },
  E1: { engine_brand_id: 'BR1', contract_id: 'C1', arrival_date: ARRIVAL, engine_number: 'E1' },
  E2: { engine_brand_id: 'BR1', contract_id: 'C1', arrival_date: ARRIVAL, engine_number: 'E2', status_repaired: true },
  E3: {
    engine_brand_id: 'BR1',
    contract_id: 'C1',
    arrival_date: ARRIVAL,
    engine_number: 'E3',
    status_repaired: true,
    status_customer_sent: true,
    status_customer_sent_date: SHIP_E3,
  },
  E4: { engine_brand_id: 'BR1', contract_id: 'C1', arrival_date: ARRIVAL, engine_number: 'E4', status_scrap_confirmed: true },
  E5: { engine_brand_id: 'BR1', contract_id: 'C1', arrival_date: ARRIVAL, engine_number: 'E5', status_rework_sent: true },
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

function rowByKey(rows: Array<Record<string, unknown>>, key: string, value: unknown) {
  return rows.find((r) => r[key] === value);
}

describe('buildEnginesContractsOverviewReport', () => {
  it('разрез «По контрактам»: план/приехало/ожидается/на заводе/отгружено/утиль', async () => {
    const report = await buildEnginesContractsOverviewReport(stubDb(), { groupBy: 'contracts', periodBasis: 'none' });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.planQty).toBe(8);
    expect(row.arrivedQty).toBe(5);
    expect(row.awaitingQty).toBe(3); // 8 план − 5 приехало
    expect(row.atFactoryQty).toBe(3); // E1, E2, E4
    expect(row.readyNotShippedQty).toBe(1); // E2
    expect(row.shippedQty).toBe(2); // E3 (заказчику) + E5 (утиль-возврат)
    expect(row.scrapQty).toBe(2); // E4 (признан) + E5 (возврат)
    expect(row.progressPct).toBe(25); // 2 отгружено / 8 план
    expect(report.totals?.contracts).toBe(1);
    expect(report.totals?.arrivedQty).toBe(5);
    expect(report.totals?.onSiteQty).toBe(3);
    expect(report.totals?.shippedQty).toBe(2);
    expect(report.footerNotes?.length ?? 0).toBeGreaterThan(0);
  });

  it('разрез «По маркам»: агрегат по марке двигателя', async () => {
    const report = await buildEnginesContractsOverviewReport(stubDb(), { groupBy: 'brands', periodBasis: 'none' });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.arrivedQty).toBe(5);
    expect(row.atFactoryQty).toBe(3);
    expect(row.shippedQty).toBe(2);
    expect(row.scrapQty).toBe(2);
  });

  it('разрез «По двигателям»: строка на двигатель + состояние', async () => {
    const report = await buildEnginesContractsOverviewReport(stubDb(), { groupBy: 'engines', periodBasis: 'none' });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(5);
    expect(rowByKey(report.rows, 'engineNumber', 'E3')?.stateLabel).toBe('Отгружен');
    expect(rowByKey(report.rows, 'engineNumber', 'E2')?.stateLabel).toBe('Готов, не отгружен');
    expect(rowByKey(report.rows, 'engineNumber', 'E1')?.stateLabel).toBe('На заводе');
    expect(rowByKey(report.rows, 'engineNumber', 'E5')?.isScrap).toBe('Да');
    // TAT E3 = 10 дней (приход → отгрузка)
    expect(rowByKey(report.rows, 'engineNumber', 'E3')?.daysOnSite).toBe(10);
    // Итоги по флагам, не по подписи состояния: на заводе E1/E2/E4 (утиль E4 ещё на заводе), утиль E4/E5.
    expect(report.totals?.onSiteQty).toBe(3);
    expect(report.totals?.scrapQty).toBe(2);
  });

  it('фильтр «Скрыть утиль» убирает утильные двигатели', async () => {
    const report = await buildEnginesContractsOverviewReport(stubDb(), { groupBy: 'engines', periodBasis: 'none', hideScrap: true });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(3); // E1, E2, E3 (E4 и E5 — утиль)
  });

  it('фильтр состояния «Отгружены» оставляет только покинувшие завод', async () => {
    const report = await buildEnginesContractsOverviewReport(stubDb(), { groupBy: 'engines', periodBasis: 'none', engineState: 'shipped' });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(2); // E3, E5
  });
});
