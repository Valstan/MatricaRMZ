import { describe, expect, it } from 'vitest';

import { buildStateSnapshotQueryParams } from './stateSnapshotQuery.js';

describe('buildStateSnapshotQueryParams', () => {
  it('требует тумбстоуны: без них снятая строка остаётся жить в реплике навсегда', () => {
    const query = buildStateSnapshotQueryParams('user_section_access', null);
    expect(query.get('include_deleted')).toBe('true');
  });

  it('несёт имя таблицы', () => {
    expect(buildStateSnapshotQueryParams('users', null).get('table')).toBe('users');
  });

  it('курсор страницы добавляется только когда он есть', () => {
    expect(buildStateSnapshotQueryParams('users', null).get('cursor_id')).toBeNull();
    expect(buildStateSnapshotQueryParams('users', 'abc-1').get('cursor_id')).toBe('abc-1');
  });

  it('include_deleted не теряется рядом с курсором страницы', () => {
    const query = buildStateSnapshotQueryParams('user_section_access', 'abc-1');
    expect(query.get('include_deleted')).toBe('true');
    expect(query.get('cursor_id')).toBe('abc-1');
  });
});
