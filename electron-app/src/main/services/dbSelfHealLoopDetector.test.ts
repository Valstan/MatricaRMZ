import { describe, expect, it } from 'vitest';

import {
  extractFailedSql,
  isSameMigrationFailure,
  normalizeSqlForCompare,
} from './dbSelfHealLoopDetector.js';

describe('dbSelfHealLoopDetector', () => {
  const realIncidentError =
    `DrizzleError: Failed to run the query '-- Phase 2.4 PR 3 — SQLite клиент: дропаем legacy \`warehouse_id\` из 3 регистров.\n` +
    `-- SQLite ≥ 3.35.0 поддерживает ALTER TABLE DROP COLUMN.\n\n` +
    `ALTER TABLE \`erp_reg_stock_balance\` DROP COLUMN \`warehouse_id\`;\n'`;

  describe('extractFailedSql', () => {
    it('extracts multi-line SQL from a DrizzleError', () => {
      const sql = extractFailedSql(realIncidentError);
      expect(sql).not.toBeNull();
      expect(sql).toContain('ALTER TABLE `erp_reg_stock_balance` DROP COLUMN `warehouse_id`');
      expect(sql).toContain('-- Phase 2.4 PR 3');
    });

    it('returns null when marker is absent', () => {
      expect(extractFailedSql('Some unrelated error: connection lost')).toBeNull();
      expect(extractFailedSql('')).toBeNull();
    });

    it('returns null for non-string input', () => {
      // @ts-expect-error testing runtime safety
      expect(extractFailedSql(null)).toBeNull();
      // @ts-expect-error testing runtime safety
      expect(extractFailedSql(42)).toBeNull();
    });

    it('handles single-line ALTER without comments', () => {
      const msg = `DrizzleError: Failed to run the query 'ALTER TABLE x DROP COLUMN y;'`;
      expect(extractFailedSql(msg)).toBe('ALTER TABLE x DROP COLUMN y;');
    });
  });

  describe('normalizeSqlForCompare', () => {
    it('collapses whitespace and trims', () => {
      expect(normalizeSqlForCompare('  ALTER\n\nTABLE\t x  DROP   COLUMN y;  ')).toBe(
        'ALTER TABLE x DROP COLUMN y;',
      );
    });
  });

  describe('isSameMigrationFailure', () => {
    it('matches identical errors from two attempts', () => {
      expect(isSameMigrationFailure(realIncidentError, realIncidentError)).toBe(true);
    });

    it('matches when whitespace differs but SQL is the same', () => {
      const a = `DrizzleError: Failed to run the query 'ALTER TABLE x DROP COLUMN y;'`;
      const b = `DrizzleError: Failed to run the query '\n\n  ALTER TABLE x   DROP COLUMN y;\n'`;
      expect(isSameMigrationFailure(a, b)).toBe(true);
    });

    it('does not match different SQL statements', () => {
      const a = `DrizzleError: Failed to run the query 'ALTER TABLE x DROP COLUMN y;'`;
      const b = `DrizzleError: Failed to run the query 'ALTER TABLE z DROP COLUMN w;'`;
      expect(isSameMigrationFailure(a, b)).toBe(false);
    });

    it('falls back to full-message compare when neither carries SQL marker', () => {
      const a = 'sqlite is locked';
      const b = 'sqlite is locked';
      expect(isSameMigrationFailure(a, b)).toBe(true);
    });

    it('returns false for empty inputs', () => {
      expect(isSameMigrationFailure('', '')).toBe(false);
      expect(isSameMigrationFailure(null, undefined)).toBe(false);
    });

    it('returns false when only one error has the SQL marker', () => {
      const withSql = `DrizzleError: Failed to run the query 'ALTER TABLE x DROP COLUMN y;'`;
      const withoutSql = 'sqlite is locked';
      expect(isSameMigrationFailure(withSql, withoutSql)).toBe(false);
    });

    it('accepts non-string Error instances', () => {
      const err1 = new Error(`Failed to run the query 'SELECT 1;'`);
      const err2 = new Error(`Failed to run the query 'SELECT 1;'`);
      expect(isSameMigrationFailure(err1, err2)).toBe(true);
    });
  });
});
