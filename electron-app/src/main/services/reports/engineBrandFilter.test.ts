import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));

import { attributeDefs, attributeValues, entities, entityTypes, operations } from '../../database/schema.js';

import { buildBrandFilterMatcher, resolveEngineBrandRef } from './context.js';
import { buildEnginesReport, buildEngineStagesReport } from './presets/engines.js';
import { buildPartsDemandReport } from './presets/warehouse.js';

// Марка двигателя записана двумя способами: ссылкой `engine_brand_id` и текстом `engine_brand`.
// Фильтр отдаёт идентификаторы, поэтому карточка с одним текстом выпадала молча, а «Потребность
// в деталях» и вовсе клала оба значения в одну ячейку — побеждало то, что встретится в EAV
// последним, то есть исход зависел от порядка строк.
const T0 = Date.UTC(2026, 0, 10);

type Row = Record<string, unknown>;

const typeRows: Row[] = [
  { id: 'T_ENGINE', code: 'engine' },
  { id: 'T_BRAND', code: 'engine_brand' },
  { id: 'T_CONTRACT', code: 'contract' },
];

const entityRows: Row[] = [
  { id: 'BR1', typeId: 'T_BRAND' },
  { id: 'C1', typeId: 'T_CONTRACT' },
  { id: 'E_REF', typeId: 'T_ENGINE' },
  { id: 'E_TEXT', typeId: 'T_ENGINE' },
];

const defRows: Row[] = ['name', 'engine_number', 'engine_brand_id', 'engine_brand', 'contract_id', 'arrival_date'].map(
  (code) => ({ id: code, code }),
);

// Порядок строк — тот самый, который прежде решал исход: текст записан ПОСЛЕ ссылки.
const valueRows: Row[] = [
  { entityId: 'BR1', attributeDefId: 'name', valueJson: JSON.stringify('Д-245') },
  { entityId: 'C1', attributeDefId: 'name', valueJson: JSON.stringify('125/2026') },

  { entityId: 'E_REF', attributeDefId: 'engine_number', valueJson: JSON.stringify('REF') },
  { entityId: 'E_REF', attributeDefId: 'contract_id', valueJson: JSON.stringify('C1') },
  { entityId: 'E_REF', attributeDefId: 'arrival_date', valueJson: JSON.stringify(T0) },
  { entityId: 'E_REF', attributeDefId: 'engine_brand_id', valueJson: JSON.stringify('BR1') },
  { entityId: 'E_REF', attributeDefId: 'engine_brand', valueJson: JSON.stringify('Д-245') },

  // Карточка старого образца: марка только текстом, ссылки нет.
  { entityId: 'E_TEXT', attributeDefId: 'engine_number', valueJson: JSON.stringify('TEXT') },
  { entityId: 'E_TEXT', attributeDefId: 'contract_id', valueJson: JSON.stringify('C1') },
  { entityId: 'E_TEXT', attributeDefId: 'arrival_date', valueJson: JSON.stringify(T0) },
  { entityId: 'E_TEXT', attributeDefId: 'engine_brand', valueJson: JSON.stringify('Д-245') },
];

const defectOp: Row = {
  id: 'op1',
  operationType: 'defect',
  engineEntityId: 'E_REF',
  performedAt: T0,
  createdAt: T0,
  performedBy: 'ivanov',
  metaJson: JSON.stringify({
    kind: 'repair_checklist',
    answers: { defect_items: { kind: 'table', rows: [{ part_name: 'Поршень', part_number: 'П-1', scrap_qty: 2 }] } },
  }),
};

const defectOpTextBrand: Row = { ...defectOp, id: 'op2', engineEntityId: 'E_TEXT' };

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
                    : table === operations
                      ? [defectOp, defectOpTextBrand]
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

describe('buildBrandFilterMatcher', () => {
  const labels = new Map([['BR1', 'Д-245']]);

  it('пустой фильтр пропускает всё, включая карточку без марки вовсе', () => {
    const matches = buildBrandFilterMatcher([], labels);
    expect(matches({ id: '', name: '' })).toBe(true);
  });

  it('находит и по ссылке, и по названию — регистр не важен', () => {
    const matches = buildBrandFilterMatcher(['BR1'], labels);
    expect(matches({ id: 'BR1', name: '' })).toBe(true);
    expect(matches({ id: '', name: 'Д-245' })).toBe(true);
    expect(matches({ id: '', name: 'д-245' })).toBe(true);
  });

  it('чужую марку не пропускает — контроль, что фильтр вообще фильтрует', () => {
    const matches = buildBrandFilterMatcher(['BR1'], labels);
    expect(matches({ id: 'BR2', name: 'ЯМЗ-238' })).toBe(false);
    expect(matches({ id: '', name: '' })).toBe(false);
  });

  it('resolveEngineBrandRef читает оба поля, не схлопывая их', () => {
    expect(resolveEngineBrandRef({ engine_brand_id: 'BR1', engine_brand: 'Д-245' })).toEqual({ id: 'BR1', name: 'Д-245' });
    expect(resolveEngineBrandRef({ engine_brand: 'Д-245' })).toEqual({ id: '', name: 'Д-245' });
    expect(resolveEngineBrandRef(undefined)).toEqual({ id: '', name: '' });
  });
});

describe('фильтр по марке достаёт карточки, где марка записана только текстом', () => {
  it('«Двигатели»: в отбор попадают обе карточки', async () => {
    const report = await buildEnginesReport(stubDb(), { groupBy: 'engines', periodBasis: 'none', brandIds: ['BR1'] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows.map((r) => String(r.engineNumber ?? '')).sort()).toEqual(['REF', 'TEXT']);
  });

  it('«Стадии двигателей»: та же пара', async () => {
    const report = await buildEngineStagesReport(stubDb(), { brandIds: ['BR1'] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows.map((r) => String(r.engineNumber ?? '')).sort()).toEqual(['REF', 'TEXT']);
  });

  it('«Потребность в деталях»: считает дефектовку обеих карточек, а не той, чья строка легла последней', async () => {
    const report = await buildPartsDemandReport(stubDb(), { brandIds: ['BR1'], startMs: T0 - 1, endMs: T0 + 1 });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const scrap = report.rows.reduce((sum, r) => sum + Number(r.scrapQty ?? 0), 0);
    expect(scrap).toBe(4); // по 2 с каждого двигателя
  });

  it('чужая марка не приносит ничего — контроль непустой', async () => {
    const report = await buildEnginesReport(stubDb(), { groupBy: 'engines', periodBasis: 'none', brandIds: ['BR_OTHER'] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(0);
  });
});
