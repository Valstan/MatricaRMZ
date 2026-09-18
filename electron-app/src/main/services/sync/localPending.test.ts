import { beforeEach, describe, expect, it } from 'vitest';

import type { SqlExecutor } from '../../database/sqlExecutor.js';
import { buildPendingCountSql, countPendingLocalRows, listPendingProbeTables, resetPendingProbeCache } from './localPending.js';

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
