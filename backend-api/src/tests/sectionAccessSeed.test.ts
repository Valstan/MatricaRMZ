import { describe, expect, it } from 'vitest';

import { parseSectionMembership } from '@matricarmz/shared';
import { sectionAccessSeedValue } from '../services/employeeAuthService.js';

// Seeding decision for section_access on role assignment (review finding on
// PR #707: assigning a role wrote only system_role, leaving the Ф3 section
// gate fail-open for the new account).

describe('sectionAccessSeedValue', () => {
  it('seeds the role template when no membership exists', () => {
    const value = sectionAccessSeedValue(null, 'storekeeper');
    expect(value).not.toBeNull();
    expect(parseSectionMembership(value)).toMatchObject({ warehouse: 'editor', supply: 'editor', production: 'viewer' });
  });

  it('never overwrites a configured matrix (role change keeps hand-tuned sections)', () => {
    const existing = JSON.stringify({ contracts: 'viewer' });
    expect(sectionAccessSeedValue(existing, 'storekeeper')).toBeNull();
  });

  it('treats a stored empty membership as missing', () => {
    expect(sectionAccessSeedValue('{}', 'viewer')).not.toBeNull();
    expect(sectionAccessSeedValue(JSON.stringify(JSON.stringify({})), 'viewer')).not.toBeNull();
  });

  it('writes nothing for roles whose seed is empty (pending/employee/unknown)', () => {
    expect(sectionAccessSeedValue(null, 'pending')).toBeNull();
    expect(sectionAccessSeedValue(null, 'employee')).toBeNull();
    expect(sectionAccessSeedValue(null, 'nonsense')).toBeNull();
  });

  it('tolerates the double-encoded prod storage format', () => {
    const doubleEncoded = JSON.stringify(JSON.stringify({ production: 'viewer' }));
    expect(sectionAccessSeedValue(doubleEncoded, 'viewer')).toBeNull();
  });
});
