import { describe, expect, it } from 'vitest';

import { attributeDefs, attributeValues, entities, entityTypes } from '../../../database/schema.js';
import { renderEngineFlowPrintHtml } from '../render.js';
import { buildEngineFlowByCounterpartyReport } from './engineFlowByCounterparty.js';

// Синтетический снапшот: loadSnapshot — единственное обращение билдера к БД.
// Два заказчика; у CP1 два договора, второй с ДС; в C1 две марки; двигатели всех состояний.
//   C1/BR1: E1 на заводе (в ремонте), E2 отгружен, E3 утиль на заводе, E4 утиль отправлен
//   C1/BR2: E5 на заводе
//   C2 (ДС 2)/BR1: E6 отгружен — заказчик у двигателя не проставлен, берётся с договора
//   C3 (CP2)/BR2: E7 на заводе
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
  { id: 'BR2', typeId: 'T_BRAND' },
  { id: 'CP1', typeId: 'T_CP' },
  { id: 'CP2', typeId: 'T_CP' },
  { id: 'C1', typeId: 'T_CONTRACT' },
  { id: 'C2', typeId: 'T_CONTRACT' },
  { id: 'C3', typeId: 'T_CONTRACT' },
  ...['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'].map((id) => ({ id, typeId: 'T_ENGINE' })),
];

const attrCodes = [
  'name',
  'engine_number',
  'engine_brand_id',
  'contract_id',
  'contract_section_number',
  'counterparty_id',
  'arrival_date',
  'contract_sections',
  'status_repair_started',
  'status_repaired',
  'status_customer_sent',
  'status_scrap_confirmed',
  'status_rework_sent',
];
const defRows: Row[] = attrCodes.map((code) => ({ id: code, code }));

const contractSections = (number: string, customerId: string) => ({
  primary: { number, internalNumber: '', customerId, signedAt: ARRIVAL, dueAt: null, engineBrands: [], parts: [] },
  addons: [],
});

