import { describe, expect, it } from 'vitest';

import { collectWorkOrderEntityReferences, collectWorkOrderUnresolvedTextIssues } from './entityReference.js';

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
