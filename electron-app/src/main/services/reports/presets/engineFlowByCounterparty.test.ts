import { renderEngineFlowPrintHtml } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { attributeDefs, attributeValues, entities, entityTypes } from '../../../database/schema.js';
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
    const c1br1 = findRow(report.rows, '*125', 'Д-245');
    expect(c1br1).toBeDefined();
    expect(c1br1?.arrivedQty).toBe(4);
    expect(c1br1?.shippedQty).toBe(1);
    expect(c1br1?.scrapTotalQty).toBe(2);
    expect(c1br1?.scrapAtFactoryQty).toBe(1);
    expect(c1br1?.scrapSentQty).toBe(1);
    expect(c1br1?.atFactoryQty).toBe(2); // E1 + E3
    expect(c1br1?.inRepairQty).toBe(1); // E1 (E3 — утиль на заводе)

    const c1br2 = findRow(report.rows, '*125', 'ЯМЗ-238');
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

  it('короткий номер договора: «*» + три последние цифры части до первого «/», ДС суффиксом', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {});
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const labels = report.rows.map((r) => r.contractShortLabel);
    expect(labels).toContain('*125'); // «125/2026» → цифры части до слеша
    expect(labels).toContain('*158 / ДС 2'); // «РМЗ-2026-0158» → слеша нет, берутся три последние цифры + ДС
    expect(labels).toContain('*7'); // «7/2026» → цифр меньше трёх — берём сколько есть
  });

  it('заказчик подтягивается с договора, если у двигателя поле пустое', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {});
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const e6Row = findRow(report.rows, '*158 / ДС 2', 'Д-245');
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

// Реальные ГОЗ-номера: хвосты («/739-1/55/…», «/ГОЗ-25») у договоров года общие, различает их
// только ИГК в начале — оттуда и берутся три цифры короткого номера.
describe('короткий номер на ГОЗ-номерах', () => {
  const gozTypeRows: Row[] = [
    { id: 'T_ENGINE', code: 'engine' },
    { id: 'T_CONTRACT', code: 'contract' },
    { id: 'T_CP', code: 'counterparty' },
  ];
  const gozContracts: Record<string, string> = {
    G1: '2425187912371412245237126/10/ГОЗ-25',
    G2: '2224187314431432245222903/739-1/55/13906/9012/2325',
    G3: '2325187913551442245231239/739-1/55/13983/8947/2325',
  };
  const gozEntityRows: Row[] = [
    { id: 'CP1', typeId: 'T_CP' },
    ...Object.keys(gozContracts).map((id) => ({ id, typeId: 'T_CONTRACT' })),
    ...Object.keys(gozContracts).map((id) => ({ id: `E_${id}`, typeId: 'T_ENGINE' })),
  ];
  const gozAttrs: Record<string, Record<string, unknown>> = {
    CP1: { name: 'ООО «ОВК»' },
    ...Object.fromEntries(Object.entries(gozContracts).map(([id, number]) => [id, { contract_sections: contractSections(number, 'CP1') }])),
    ...Object.fromEntries(Object.keys(gozContracts).map((id) => [`E_${id}`, { contract_id: id, arrival_date: ARRIVAL }])),
  };
  const gozValueRows: Row[] = [];
  for (const [entityId, attrs] of Object.entries(gozAttrs)) {
    for (const [code, value] of Object.entries(attrs)) {
      gozValueRows.push({ entityId, attributeDefId: code, valueJson: JSON.stringify(value) });
    }
  }
  const gozDb = (): any => ({
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === entityTypes
            ? gozTypeRows
            : table === entities
              ? gozEntityRows
              : table === attributeDefs
                ? defRows
                : table === attributeValues
                  ? gozValueRows
                  : [];
        const chain: any = { where: () => chain, limit: () => Promise.resolve(rows) };
        return chain;
      },
    }),
  });

  it('берёт три последние цифры ИГК — метки договоров одного заказчика не сливаются', async () => {
    const report = await buildEngineFlowByCounterpartyReport(gozDb(), {});
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const labels = report.rows.map((r) => String(r.contractShortLabel));
    expect(labels).toContain('*126');
    expect(labels).toContain('*903');
    expect(labels).toContain('*239');
    expect(new Set(labels).size).toBe(labels.length);
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
    expect(html).toContain('Итого по всем годам');
    expect(html).toContain('2026 год');
    expect(html).toContain('Итого за 2026 год');
    expect(html).toContain('Свод по маркам · 2026 год');
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

  it('единственная таблица года не дублируется сводами по маркам', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), { counterpartyIds: ['CP2'] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const html = renderEngineFlowPrintHtml(report);

    expect(report.rows).toHaveLength(1);
    expect(html).not.toContain('Свод по маркам · 2026 год');
    expect(html).not.toContain('Свод по маркам · все годы');
    expect(html).toContain('Итого за 2026 год');
    expect(html).toContain('Итого по всем годам');
  });

  it('шрифты из настроек печати попадают в бумагу, скрытая колонка — нет', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {
      printLayout: { basePx: 16, headerPx: 11, hidden: ['contractFullLabel', 'inRepairQty'], fontPx: { engineBrand: 18 } },
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const html = renderEngineFlowPrintHtml(report);

    expect(html).toContain('font-size:16px');
    expect(html).toContain('.ef td.col-engineBrand,.ef .col-engineBrand{font-size:18px}');
    // Кегль без явного переопределения не пишется отдельным правилом — иначе он перебил бы
    // увеличенные заголовки года и заказчика.
    expect(html).not.toContain('.col-arrivedQty{font-size');
    expect(html).not.toContain('из них<br/>в ремонте');
    expect(html).not.toContain('125/2026'); // полный номер исключён оператором
  });

  it('своды и подытоги гасятся чекбоксами фильтров', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {
      showBrandSummary: false,
      showContractSubtotals: false,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const html = renderEngineFlowPrintHtml(report);
    expect(html).not.toContain('Свод по маркам');
    expect(html).not.toContain('Итого по договору');
    expect(html).toContain('Итого за 2026 год');
  });
});

