import { describe, expect, it } from 'vitest';

import {
  applyEngineListTemplatePayload,
  buildEngineListTemplatePayload,
  isTemplateExcludedFacet,
} from './engineListFilterTemplates.js';
import type { EngineFacetSelection } from './engineListFacets.js';

// Шаблон фильтров списка двигателей (промт КАРМАНА #181, пункты 5–8).
//
// Шаблон хранит параметры фильтра: значения ступеней, перечень включённых ступеней и
// перечень отключённых фильтров. Выбор ЗАКАЗЧИКА и ДОГОВОРА — это данные из базы, а не
// параметры фильтра: по шаблону список должен открываться по всем заказчикам и договорам.

const KNOWN = ['customer', 'contract', 'brand', 'repairStage', 'hasStage', 'scrap'];

describe('шаблон фильтров списка двигателей', () => {
  it('значения ступеней сохраняются, включённые ступени — перечисляются', () => {
    const selection: EngineFacetSelection = {
      repairStage: ['repair:ukladka'],
      brand: ['БМЗ'],
      scrap: ['no'],
    };
    const payload = buildEngineListTemplatePayload(selection, KNOWN);
    expect(payload.filters).toEqual({ repairStage: ['repair:ukladka'], brand: ['БМЗ'], scrap: ['no'] });
    expect(payload.enabled).toEqual(['repairStage', 'brand', 'scrap']);
    // Отключённые фильтры — ступени, в шаблон не вошедшие.
    expect(payload.disabled).toEqual(['customer', 'contract', 'hasStage']);
  });

  it('выбранный заказчик и договор в шаблон НЕ попадают (владелец)', () => {
    const selection: EngineFacetSelection = {
      customer: ['c-1'],
      contract: ['k-1'],
      brand: ['БМЗ'],
    };
    const payload = buildEngineListTemplatePayload(selection, KNOWN);
    expect(Object.keys(payload.filters)).not.toContain('customer');
    expect(Object.keys(payload.filters)).not.toContain('contract');
    expect(payload.filters.customer).toBeUndefined();
    expect(payload.filters.contract).toBeUndefined();
    expect(isTemplateExcludedFacet('customer')).toBe(true);
    expect(isTemplateExcludedFacet('contract')).toBe(true);
    expect(isTemplateExcludedFacet('brand')).toBe(false);
  });

  it('применение шаблона даёт те же значения, а заказчик и договор пусты', () => {
    const payload = buildEngineListTemplatePayload({ repairStage: ['repair:ukladka'], customer: ['c-1'] }, KNOWN);
    const applied = applyEngineListTemplatePayload(payload);
    expect(applied.repairStage).toEqual(['repair:ukladka']);
    expect(applied.customer).toBeUndefined();
    expect(applied.contract).toBeUndefined();
  });

  it('применение шаблона не оставляет чужих ступеней отбора', () => {
    // В шаблоне «Заказчик» нет — значит после применения его быть не должно, даже если
    // до применения в списке стоял другой заказчик.
    const payload = buildEngineListTemplatePayload({ brand: ['БМЗ'] }, KNOWN);
    const applied = applyEngineListTemplatePayload(payload);
    expect(Object.keys(applied)).toEqual(['brand']);
  });

  it('пустые значения в шаблон не попадают', () => {
    const payload = buildEngineListTemplatePayload({ brand: [], scrap: ['no'] }, KNOWN);
    expect(Object.keys(payload.filters)).toEqual(['scrap']);
  });
});
