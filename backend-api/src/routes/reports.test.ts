import { describe, expect, it, vi } from 'vitest';

// reports.ts pulls in the pg-backed db transitively; stub it so importing the
// route module does not construct a real connection pool. The functions under
// test (allowedForTable / findTable / redactReportRows) are pure.
vi.mock('../database/db.js', () => ({ db: {}, pool: {} }));

const { allowedForTable, builderMetaTables, findTable, redactReportRows } = await import('./reports.js');
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

const SENSITIVE_TABLES = ['chat_messages', 'chat_reads', 'notes', 'note_shares', 'user_presence', 'file_assets'];

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

// Дело не в содержимом строк file_assets, а в СПИСКЕ id. Право читать файл сервер выводит
// из контекста, в котором id встретился, и часть таких контекстов пишет сам проситель
// (PENDING_FOLLOWUPS §Security п.6) — то есть защита держалась на «id ещё надо где-то
// узнать». `files.view` входит в базовый набор ЛЮБОЙ операторской роли, поэтому этого
// гейта было недостаточно ровно никогда.
describe('report builder — список id файлов служебный', () => {
  it('одного files.view для таблицы файлов больше не хватает', () => {
    const withFilesView = { ...OPERATOR_PERMS, [PermissionCode.FilesView]: true };
    expect(allowedForTable(withFilesView, findTable('file_assets')!)).toBe(false);
  });

  it('админ таблицу видит — он и так проходит проверку доступа к файлу безусловно', () => {
    expect(allowedForTable(ADMIN_PERMS, findTable('file_assets')!)).toBe(true);
  });
});

// Каталог источников раньше не смотрел на актора ВООБЩЕ: выборка честно отказывала, а
// список таблиц с колонками уезжал любому, кто дотянулся до конструктора. Значит смена
// права у одной таблицы без фильтра каталога не меняла бы ничего на глаз — строка
// осталась бы в списке и отвечала бы отказом при построении отчёта.
describe('report builder — каталог источников фильтруется правами', () => {
  const names = (perms: Record<string, boolean>) => builderMetaTables(perms).map((t) => t.name);

  it('оператор не видит в списке ни файлов, ни служебных таблиц', () => {
    const visible = names(OPERATOR_PERMS);
    for (const name of ['file_assets', 'refresh_tokens', 'permissions', 'chat_messages', 'notes']) {
      expect(visible, name).not.toContain(name);
    }
  });

  it('оператору остаётся то, чем он и пользуется', () => {
    const visible = names(OPERATOR_PERMS);
    expect(visible).toContain('attribute_values');
    expect(visible).toContain('operations');
  });

  it('админ видит служебные источники', () => {
    const visible = names(ADMIN_PERMS);
    expect(visible).toContain('file_assets');
    expect(visible).toContain('permissions');
  });

  it('каталог не отдаёт таблиц без единой видимой колонки', () => {
    for (const t of builderMetaTables(ADMIN_PERMS)) expect(t.columns.length, t.name).toBeGreaterThan(0);
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
