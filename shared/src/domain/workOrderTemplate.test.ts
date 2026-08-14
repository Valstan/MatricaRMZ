import { describe, expect, it } from 'vitest';

import { isWorkOrderTemplateFieldVisible } from './workOrderTemplate.js';

describe('isWorkOrderTemplateFieldVisible', () => {
  it('treats a checked field as visible and a stored hidden field as unchecked', () => {
    const hiddenFields = new Set(['priceRub']);

    expect(isWorkOrderTemplateFieldVisible(hiddenFields, 'serviceName')).toBe(true);
    expect(isWorkOrderTemplateFieldVisible(hiddenFields, 'priceRub')).toBe(false);
  });
});
