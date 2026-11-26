import { describe, expect, it } from 'vitest';

import {
  DELETED_RETENTION_DAYS,
  DELETED_RETENTION_TEXT,
  deletedObjectRestorePath,
  deletedObjectSection,
  deletedObjectsSince,
} from './deletedObjects.js';

/**
 * «Удалённое за 3 дня» (промт КАРМАНА #169): срок хранения и путь возврата — правило одно.
 */
describe('правило «удалённое за 3 дня»', () => {
  it('окно показа — три дня', () => {
    expect(DELETED_RETENTION_DAYS).toBe(3);
    expect(DELETED_RETENTION_TEXT).toContain('3 дня');
  });

  it('отсечка окна считается назад от текущего момента', () => {
    const now = 1_000_000_000_000;
    expect(deletedObjectsSince(now)).toBe(now - 3 * 24 * 60 * 60 * 1000);
    expect(deletedObjectsSince(now, 1)).toBe(now - 24 * 60 * 60 * 1000);
  });

  it('путь возврата называет раздел и объект', () => {
    expect(deletedObjectRestorePath('engine', 'Д-100')).toBe('Двигатели → Д-100');
    expect(deletedObjectSection('engine')).toBe('Двигатели');
    expect(deletedObjectSection('такого-вида-нет')).toBe('');
  });
});
