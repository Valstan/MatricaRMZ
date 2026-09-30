import { describe, expect, it, vi } from 'vitest';

vi.mock('../database/db.js', () => {
  const limit = vi.fn();
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  (globalThis as any).__rowHistoryDb = { select, limit };
  return { db: { select }, pool: {} };
});

import { db } from '../database/db.js';
import { listRowHistory, versionChangedKeys } from './rowHistoryService.js';

const mockLimit = () => (globalThis as any).__rowHistoryDb.limit as ReturnType<typeof vi.fn>;

// H1: история объекта из журнала — версии по возрастанию seq, changed_keys показывают,
// что именно менялось в каждой.

describe('versionChangedKeys', () => {
  it('первое сравнение некому — пусто; дальше только изменившиеся ключи', () => {
    expect(versionChangedKeys(null, { a: 1 })).toEqual([]);
    expect(versionChangedKeys({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(['b']);
    expect(versionChangedKeys({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it('вложенные объекты сравниваются по значению, порядок — по новой версии', () => {
    expect(versionChangedKeys({ m: { x: 1 }, z: 0 }, { z: 0, m: { x: 2 }, n: 1 })).toEqual(['m', 'n']);
  });

  it('мусор вместо версий — пусто, не падение', () => {
    expect(versionChangedKeys(null, null)).toEqual([]);
    expect(versionChangedKeys('[', ']')).toEqual([]);
  });
});

describe('listRowHistory', () => {
  const journalRows = [
    {
      serverSeq: 7n,
      op: 'upsert',
      payloadJson: JSON.stringify({ id: 'r1', note: 'первая', status: 'draft' }),
      createdAt: 1000n,
      actorUserId: 'u1',
      actorUsername: 'ivanov',
    },
    {
      serverSeq: 9n,
      op: 'upsert',
      payloadJson: JSON.stringify({ id: 'r1', note: 'вторая', status: 'draft' }),
      createdAt: 2000n,
      actorUserId: 'u2',
      actorUsername: 'petrov',
    },
  ];

  it('версии по возрастанию seq с актором и changed_keys', async () => {
    mockLimit().mockResolvedValueOnce(journalRows);
    const versions = await listRowHistory('operations', 'r1', 50);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ seq: 7, op: 'upsert', ts: 1000, actor_username: 'ivanov' });
    expect(versions[0]!.changed_keys).toEqual(['id', 'note', 'status']);
    expect(versions[1]).toMatchObject({ seq: 9, actor_username: 'petrov' });
    expect(versions[1]!.changed_keys).toEqual(['note']);
    expect((versions[1]!.row as any).note).toBe('вторая');
    expect(db).toBeDefined();
  });

  it('битый payload версии не роняет историю', async () => {
    mockLimit().mockResolvedValueOnce([{ ...journalRows[0], payloadJson: '{oops' }]);
    const versions = await listRowHistory('operations', 'r1', 50);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.row).toBeNull();
    expect(versions[0]!.changed_keys).toEqual([]);
  });
});
