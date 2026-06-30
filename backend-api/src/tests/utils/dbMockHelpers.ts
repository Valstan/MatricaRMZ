import { vi } from 'vitest';

export function dequeue<T>(queue: T[], fallback: T): T {
  if (queue.length === 0) return fallback;
  return queue.shift() as T;
}

export function makeSelectChain(rowsFor: () => any[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(async () => rowsFor()),
        })),
        limit: vi.fn(async () => rowsFor()),
      })),
      orderBy: vi.fn(() => ({
        limit: vi.fn(async () => rowsFor()),
      })),
      limit: vi.fn(async () => rowsFor()),
    })),
  };
}

export function makeInsertChain() {
  return {
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn().mockResolvedValue({}),
      onConflictDoNothing: vi.fn().mockResolvedValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
      returning: vi.fn().mockResolvedValue([]),
    })),
  };
}

export function makeQueuedSelectMock(selectQueue: any[]) {
  return vi.fn(() => makeSelectChain(() => dequeue(selectQueue, [])));
}

export function makeTxSelectFromTableMap(rowsByTable: Map<unknown, any[]>) {
  return vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => {
        const rows = rowsByTable.get(table) ?? [];
        const chained = Object.assign(Promise.resolve(rows), {
          limit: vi.fn(async () => rows),
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        });
        return chained;
      }),
      orderBy: vi.fn(() => ({
        limit: vi.fn(async () => rowsByTable.get(table) ?? []),
      })),
      limit: vi.fn(async () => rowsByTable.get(table) ?? []),
    })),
  }));
}

