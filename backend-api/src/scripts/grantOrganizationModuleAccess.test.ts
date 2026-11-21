import { describe, expect, it } from 'vitest';

import { planForLogin } from './grantOrganizationModuleAccess.js';

/**
 * Организационный отдел видят все, ведёт его хозяин; «Дети» и данные о детях — только
 * хозяин и суперадмин (владелец 21.11.2026).
 */
describe('planForLogin — доступ к организационному отделу и «Детям»', () => {
  const owners = new Set(['module-owner']);

  it('хозяин ведёт и организационный отдел, и «Дети»', () => {
    const plan = planForLogin('module-owner', owners);
    expect(plan.isOwner).toBe(true);
    expect(plan.sections.organization).toBe('editor');
    expect(plan.sections.children).toBe('editor');
    expect(plan.permissions['children.view']).toBe(true);
    expect(plan.permissions['children.edit']).toBe(true);
    expect(plan.permissions['organization.edit']).toBe(true);
  });

  it('остальные видят организационный отдел и не видят «Детей»', () => {
    const plan = planForLogin('ozerolove', owners);
    expect(plan.isOwner).toBe(false);
    expect(plan.sections.organization).toBe('viewer');
    expect(plan.sections.children).toBe(null);
    expect(plan.permissions['children.view']).toBe(false);
    expect(plan.permissions['children.edit']).toBe(false);
    expect(plan.permissions['organization.edit']).toBe(false);
  });

  it('логин сравнивается без учёта регистра и пробелов', () => {
    expect(planForLogin(' MODULE-OWNER ', owners).isOwner).toBe(true);
  });
});
