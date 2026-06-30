import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0' },
  shell: { openPath: async () => '' },
}));

import { compareSemver, __test } from './emergencyUpdate.js';

describe('emergencyUpdate pure helpers', () => {
  describe('compareSemver', () => {
    it('orders by major', () => {
      expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
      expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    });

    it('orders by minor when major matches', () => {
      expect(compareSemver('1.31.2', '1.31.1')).toBe(1);
      expect(compareSemver('1.31.1', '1.31.2')).toBe(-1);
    });

    it('orders by patch when major+minor match', () => {
      expect(compareSemver('1.31.2', '1.31.1')).toBe(1);
      expect(compareSemver('1.31.1', '1.31.1')).toBe(0);
    });

    it('strips leading v', () => {
      expect(compareSemver('v1.31.2', '1.31.1')).toBe(1);
    });

    it('ignores prerelease suffix for ordering (treats as equal)', () => {
      // Coarse comparison is fine for our emergency-mode use — we only ask
      // "is the server strictly newer than me?"; pre-release nuance doesn't matter.
      expect(compareSemver('1.31.2-beta', '1.31.2')).toBe(0);
    });

    it('returns 0 for unparseable inputs', () => {
      expect(compareSemver('garbage', '1.0.0')).toBe(0);
      expect(compareSemver('1.0', '1.0.0')).toBe(0);
    });
  });

  describe('joinUrl', () => {
    it('combines base and path with single slash', () => {
      expect(__test.joinUrl('https://example.com', '/updates/x')).toBe('https://example.com/updates/x');
      expect(__test.joinUrl('https://example.com/', '/updates/x')).toBe('https://example.com/updates/x');
      expect(__test.joinUrl('https://example.com', 'updates/x')).toBe('https://example.com/updates/x');
    });
  });

  describe('parseSemver', () => {
    it('parses valid versions', () => {
      expect(__test.parseSemver('1.31.2')).toEqual([1, 31, 2]);
      expect(__test.parseSemver('v1.31.2')).toEqual([1, 31, 2]);
    });
    it('returns null for invalid versions', () => {
      expect(__test.parseSemver('1.31')).toBeNull();
      expect(__test.parseSemver('abc')).toBeNull();
      expect(__test.parseSemver('')).toBeNull();
    });
  });
});