const attrData: Record<string, Record<string, unknown>> = {
  BR1: { name: 'Д-245' },
  BR2: { name: 'ЯМЗ-238' },
  CP1: { name: 'АО «Первый заказчик»' },
  CP2: { name: 'ООО «Второй заказчик»' },
  C1: { contract_sections: contractSections('125/2026', 'CP1') },
  C2: { contract_sections: contractSections('РМЗ-2026-0158', 'CP1') },
  C3: { contract_sections: contractSections('7/2026', 'CP2') },
  E1: { engine_brand_id: 'BR1', contract_id: 'C1', counterparty_id: 'CP1', arrival_date: ARRIVAL, status_repair_started: true },
  E2: { engine_brand_id: 'BR1', contract_id: 'C1', counterparty_id: 'CP1', arrival_date: ARRIVAL, status_customer_sent: true },
  E3: { engine_brand_id: 'BR1', contract_id: 'C1', counterparty_id: 'CP1', arrival_date: ARRIVAL, status_scrap_confirmed: true },
  E4: { engine_brand_id: 'BR1', contract_id: 'C1', counterparty_id: 'CP1', arrival_date: ARRIVAL, status_rework_sent: true },
  E5: { engine_brand_id: 'BR2', contract_id: 'C1', counterparty_id: 'CP1', arrival_date: ARRIVAL },
  // Заказчик у двигателя не заполнен — должен подтянуться с договора C2.
  E6: { engine_brand_id: 'BR1', contract_id: 'C2', contract_section_number: 'ДС 2', arrival_date: ARRIVAL, status_customer_sent: true },
  E7: { engine_brand_id: 'BR2', contract_id: 'C3', counterparty_id: 'CP2', arrival_date: ARRIVAL },
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

function findRow(rows: Array<Record<string, unknown>>, contractShortLabel: string, engineBrand: string) {
  return rows.find((r) => r.contractShortLabel === contractShortLabel && r.engineBrand === engineBrand);
}

describe('buildEngineFlowByCounterpartyReport', () => {
  it('строка на марку внутри договора: пришло/отгружено/утиль/на заводе', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {});
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    // C1/BR1: E1 (в ремонте), E2 (отгружен), E3 (утиль на заводе), E4 (утиль отправлен)
    const c1br1 = findRow(report.rows, '№ 125', 'Д-245');
    expect(c1br1).toBeDefined();
    expect(c1br1?.arrivedQty).toBe(4);
    expect(c1br1?.shippedQty).toBe(1);
    expect(c1br1?.scrapTotalQty).toBe(2);
    expect(c1br1?.scrapAtFactoryQty).toBe(1);
    expect(c1br1?.scrapSentQty).toBe(1);
    expect(c1br1?.atFactoryQty).toBe(2); // E1 + E3
    expect(c1br1?.inRepairQty).toBe(1); // E1 (E3 — утиль на заводе)

    const c1br2 = findRow(report.rows, '№ 125', 'ЯМЗ-238');
    expect(c1br2?.arrivedQty).toBe(1);
    expect(c1br2?.atFactoryQty).toBe(1);
    expect(c1br2?.scrapTotalQty).toBe(0);
  });

  it('инвариант «пришло = отгружено + утиль отправлен + на заводе» на каждой строке и в итогах', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {});
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    for (const row of report.rows) {
      expect(Number(row.arrivedQty)).toBe(Number(row.shippedQty) + Number(row.scrapSentQty) + Number(row.atFactoryQty));
      expect(Number(row.atFactoryQty)).toBe(Number(row.scrapAtFactoryQty) + Number(row.inRepairQty));
    }
    expect(report.totals?.arrivedQty).toBe(7);
    expect(report.totals?.shippedQty).toBe(2); // E2, E6
    expect(report.totals?.scrapQty).toBe(2); // E3, E4
    expect(report.totals?.atFactoryQty).toBe(4); // E1, E3, E5, E7
    expect(report.totals?.counterparties).toBe(2);
    expect(report.totals?.contracts).toBe(3);
  });

  it('короткая метка договора: год отбрасывается, ДС добавляется суффиксом', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {});
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const labels = report.rows.map((r) => r.contractShortLabel);
    expect(labels).toContain('№ 125'); // «125/2026» → год отброшен
    expect(labels).toContain('№ 158 / ДС 2'); // «РМЗ-2026-0158» → хвост 3 цифры + ДС
    expect(labels).toContain('№ 7'); // «7/2026»
  });

  it('заказчик подтягивается с договора, если у двигателя поле пустое', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {});
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const e6Row = findRow(report.rows, '№ 158 / ДС 2', 'Д-245');
    expect(e6Row?.counterpartyLabel).toBe('АО «Первый заказчик»');
    expect(report.rows.some((r) => r.counterpartyLabel === '(без заказчика)')).toBe(false);
  });

  it('фильтр по заказчику оставляет только его договоры', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), { counterpartyIds: ['CP2'] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.counterpartyLabel).toBe('ООО «Второй заказчик»');
    expect(report.totals?.arrivedQty).toBe(1);
  });

  it('фильтр по марке оставляет только её строки', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), { brandIds: ['BR2'] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows.every((r) => r.engineBrand === 'ЯМЗ-238')).toBe(true);
    expect(report.totals?.arrivedQty).toBe(2); // E5, E7
  });
});

describe('renderEngineFlowPrintHtml', () => {
  it('печатная форма: A4-разметка, блоки заказчиков, подытоги договора и общий итог', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {});
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const html = renderEngineFlowPrintHtml(report);

    expect(html).toContain('@page{size:A4 portrait');
    expect(html).toContain('АО «Первый заказчик»');
    expect(html).toContain('ООО «Второй заказчик»');
    expect(html).toContain('Итого по заказчику');
    expect(html).toContain('Итого по всем заказчикам');
    // В C1 две марки → есть подытог договора; полный номер печатается рядом с короткой меткой.
    expect(html).toContain('Итого по договору');
    expect(html).toContain('125/2026');
    // Служебные ключи группировки в бумагу не попадают.
    expect(html).not.toContain('_counterpartyKey');
  });

  it('пустая выборка печатается заглушкой, а не пустой таблицей', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), { counterpartyIds: ['NOPE'] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(0);
    expect(renderEngineFlowPrintHtml(report)).toContain('Нет данных');
  });
});
