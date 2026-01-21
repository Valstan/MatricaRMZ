import { describe, expect, it } from 'vitest';

import { PermissionCode, PERMISSION_CATALOG } from './permissions.js';

describe('permissions catalog', () => {
  it('contains unique codes', () => {
    const codes = PERMISSION_CATALOG.map((p) => p.code);
    const uniq = new Set(codes);
    expect(uniq.size).toBe(codes.length);
  });

  it('covers only known PermissionCode values', () => {
    const all = new Set(Object.values(PermissionCode));
    const unknown = PERMISSION_CATALOG.map((p) => p.code).filter((code) => !all.has(code));
    expect(unknown).toEqual([]);
  });
});
