import { describe, expect, it, vi } from 'vitest';

// fileAccessService imports the db (which connects on import) — stub it; these
// tests exercise only the pure helpers (no DB access).
vi.mock('../database/db.js', () => ({ db: {} }));

import { jsonContainsId, permsForEntityTypeCode } from '../services/fileAccessService.js';
import { PermissionCode } from '../auth/permissions.js';

const ID = '11111111-2222-3333-4444-555555555555';

describe('fileAccessService.jsonContainsId', () => {
  it('matches a FileRef id inside an array (EAV attachments/photos)', () => {
    expect(jsonContainsId(JSON.stringify([{ id: ID, name: 'a.png' }, { id: 'other' }]), ID)).toBe(true);
  });

  it('matches a chat FileRef object payload', () => {
    expect(jsonContainsId(JSON.stringify({ id: ID, name: 'x.pdf', sha256: 'abc' }), ID)).toBe(true);
  });

  it('matches a note image block fileId', () => {
    expect(jsonContainsId(JSON.stringify({ blocks: [{ kind: 'image', fileId: ID }] }), ID)).toBe(true);
  });

  it('matches a nested operations attachments[] payload', () => {
    expect(jsonContainsId(JSON.stringify({ attachments: [{ id: ID }], rows: [{ photos: '[]' }] }), ID)).toBe(true);
  });

  it('does NOT match a substring occurrence (no false-positive grant)', () => {
    expect(jsonContainsId(JSON.stringify([{ id: `${ID}-extra` }]), ID)).toBe(false);
    expect(jsonContainsId(JSON.stringify([{ id: `prefix-${ID}` }]), ID)).toBe(false);
  });

  it('does NOT match the id appearing only as an object key', () => {
    expect(jsonContainsId(JSON.stringify({ [ID]: 'value' }), ID)).toBe(false);
  });

  it('returns false for empty / invalid / null json', () => {
    expect(jsonContainsId('', ID)).toBe(false);
    expect(jsonContainsId('not json', ID)).toBe(false);
    expect(jsonContainsId(null, ID)).toBe(false);
    expect(jsonContainsId(undefined, ID)).toBe(false);
    expect(jsonContainsId(JSON.stringify({ id: 'else' }), '')).toBe(false);
  });
});

describe('fileAccessService.permsForEntityTypeCode', () => {
  it('maps employee to EmployeesView (strictest — personnel docs)', () => {
    expect(permsForEntityTypeCode('employee')).toEqual([PermissionCode.EmployeesView]);
  });

  it('maps engine to EnginesView and part to PartsView or ErpDictionaryView', () => {
    expect(permsForEntityTypeCode('engine')).toEqual([PermissionCode.EnginesView]);
    expect(permsForEntityTypeCode('part')).toEqual([PermissionCode.PartsView, PermissionCode.ErpDictionaryView]);
  });

  it('maps contract to ContractsEdit or MasterDataView', () => {
    expect(permsForEntityTypeCode('contract')).toEqual([PermissionCode.ContractsEdit, PermissionCode.MasterDataView]);
  });

  it('falls back to MasterDataView for other masterdata types', () => {
    expect(permsForEntityTypeCode('customer')).toEqual([PermissionCode.MasterDataView]);
    expect(permsForEntityTypeCode('tool')).toEqual([PermissionCode.MasterDataView]);
    expect(permsForEntityTypeCode('engine_brand')).toEqual([PermissionCode.MasterDataView]);
  });
});