// Двигатели двух лет прихода + один без даты: блоки по годам, их порядок и итоги.
describe('разбивка по годам', () => {
  const Y2024 = Date.UTC(2024, 4, 5);
  const Y2025 = Date.UTC(2025, 6, 20);
  const yearTypeRows: Row[] = [
    { id: 'T_ENGINE', code: 'engine' },
    { id: 'T_CONTRACT', code: 'contract' },
    { id: 'T_BRAND', code: 'engine_brand' },
    { id: 'T_CP', code: 'counterparty' },
  ];
  const yearEntityRows: Row[] = [
    { id: 'BR1', typeId: 'T_BRAND' },
    { id: 'CP1', typeId: 'T_CP' },
    { id: 'C1', typeId: 'T_CONTRACT' },
    ...['A1', 'A2', 'B1', 'N1'].map((id) => ({ id, typeId: 'T_ENGINE' })),
  ];
  const yearAttrs: Record<string, Record<string, unknown>> = {
    BR1: { name: 'Д-245' },
    CP1: { name: 'АО «Первый заказчик»' },
    C1: { contract_sections: contractSections('125/2026', 'CP1') },
    A1: { engine_brand_id: 'BR1', contract_id: 'C1', counterparty_id: 'CP1', arrival_date: Y2024, engine_number: '1001' },
    A2: {
      engine_brand_id: 'BR1',
      contract_id: 'C1',
      counterparty_id: 'CP1',
      arrival_date: Y2024,
      engine_number: '1002',
      status_customer_sent: true,
    },
    B1: { engine_brand_id: 'BR1', contract_id: 'C1', counterparty_id: 'CP1', arrival_date: Y2025, engine_number: '2001' },
    N1: { engine_brand_id: 'BR1', contract_id: 'C1', counterparty_id: 'CP1', engine_number: '3001' },
  };
  const yearValueRows: Row[] = [];
  for (const [entityId, attrs] of Object.entries(yearAttrs)) {
    for (const [code, value] of Object.entries(attrs)) {
      yearValueRows.push({ entityId, attributeDefId: code, valueJson: JSON.stringify(value) });
    }
  }
  const yearsDb = (): any => ({
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === entityTypes
            ? yearTypeRows
            : table === entities
              ? yearEntityRows
              : table === attributeDefs
                ? defRows
                : table === attributeValues
                  ? yearValueRows
                  : [];
        const chain: any = { where: () => chain, limit: () => Promise.resolve(rows) };
        return chain;
      },
    }),
  });

  it('строки размечены годом прихода, «без даты» уходит в конец при любом порядке', async () => {
    const desc = await buildEngineFlowByCounterpartyReport(yearsDb(), {});
    expect(desc.ok).toBe(true);
    if (!desc.ok) return;
    expect(desc.rows.map((r) => r.yearLabel)).toEqual(['2025 год', '2024 год', 'Без даты прихода']);
    expect(desc.totals?.years).toBe(3);
    expect(desc.totals?.arrivedQty).toBe(4);
    // Один договор, приходивший в разные годы, остаётся одним договором в шапке.
    expect(desc.totals?.contracts).toBe(1);

    const asc = await buildEngineFlowByCounterpartyReport(yearsDb(), { yearOrder: 'asc' });
    expect(asc.ok).toBe(true);
    if (!asc.ok) return;
    expect(asc.rows.map((r) => r.yearLabel)).toEqual(['2024 год', '2025 год', 'Без даты прихода']);
  });

  it('итоги считаются по каждому году и общий по всем годам', async () => {
    const report = await buildEngineFlowByCounterpartyReport(yearsDb(), {});
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const y2024 = report.rows.find((r) => r.yearLabel === '2024 год');
    expect(y2024?.arrivedQty).toBe(2);
    expect(y2024?.shippedQty).toBe(1);
    const html = renderEngineFlowPrintHtml(report);
    expect(html).toContain('Итого за 2024 год');
    expect(html).toContain('Итого за 2025 год');
    expect(html).toContain('Итого за Без даты прихода');
    expect(html).toContain('Свод по маркам · все годы');
    expect(html.indexOf('Свод по маркам · все годы')).toBeLessThan(html.indexOf('Итого по всем годам'));
  });

  it('фильтр по дате прихода оставляет только свой год', async () => {
    const report = await buildEngineFlowByCounterpartyReport(yearsDb(), {
      arrivalStartMs: Date.UTC(2025, 0, 1),
      arrivalEndMs: Date.UTC(2025, 11, 31),
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows.map((r) => r.yearLabel)).toEqual(['2025 год']);
    expect(report.totals?.arrivedQty).toBe(1);
  });

  it('фильтры по состоянию и номеру двигателя сужают выборку', async () => {
    const onSite = await buildEngineFlowByCounterpartyReport(yearsDb(), { onSiteFilter: 'no' });
    expect(onSite.ok).toBe(true);
    if (!onSite.ok) return;
    expect(onSite.totals?.arrivedQty).toBe(1); // только A2 (отгружен)

    const byNumber = await buildEngineFlowByCounterpartyReport(yearsDb(), { engineNumberQuery: '200' });
    expect(byNumber.ok).toBe(true);
    if (!byNumber.ok) return;
    expect(byNumber.totals?.arrivedQty).toBe(1); // B1
    expect(byNumber.rows.map((r) => r.yearLabel)).toEqual(['2025 год']);
  });
});

describe('настройки печати в результате отчёта', () => {
  it('скрытая колонка исчезает из columns, но данные строк не трогаются', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {
      printLayout: { basePx: 14, headerPx: 12, hidden: ['contractFullLabel'], fontPx: {} },
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.columns.some((c) => c.key === 'contractFullLabel')).toBe(false);
    expect(report.rows[0]?.contractFullLabel).toBeDefined();
    expect(report.printLayout?.basePx).toBe(14);
  });

  it('колонки-опоры иерархии исключить нельзя', async () => {
    const report = await buildEngineFlowByCounterpartyReport(stubDb(), {
      printLayout: { basePx: 14, headerPx: 12, hidden: ['engineBrand', 'yearLabel', 'scrapSentQty'], fontPx: {} },
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.columns.some((c) => c.key === 'engineBrand')).toBe(true);
    expect(report.columns.some((c) => c.key === 'yearLabel')).toBe(true);
    expect(report.columns.some((c) => c.key === 'scrapSentQty')).toBe(false);
  });
});
