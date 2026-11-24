/**
 * Сторож: курсор клиента ВЫШЕ головы журнала сервера ⇒ реплика собрана по
 * чужой линии и инкрементальный pull её не спасёт.
 *
 * Краснеет без правки: убери проверку в `runPullLoopWithTimelineGuard` (или
 * сам вызов `repairReplica`) — тест упадёт.
 */
import { describe, expect, it } from 'vitest';

import { isCrossTimelineCursor, runPullLoopWithTimelineGuard, type PullPageLike } from './pullTimelineGuard.js';

const page = (cursor: number, head: number, changes = 0): PullPageLike & { changes: unknown[] } => ({
  server_cursor: cursor,
  server_last_seq: head,
  has_more: false,
  changes: Array.from({ length: changes }, (_, i) => ({ i })),
});

describe('isCrossTimelineCursor', () => {
  it('курсор выше головы журнала — другая временная линия', () => {
    expect(isCrossTimelineCursor(599, 593)).toBe(true);
  });

  it('курсор на голове — не расхождение', () => {
    expect(isCrossTimelineCursor(593, 593)).toBe(false);
  });

  it('курсор ниже головы — обычная работа', () => {
    expect(isCrossTimelineCursor(500, 593)).toBe(false);
  });

  it('свежий клиент (курсор 0) — не расхождение', () => {
    expect(isCrossTimelineCursor(0, 593)).toBe(false);
  });

  it('сервер без счётчика журнала — судить не о чем', () => {
    expect(isCrossTimelineCursor(599, 0)).toBe(false);
    expect(isCrossTimelineCursor(599, null)).toBe(false);
  });
});

describe('runPullLoopWithTimelineGuard', () => {
  it('курсор выше головы → реплика пересобирается целиком', async () => {
    let repairedWith: { clientCursor: number; serverLastSeq: number } | null = null;
    const res = await runPullLoopWithTimelineGuard({
      pullOnce: async () => page(593, 593),
      repairReplica: async (info) => {
        repairedWith = info;
        return { totalPulled: 1215, changedTables: { users: 2 }, last: page(593, 593, 1215) };
      },
      since: 599,
    });
    expect(repairedWith).toEqual({ clientCursor: 599, serverLastSeq: 593 });
    expect(res.repaired).toBe(true);
    expect(res.totalPulled).toBe(1215);
  });

  it('обычный курсор → пересборки нет, тянем инкрементально', async () => {
    let repaired = false;
    const res = await runPullLoopWithTimelineGuard({
      pullOnce: async () => page(600, 600, 1),
      repairReplica: async () => {
        repaired = true;
        return { totalPulled: 0, changedTables: {}, last: page(600, 600) };
      },
      since: 599,
    });
    expect(repaired).toBe(false);
    expect(res.repaired).toBe(false);
    expect(res.totalPulled).toBe(1);
  });

  it('пустая страница при нормальном курсоре — не повод пересобирать', async () => {
    let repaired = false;
    await runPullLoopWithTimelineGuard({
      pullOnce: async () => page(599, 593),
      repairReplica: async () => {
        repaired = true;
        return { totalPulled: 0, changedTables: {}, last: page(593, 593) };
      },
      since: 593,
    });
    expect(repaired).toBe(false);
  });
});
