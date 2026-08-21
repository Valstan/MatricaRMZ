import { describe, expect, it, vi } from 'vitest';

// fileAccessService imports the db (which connects on import) — stub it; these
// tests exercise only the pure helpers (no DB access).
vi.mock('../database/db.js', () => ({ db: {} }));

import {
  attrDefHoldsFiles,
  eavRowGrantsFileAccess,
  jsonContainsId,
  permsForEntityTypeCode,
} from '../services/fileAccessService.js';
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

describe('fileAccessService.attrDefHoldsFiles', () => {
  it('accepts the attributes that actually carry FileRef[]', () => {
    expect(attrDefHoldsFiles('attachments', null)).toBe(true);
    expect(attrDefHoldsFiles('photos', null)).toBe(true);
  });

  it('accepts the legacy codes whose rows predate the merge into attachments', () => {
    expect(attrDefHoldsFiles('drawings', null)).toBe(true);
    expect(attrDefHoldsFiles('tech_docs', null)).toBe(true);
  });

  it('accepts a contract file field declared by its metaJson marker', () => {
    const meta = JSON.stringify({ ui: 'files', category: 'akt_scan', kind: 'file' });
    expect(attrDefHoldsFiles('akt_scan', meta)).toBe(true);
  });

  it('rejects self-authored profile attributes (a shortcut is a bookmark, not a grant)', () => {
    expect(attrDefHoldsFiles('ui_profile_json', null)).toBe(false);
    expect(attrDefHoldsFiles('ui_settings_json', null)).toBe(false);
  });

  it('rejects free-text attributes the requester can write on their own card', () => {
    expect(attrDefHoldsFiles('full_name', null)).toBe(false);
    expect(attrDefHoldsFiles('telegram_login', null)).toBe(false);
    expect(attrDefHoldsFiles('comment', null)).toBe(false);
  });

  it('rejects a metaJson that is absent, unrelated or unparsable', () => {
    expect(attrDefHoldsFiles('custom_field', undefined)).toBe(false);
    expect(attrDefHoldsFiles('custom_field', JSON.stringify({ ui: 'text' }))).toBe(false);
    expect(attrDefHoldsFiles('custom_field', '{not json')).toBe(false);
    expect(attrDefHoldsFiles('custom_field', JSON.stringify('files'))).toBe(false);
  });
});

describe('fileAccessService.eavRowGrantsFileAccess', () => {
  const canViewEmployees = (p: string) => p === PermissionCode.EmployeesView;
  const attachmentsRow = {
    typeCode: 'employee',
    attrCode: 'attachments',
    attrMetaJson: null,
    valueJson: JSON.stringify([{ id: ID, name: 'passport.pdf' }]),
  };

  it('grants a real attachment on a type the actor may view', () => {
    expect(eavRowGrantsFileAccess(attachmentsRow, ID, canViewEmployees)).toBe(true);
  });

  it('refuses the same file when the actor cannot view the owning type', () => {
    expect(eavRowGrantsFileAccess(attachmentsRow, ID, () => false)).toBe(false);
  });

  it('refuses a file id the requester pasted into an attribute they author themselves', () => {
    const ownProfile = { ...attachmentsRow, attrCode: 'ui_profile_json', valueJson: JSON.stringify({ shortcuts: [ID] }) };
    const ownName = { ...attachmentsRow, attrCode: 'full_name', valueJson: JSON.stringify(ID) };
    expect(eavRowGrantsFileAccess(ownProfile, ID, canViewEmployees)).toBe(false);
    expect(eavRowGrantsFileAccess(ownName, ID, canViewEmployees)).toBe(false);
  });

  it('refuses a file attribute that only mentions the id as part of a longer string', () => {
    const mentioned = { ...attachmentsRow, valueJson: JSON.stringify([{ id: `${ID}-thumb` }]) };
    expect(eavRowGrantsFileAccess(mentioned, ID, canViewEmployees)).toBe(false);
  });

  it('grants a contract file field whose code is arbitrary but marked in metaJson', () => {
    const custom = {
      typeCode: 'contract',
      attrCode: 'akt_scan',
      attrMetaJson: JSON.stringify({ ui: 'files', category: 'akt_scan', kind: 'file' }),
      valueJson: JSON.stringify([{ id: ID, name: 'akt.pdf' }]),
    };
    expect(eavRowGrantsFileAccess(custom, ID, (p) => p === PermissionCode.MasterDataView)).toBe(true);
  });
});
