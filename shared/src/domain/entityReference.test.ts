import { describe, expect, it } from 'vitest';

import {
  collectContractEntityReferences,
  collectSupplyRequestEntityReferences,
  collectWorkOrderEntityReferences,
  collectWorkOrderUnresolvedTextIssues,
} from './entityReference.js';

describe('work-order entity references', () => {
  it('returns paths and expected entity types', () => {
    const references = collectWorkOrderEntityReferences({
      assemblyEngineId: 'engine-1',
      crew: [{ employeeId: 'employee-1' }],
      freeWorks: [{ serviceId: 'service-1', partId: 'part-1', engineId: 'engine-1' }],
    });
    expect(references).toContainEqual({ path: 'assemblyEngineId', expectedType: 'engine', referenceId: 'engine-1' });
    expect(references).toContainEqual({ path: 'freeWorks[0].serviceId', expectedType: 'service', referenceId: 'service-1' });
  });

  it('rejects a new free service snapshot but tolerates an unchanged legacy snapshot', () => {
    const payload = { version: 4, freeWorks: [{ serviceId: null, serviceName: 'Расточка' }] };
    expect(collectWorkOrderUnresolvedTextIssues(payload)).toHaveLength(1);
    expect(collectWorkOrderUnresolvedTextIssues(payload, payload)).toHaveLength(0);
  });
});

describe('contract entity references', () => {
  it('collects customer, engine brand and part references from primary and addons', () => {
    const refs = collectContractEntityReferences({
      primary: {
        customerId: 'cust-1',
        engineBrands: [{ engineBrandId: 'brand-1' }, { engineBrandId: '' }],
        parts: [{ partId: 'part-1' }],
      },
      addons: [{ engineBrands: [{ engineBrandId: 'brand-2' }], parts: [{ partId: 'part-2' }] }],
    });
    expect(refs).toContainEqual({ path: 'primary.customerId', expectedType: 'customer', referenceId: 'cust-1' });
    expect(refs).toContainEqual({ path: 'primary.engineBrands[0].engineBrandId', expectedType: 'engine_brand', referenceId: 'brand-1' });
    expect(refs).toContainEqual({ path: 'primary.parts[0].partId', expectedType: 'part', referenceId: 'part-1' });
    expect(refs).toContainEqual({ path: 'addons[0].engineBrands[0].engineBrandId', expectedType: 'engine_brand', referenceId: 'brand-2' });
    expect(refs).toContainEqual({ path: 'addons[0].parts[0].partId', expectedType: 'part', referenceId: 'part-2' });
    // Пустой engineBrandId не попадает в кандидаты.
    expect(refs.some((r) => r.referenceId === '')).toBe(false);
  });

  it('reverse index: a deleted brand id is found among a contract\'s references', () => {
    const refs = collectContractEntityReferences({
      primary: { engineBrands: [{ engineBrandId: 'dead-brand' }] },
      addons: [],
    });
    expect(refs.filter((r) => r.referenceId === 'dead-brand')).toHaveLength(1);
  });

  it('tolerates empty / missing sections', () => {
    expect(collectContractEntityReferences({})).toEqual([]);
    expect(collectContractEntityReferences({ primary: null, addons: [] })).toEqual([]);
  });
});

describe('supply-request entity references', () => {
  it('collects org units and item products', () => {
    const refs = collectSupplyRequestEntityReferences({
      departmentId: 'dep-1',
      workshopId: 'ws-1',
      sectionId: null,
      items: [{ productId: 'prod-1' }, { productId: '' }],
    });
    expect(refs).toContainEqual({ path: 'departmentId', expectedType: 'department', referenceId: 'dep-1' });
    expect(refs).toContainEqual({ path: 'workshopId', expectedType: 'workshop', referenceId: 'ws-1' });
    expect(refs).toContainEqual({ path: 'items[0].productId', expectedType: 'nomenclature', referenceId: 'prod-1' });
    expect(refs.some((r) => r.referenceId === '')).toBe(false);
  });
});
