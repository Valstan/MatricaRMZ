import { beforeEach, describe, expect, it } from 'vitest';

import type { SqlExecutor } from '../../database/sqlExecutor.js';
import {
  buildPendingCountSql,
  countPendingLocalRows,
  countStuckPendingLocalRows,
  listPendingProbeTables,
  resetPendingProbeCache,
} from './localPending.js';

function fakeExec(opts: {
  tables?: string[];
  count?: number;
  failPragma?: boolean;
  failAll?: boolean;
  onGet?: (sql: string) => void;
}): SqlExecutor & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async all(sql: string) {
      queries.push(sql);
      if (opts.failAll) throw new Error('no such table');
      if (opts.failPragma && sql.includes('pragma_table_info')) throw new Error('no such function');
      return (opts.tables ?? []).map((name) => ({ name })) as never;
    },
    async get(sql: string) {
      queries.push(sql);
      opts.onGet?.(sql);
      return { n: opts.count ?? 0 } as never;
    },
    async run() {
      return { changes: 0 };
    },
    async exec() {
      /* not used */
    },
    async transaction<T>(fn: () => Promise<T>) {
      return await fn();
    },
  };
}

beforeEach(() => {
  resetPendingProbeCache();
});

describe('проба несинканных правок', () => {
  it('считает все таблицы ОДНИМ запросом', () => {
    const sql = buildPendingCountSql(['entities', 'chat_messages']);
    expect(sql.match(/SELECT COUNT\(\*\)/g)).toHaveLength(2);
    expect(sql.startsWith('SELECT ')).toBe(true);
    expect(sql).toContain("sync_status IN ('pending','error')");
  });

  it('пустой список таблиц не ломает запрос', async () => {
    const exec = fakeExec({ tables: [] });
    expect(buildPendingCountSql([])).toBe('SELECT 0 AS n');
    await expect(countPendingLocalRows(exec)).resolves.toBe(0);
  });

  it('черновики карточек в пробу не входят — они не повод торопить синк', async () => {
    const exec = fakeExec({ tables: ['card_drafts', 'chat_messages', 'entities'] });
    await expect(listPendingProbeTables(exec)).resolves.toEqual(['chat_messages', 'entities']);
  });

  it('телеметрия ui.* из audit_log в пробу не входит — не торопим синк на каждый визит', () => {
    const sql = buildPendingCountSql(['audit_log', 'chat_messages']);
    expect(sql).toContain(`action NOT LIKE 'ui.%'`);
    expect(sql.match(/action NOT LIKE/g)).toHaveLength(1);
  });

  it('есть запасной путь для SQLite без pragma_table_info', async () => {
    const exec = fakeExec({ tables: ['entities'], failPragma: true });
    await expect(listPendingProbeTables(exec)).resolves.toEqual(['entities']);
    expect(exec.queries.some((q) => q.includes("sql LIKE '%sync_status%'"))).toBe(true);
  });

  it('список таблиц собирается один раз, а не на каждый тик', async () => {
    const exec = fakeExec({ tables: ['entities'], count: 3 });
    await countPendingLocalRows(exec);
    await countPendingLocalRows(exec);
    await countPendingLocalRows(exec);
    expect(exec.queries.filter((q) => q.includes('sqlite_master'))).toHaveLength(1);
  });

  it('сорванная проба отвечает -1 («не знаю»), а не нулём', async () => {
    const exec = fakeExec({ tables: ['entities'], failAll: true });
    await expect(countPendingLocalRows(exec)).resolves.toBe(-1);
  });
});

/**
 * Проба «застрявших» строк — инцидент 16.11.2026: 617 строк `attribute_values` висели
 * в pending неделями, и их не видел никто, кроме самой машины.
 */
function fakeStuckExec(opts: {
  tables: string[];
  rows?: Record<string, { n: number; oldest: number | null }>;
  failGet?: boolean;
}): SqlExecutor & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async all(sql: string) {
      queries.push(sql);
      return (opts.tables ?? []).map((name) => ({ name })) as never;
    },
    async get(sql: string) {
      queries.push(sql);
      if (opts.failGet) throw new Error('no such table');
      const match = /FROM "([^"]+)"/.exec(sql);
      const table = match?.[1];
      const hit = table ? opts.rows?.[table] : undefined;
      return { n: hit?.n ?? 0, oldest: hit?.oldest ?? null } as never;
    },
    async run() {
      return { changes: 0 };
    },
    async exec() {
      /* not used */
    },
    async transaction<T>(fn: () => Promise<T>) {
      return await fn();
    },
  };
}

describe('проба застрявших строк', () => {
  const NOW = 1_700_000_000_000;

  it('считает строки, висящие в pending дольше порога, и помнит самую старую', async () => {
    const exec = fakeStuckExec({
      tables: ['attribute_values', 'entities'],
      rows: {
        attribute_values: { n: 617, oldest: NOW - 3_600_000 },
        entities: { n: 0, oldest: null },
      },
    });
    const probe = await countStuckPendingLocalRows(exec, { now: NOW });
    expect(probe.count).toBe(617);
    expect(probe.oldestPendingAt).toBe(NOW - 3_600_000);
    expect(probe.byTable).toEqual([{ table: 'attribute_values', n: 617, oldestPendingAt: NOW - 3_600_000 }]);
  });

  it('считает только pending: отбитые сервером строки (error) — другая беда, у них свой баннер', async () => {
    const exec = fakeStuckExec({ tables: ['entities'] });
    await countStuckPendingLocalRows(exec, { now: NOW });
    const query = exec.queries.find((q) => q.includes('MIN(updated_at)'));
    expect(query).toContain("sync_status = 'pending'");
    expect(query).not.toContain("sync_status IN ('pending','error')");
  });

  it('отсекает по времени правки строки, а не по времени пробы', async () => {
    const exec = fakeStuckExec({ tables: ['entities'] });
    await countStuckPendingLocalRows(exec, { now: NOW, minutes: 30 });
    const query = exec.queries.find((q) => q.includes('MIN(updated_at)'));
    expect(query).toContain('updated_at < ?');
  });

  it('таблицы без updated_at в пробу не попадают — не по чему судить о возрасте', async () => {
    const exec = fakeStuckExec({ tables: ['entities'] });
    await countStuckPendingLocalRows(exec, { now: NOW });
    expect(exec.queries.some((q) => q.includes('updated_at') && q.includes('sqlite_master'))).toBe(true);
  });

  it('сорванная проба даёт ноль застрявших, а не выдуманное число', async () => {
    const exec = fakeStuckExec({ tables: ['entities'], failGet: true });
    const probe = await countStuckPendingLocalRows(exec, { now: NOW });
    expect(probe.count).toBe(0);
    expect(probe.oldestPendingAt).toBeNull();
  });
});
