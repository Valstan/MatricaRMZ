import { describe, expect, it } from 'vitest';

import { canActByPosition, canSignAsDepartmentHead } from './signatureAccess.js';

describe('signatureAccess', () => {
  it('allows director to approve', () => {
    expect(canActByPosition('director_approve', 'Исполняющий директор завода', 'user')).toBe(true);
  });

  it('allows department head to sign', () => {
    expect(canActByPosition('sign', 'Начальник цеха', 'user')).toBe(true);
  });

  it('denies sign for non-head position', () => {
    expect(canActByPosition('sign', 'Инженер', 'user')).toBe(false);
  });

  it('allows superadmin for any action', () => {
    expect(canActByPosition('director_approve', '', 'superadmin')).toBe(true);
    expect(canActByPosition('fulfill_partial', '', 'superadmin')).toBe(true);
  });

  it('restricts sign action to own department', () => {
    expect(canSignAsDepartmentHead('sign', 'dep-a', 'dep-a')).toBe(true);
    expect(canSignAsDepartmentHead('sign', 'dep-a', 'dep-b')).toBe(false);
    expect(canSignAsDepartmentHead('sign', 'dep-a', null)).toBe(false);
  });

  it('does not require department match for non-sign actions', () => {
    expect(canSignAsDepartmentHead('accept', 'dep-a', 'dep-b')).toBe(true);
    expect(canSignAsDepartmentHead('director_approve', null, null)).toBe(true);
  });
});

