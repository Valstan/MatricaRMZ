import { describe, expect, it } from 'vitest';

import {
  ACCESS_SECTION_CATALOG,
  AccessSection,
  canEditSection,
  canViewSection,
  parseSectionMembership,
  sectionForLedgerWrite,
  sectionLevelFor,
  seedMembershipForRole,
  serializeSectionMembership,
} from './sectionAccess.js';

describe('parse/serialize membership', () => {
  it('round-trips and drops unknown sections/levels', () => {
    const raw = JSON.stringify({
      warehouse: 'editor',
      contracts: 'viewer',
      bogus_section: 'editor',
      production: 'owner',
    });
    const parsed = parseSectionMembership(raw);
    expect(parsed).toEqual({ warehouse: 'editor', contracts: 'viewer' });
    expect(parseSectionMembership(serializeSectionMembership(parsed))).toEqual(parsed);
  });

  it('tolerates garbage input', () => {
    expect(parseSectionMembership(undefined)).toEqual({});
    expect(parseSectionMembership('not json')).toEqual({});
    expect(parseSectionMembership('[1,2]')).toEqual({});
    expect(parseSectionMembership(42)).toEqual({});
  });
});

describe('level resolution', () => {
  it('not listed = no access at all', () => {
    const args = { membership: {}, role: 'engineer', sectionId: AccessSection.Contracts };
    expect(sectionLevelFor(args)).toBeNull();
    expect(canViewSection(args)).toBe(false);
    expect(canEditSection(args)).toBe(false);
  });

  it('viewer sees but does not edit; editor does both', () => {
    const membership = { contracts: 'viewer', warehouse: 'editor' } as const;
    expect(canViewSection({ membership, role: 'user', sectionId: AccessSection.Contracts })).toBe(true);
    expect(canEditSection({ membership, role: 'user', sectionId: AccessSection.Contracts })).toBe(false);
    expect(canEditSection({ membership, role: 'user', sectionId: AccessSection.Warehouse })).toBe(true);
  });

  it('superadmin bypasses membership everywhere', () => {
    for (const s of ACCESS_SECTION_CATALOG) {
      expect(canEditSection({ membership: {}, role: 'superadmin', sectionId: s.id })).toBe(true);
    }
  });

  it('admin does NOT bypass (matrix applies after seeding)', () => {
    expect(canViewSection({ membership: {}, role: 'admin', sectionId: AccessSection.Warehouse })).toBe(false);
  });
});

describe('seedMembershipForRole (day-one: mirrors current factual footprint)', () => {
  it('legacy user = editor in all regular sections, never restricted ones', () => {
    const m = seedMembershipForRole('user');
    expect(m.production).toBe('editor');
    expect(m.contracts).toBe('editor');
    expect(m.directories).toBe('editor');
    expect(m.restricted_work_orders).toBeUndefined();
    expect(m.administration).toBeUndefined();
  });

  it('admin additionally gets administration; restricted orders still not seeded', () => {
    const m = seedMembershipForRole('admin');
    expect(m.administration).toBe('editor');
    expect(m.restricted_work_orders).toBeUndefined();
  });

  it('operator roles: broad view + editor in their work area', () => {
    expect(seedMembershipForRole('engineer')).toMatchObject({ production: 'editor', work_orders: 'viewer' });
    expect(seedMembershipForRole('technolog')).toMatchObject({ production: 'editor', directories: 'editor' });
    expect(seedMembershipForRole('master')).toMatchObject({ work_orders: 'editor', supply: 'editor' });
    expect(seedMembershipForRole('supply')).toMatchObject({ supply: 'editor', warehouse: 'viewer' });
    expect(seedMembershipForRole('timekeeper')).toMatchObject({ people: 'editor', warehouse: 'viewer' });
  });

  it('viewer (бухгалтерия/ПЭО) keeps finance visibility', () => {
    const m = seedMembershipForRole('viewer');
    expect(m.contracts).toBe('viewer');
    expect(m.reports).toBe('viewer');
  });

  it('pending/employee/unknown get nothing', () => {
    expect(seedMembershipForRole('pending')).toEqual({});
    expect(seedMembershipForRole('employee')).toEqual({});
    expect(seedMembershipForRole(null)).toEqual({});
  });
});

// Ф3: ledger write → owning section (server viewer write-gate).
describe('sectionForLedgerWrite', () => {
  it('maps EAV rows by entity_type code', () => {
    expect(sectionForLedgerWrite({ table: 'entities', entityTypeCode: 'engine' })).toBe(AccessSection.Production);
    expect(sectionForLedgerWrite({ table: 'attribute_values', entityTypeCode: 'contract' })).toBe(AccessSection.Contracts);
    expect(sectionForLedgerWrite({ table: 'attribute_values', entityTypeCode: 'employee' })).toBe(AccessSection.People);
    expect(sectionForLedgerWrite({ table: 'entities', entityTypeCode: 'nomenclature' })).toBe(AccessSection.Warehouse);
  });

  it('unmapped/shared types fail open (null)', () => {
    expect(sectionForLedgerWrite({ table: 'entities', entityTypeCode: 'tool' })).toBeNull();
    expect(sectionForLedgerWrite({ table: 'entities', entityTypeCode: 'workshop' })).toBeNull();
    expect(sectionForLedgerWrite({ table: 'entities', entityTypeCode: '' })).toBeNull();
    expect(sectionForLedgerWrite({ table: 'notes' })).toBeNull();
    expect(sectionForLedgerWrite({ table: 'erp_reg_stock_balance' })).toBeNull();
  });

  it('operations: supply_request → supply, work_order → work_orders, engine-flow default → production', () => {
    expect(sectionForLedgerWrite({ table: 'operations', operationType: 'supply_request' })).toBe(AccessSection.Supply);
    expect(sectionForLedgerWrite({ table: 'operations', operationType: 'work_order' })).toBe(AccessSection.WorkOrders);
    expect(sectionForLedgerWrite({ table: 'operations', operationType: 'engine_intake' })).toBe(AccessSection.Production);
  });

  it('ERP tables map to warehouse/production', () => {
    expect(sectionForLedgerWrite({ table: 'erp_nomenclature' })).toBe(AccessSection.Warehouse);
    expect(sectionForLedgerWrite({ table: 'erp_engine_assembly_bom_lines' })).toBe(AccessSection.Production);
  });
});

describe('parseSectionMembership double-encoding', () => {
  it('parses the double-encoded value the prod backfill stores', () => {
    const inner = JSON.stringify({ production: 'viewer', supply: 'editor' });
    expect(parseSectionMembership(JSON.stringify(inner))).toEqual({ production: 'viewer', supply: 'editor' });
    expect(parseSectionMembership(inner)).toEqual({ production: 'viewer', supply: 'editor' });
  });
});
