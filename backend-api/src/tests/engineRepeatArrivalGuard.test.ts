import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ф2 (docs/plans/reclamation-mvp-2026-07.md): осознанные дубли номера двигателя.
// Проверяем: (1) engineHasDuplicateBypassFlag читает флаги повторного заезда /
// коллизии; (2) loadDedupeExemptEngineIds собирает набор исключений; (3)
// mergeEngineGroup отказывается мержить флагованные карточки (защита в глубину).
// DB замокана table-aware очередью (как в directoryPartsDedupe.test.ts).

const state = vi.hoisted(() => ({
  selectByTable: new Map<unknown, any[][]>(),
}));

vi.mock('../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve(undefined)) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(undefined)) })) })),
  };
  return { db };
});

vi.mock('../services/sync/syncChangeService.js', () => ({ recordSyncChanges: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('../services/criticalEventsService.js', () => ({ ingestServerCriticalEvent: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('../utils/logger.js', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));

import { attributeValues, entities, entityTypes } from '../database/schema.js';
import { engineHasDuplicateBypassFlag, loadDedupeExemptEngineIds } from '../services/engineNumberGuard.js';
import { mergeEngineGroup } from '../services/engineDedupeService.js';

const push = (table: unknown, rows: any[]) => {
  if (!state.selectByTable.has(table)) state.selectByTable.set(table, []);
  state.selectByTable.get(table)!.push(rows);
};

beforeEach(() => {
  state.selectByTable.clear();
});

describe('engineHasDuplicateBypassFlag', () => {
  it('true when a bypass flag row holds true', async () => {
    push(attributeValues, [{ valueJson: 'true' }]);
    expect(await engineHasDuplicateBypassFlag('e1')).toBe(true);
  });

  it('false when flags absent or false', async () => {
    push(attributeValues, []);
    expect(await engineHasDuplicateBypassFlag('e1')).toBe(false);
    push(attributeValues, [{ valueJson: 'false' }, { valueJson: null }]);
    expect(await engineHasDuplicateBypassFlag('e1')).toBe(false);
  });
});

describe('loadDedupeExemptEngineIds', () => {
  it('collects only entities whose flag value is true', async () => {
    push(attributeValues, [
      { entityId: 'a', valueJson: 'true' },
      { entityId: 'b', valueJson: 'false' },
      { entityId: 'c', valueJson: '"true"' },
    ]);
    const set = await loadDedupeExemptEngineIds();
    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(false);
    expect(set.has('c')).toBe(true);
  });
});

describe('mergeEngineGroup exempt guard', () => {
  it('rejects merge when a flagged card is involved', async () => {
    push(entityTypes, [{ id: 'type-engine' }]); // engine type lookup
    push(entities, [{ id: 'surv' }, { id: 'loser' }]); // alive validation
    push(attributeValues, [{ entityId: 'loser', valueJson: 'true' }]); // exempt set
    const r = await mergeEngineGroup({
      survivorId: 'surv',
      loserIds: ['loser'],
      actor: { id: 'a', username: 'test', role: 'admin' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('исключены из склейки');
  });
});
