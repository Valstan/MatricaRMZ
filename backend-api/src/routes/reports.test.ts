import { describe, expect, it, vi } from 'vitest';

// reports.ts pulls in the pg-backed db transitively; stub it so importing the
// route module does not construct a real connection pool. The functions under
// test (allowedForTable / findTable / redactReportRows) are pure.
vi.mock('../database/db.js', () => ({ db: {}, pool: {} }));

const { allowedForTable, findTable, redactReportRows } = await import('./reports.js');
const { PermissionCode } = await import('@matricarmz/shared');

// What a low-privilege operator typically holds — NO admin-only codes.
const OPERATOR_PERMS: Record<string, boolean> = {
  [PermissionCode.ChatUse]: true,
  [PermissionCode.ReportsView]: true,
  [PermissionCode.EmployeesView]: true,
  [PermissionCode.MasterDataView]: true,
  [PermissionCode.EnginesView]: true,
  [PermissionCode.PartsView]: true,
  [PermissionCode.OperationsView]: true,
};
const ADMIN_PERMS: Record<string, boolean> = {
  [PermissionCode.AdminUsersManage]: true,
  [PermissionCode.ChatExport]: true,
  [PermissionCode.ReportsView]: true,
};

const SENSITIVE_TABLES = ['chat_messages', 'chat_reads', 'notes', 'note_shares', 'user_presence'];

describe('report builder — per-user private tables are admin-only (H2/H3)', () => {
  it('operators cannot reach chat / notes / presence tables', () => {
    for (const name of SENSITIVE_TABLES) {
      const t = findTable(name);
      expect(t, name).toBeTruthy();
      expect(allowedForTable(OPERATOR_PERMS, t!), name).toBe(false);
    }
  });

  it('admins can reach them', () => {
    for (const name of SENSITIVE_TABLES) {
      expect(allowedForTable(ADMIN_PERMS, findTable(name)!), name).toBe(true);
    }
  });

  it('non-sensitive tables stay reachable by operators (regression)', () => {
    expect(allowedForTable(OPERATOR_PERMS, findTable('attribute_values')!)).toBe(true);
    expect(allowedForTable(OPERATOR_PERMS, findTable('operations')!)).toBe(true);
  });
});

describe('report builder — EAV PII redaction (H4)', () => {
  const rows = [
    { attributeName: 'Зарплата', valueJson: '120000' },
    { attributeName: 'Паспорт', valueJson: '1234 567890' },
    { attributeName: 'ФИО', valueJson: 'Иванов И.И.' },
    { attributeName: 'INN', valueJson: '500100732259' },
  ];

  it('drops sensitive attribute rows for non-admins', () => {
    const out = redactReportRows(findTable('attribute_values')!, rows, OPERATOR_PERMS);
    expect(out.map((r) => r.attributeName)).toEqual(['ФИО']);
  });

  it('keeps everything for admins (payroll reports)', () => {
    expect(redactReportRows(findTable('attribute_values')!, rows, ADMIN_PERMS)).toHaveLength(4);
  });

  it('leaves non-attribute_values tables untouched', () => {
    const opsRows = [{ note: 'mentions зарплата but is not an EAV row' }];
    expect(redactReportRows(findTable('operations')!, opsRows, OPERATOR_PERMS)).toBe(opsRows);
  });
});
