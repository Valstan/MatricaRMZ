import { describe, expect, it } from 'vitest';

import {
  findForbiddenIdentifiers,
  isHiddenAttributeName,
  sanitizeAttributeValueRows,
  sanitizeRow,
  sanitizeRows,
  sqlReferencesHiddenIdentifiers,
} from '../services/ai/sensitiveFilter.js';

describe('sensitiveFilter', () => {
  it('redacts hidden columns in a single row', () => {
    const row = {
      id: 'u1',
      login: 'alice',
      password_hash: 'abc',
      refresh_token: 'rt',
      salt: 's',
    };
    const out = sanitizeRow(row);
    expect(out.id).toBe('u1');
    expect(out.login).toBe('alice');
    expect(out.password_hash).toBe('[hidden]');
    expect(out.refresh_token).toBe('[hidden]');
    expect(out.salt).toBe('[hidden]');
  });

  it('case-insensitive column matching', () => {
    const row = { ID: 'x', Password_Hash: 'p', TokenHash: 't' };
    const out = sanitizeRow(row);
    expect(out.Password_Hash).toBe('[hidden]');
    expect(out.TokenHash).toBe('[hidden]');
    expect(out.ID).toBe('x');
  });

  it('sanitizeRows maps over array', () => {
    const out = sanitizeRows([
      { id: 1, secret: 'a' },
      { id: 2, secret: 'b' },
    ]);
    expect(out[0]?.secret).toBe('[hidden]');
    expect(out[1]?.secret).toBe('[hidden]');
    expect(out[0]?.id).toBe(1);
  });

  it('isHiddenAttributeName matches salary/паспорт synonyms', () => {
    expect(isHiddenAttributeName('salary')).toBe(true);
    expect(isHiddenAttributeName('SALARY_BASE')).toBe(true);
    expect(isHiddenAttributeName('зарплата')).toBe(true);
    expect(isHiddenAttributeName('паспорт_серия')).toBe(true);
    expect(isHiddenAttributeName('inn')).toBe(true);
    expect(isHiddenAttributeName('снилс')).toBe(true);
    expect(isHiddenAttributeName('fullname')).toBe(false);
    expect(isHiddenAttributeName('')).toBe(false);
    expect(isHiddenAttributeName(null)).toBe(false);
  });

  it('sanitizeAttributeValueRows removes rows whose attribute name is hidden', () => {
    const rows = [
      { attribute_name: 'fullname', value: 'Иванов И.И.' },
      { attribute_name: 'salary', value: '50000' },
      { attribute_code: 'passport_no', value: '1234' },
      { attribute_code: 'phone', value: '+7' },
    ];
    const out = sanitizeAttributeValueRows(rows);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.attribute_name === 'salary')).toBeUndefined();
    expect(out.find((r) => r.attribute_code === 'passport_no')).toBeUndefined();
  });

  it('findForbiddenIdentifiers detects refresh_tokens / password_hash', () => {
    expect(findForbiddenIdentifiers('select * from refresh_tokens')).toContain('refresh_tokens');
    expect(findForbiddenIdentifiers('select password_hash from users')).toContain('password_hash');
    expect(findForbiddenIdentifiers('select id, login from users')).toHaveLength(0);
  });

  it('sqlReferencesHiddenIdentifiers is true on any hit', () => {
    expect(sqlReferencesHiddenIdentifiers('SELECT * FROM REFRESH_TOKENS')).toBe(true);
    expect(sqlReferencesHiddenIdentifiers('select id from users')).toBe(false);
    expect(sqlReferencesHiddenIdentifiers('select e.private_key from entities e')).toBe(true);
  });
});
