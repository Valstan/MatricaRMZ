import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fakeRows, poolQueryMock } = vi.hoisted(() => ({
  fakeRows: [] as Array<Record<string, unknown>>,
  poolQueryMock: vi.fn(),
}));

vi.mock('../database/db.js', () => {
  function makeQueryBuilder() {
    const state: {
      type?: 'select' | 'insert' | 'delete';
      values?: Record<string, unknown>;
      whereFn?: (row: Record<string, unknown>) => boolean;
      orderKey?: string;
      orderDir?: 'asc' | 'desc';
      limitN?: number;
    } = {};
    const exec = () => {
      if (state.type === 'insert' && state.values) {
        fakeRows.push(state.values);
        return [];
      }
      if (state.type === 'delete') {
        const remaining: typeof fakeRows = [];
        const removed: typeof fakeRows = [];
        for (const r of fakeRows) {
          if (state.whereFn ? state.whereFn(r) : true) removed.push(r);
          else remaining.push(r);
        }
        fakeRows.length = 0;
        fakeRows.push(...remaining);
        return removed.map((r) => ({ id: r.id }));
      }
      let rows = fakeRows.filter((r) => (state.whereFn ? state.whereFn(r) : true));
      if (state.orderKey) {
        rows = [...rows].sort((a, b) => {
          const av = Number(a[state.orderKey!] ?? 0);
          const bv = Number(b[state.orderKey!] ?? 0);
          return state.orderDir === 'desc' ? bv - av : av - bv;
        });
      }
      if (typeof state.limitN === 'number') rows = rows.slice(0, state.limitN);
      return rows;
    };
    const chain: any = {
      select() {
        state.type = 'select';
        return chain;
      },
      insert() {
        state.type = 'insert';
        return chain;
      },
      delete() {
        state.type = 'delete';
        return chain;
      },
      values(v: any) {
        state.values = v;
        return Promise.resolve(exec());
      },
      from() {
        return chain;
      },
      where(fn: any) {
        state.whereFn = fn;
        return chain;
      },
      orderBy(o: any) {
        if (o && typeof o === 'object' && 'key' in o) {
          state.orderKey = o.key;
          state.orderDir = o.dir;
        } else if (o && 'key' in o) {
          state.orderKey = o.key;
          state.orderDir = 'asc';
        }
        return chain;
      },
      limit(n: number) {
        state.limitN = n;
        return Promise.resolve(exec());
      },
      returning() {
        return Promise.resolve(exec());
      },
    };
    return chain;
  }

  return {
    pool: { query: poolQueryMock },
    db: {
      insert: () => makeQueryBuilder().insert(),
      select: () => makeQueryBuilder().select(),
      delete: () => makeQueryBuilder().delete(),
    },
  };
});

vi.mock('drizzle-orm', () => ({
  and: (...preds: any[]) => (row: any) => preds.every((p) => (typeof p === 'function' ? p(row) : true)),
  eq: (col: any, value: any) => (row: any) => row[col.key] === value,
  lt: (col: any, value: any) => (row: any) => Number(row[col.key]) < Number(value),
  desc: (col: any) => ({ key: col.key, dir: 'desc' }),
}));

vi.mock('../database/schema.js', () => {
  const col = (key: string) => ({ key });
  const aiChatHistory: any = {
    id: col('id'),
    userId: col('userId'),
    conversationId: col('conversationId'),
    role: col('role'),
    content: col('content'),
    toolCallsJson: col('toolCallsJson'),
    toolResultsJson: col('toolResultsJson'),
    model: col('model'),
    inputTokens: col('inputTokens'),
    outputTokens: col('outputTokens'),
    contextJson: col('contextJson'),
    ts: col('ts'),
    createdAt: col('createdAt'),
  };
  return { aiChatHistory };
});

import {
  appendMessage,
  cleanupExpiredMessages,
  deleteConversation,
  getConversationMessages,
  listConversations,
  searchInConversation,
  AI_CHAT_HISTORY_RETENTION_DAYS,
} from '../services/ai/aiChatHistoryService.js';

beforeEach(() => {
  fakeRows.length = 0;
  poolQueryMock.mockReset();
});

describe('aiChatHistoryService', () => {
  it('appendMessage stores a row with role and content', async () => {
    await appendMessage({
      userId: 'u1',
      conversationId: 'c1',
      role: 'user',
      content: 'привет',
    });
    expect(fakeRows).toHaveLength(1);
    expect(fakeRows[0]?.role).toBe('user');
    expect(fakeRows[0]?.content).toBe('привет');
    expect(fakeRows[0]?.userId).toBe('u1');
  });

  it('appendMessage serializes JSON fields and respects explicit ts', async () => {
    await appendMessage({
      userId: 'u1',
      conversationId: 'c1',
      role: 'assistant',
      content: 'ответ',
      model: 'haiku',
      inputTokens: 100,
      outputTokens: 50,
      toolCalls: [{ name: 'query_nomenclature' }],
      context: { tab: 'engines' },
      ts: 123456,
    });
    expect(fakeRows[0]?.ts).toBe(123456);
    expect(fakeRows[0]?.toolCallsJson).toBe('[{"name":"query_nomenclature"}]');
    expect(fakeRows[0]?.contextJson).toBe('{"tab":"engines"}');
    expect(fakeRows[0]?.inputTokens).toBe(100);
  });

  it('listConversations delegates to pool.query with the userId', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          conversation_id: 'c2',
          last_message_at: 200,
          message_count: 1,
          last_user_message: 'q2',
          last_model: null,
        },
        {
          conversation_id: 'c1',
          last_message_at: 110,
          message_count: 2,
          last_user_message: 'q1',
          last_model: 'haiku',
        },
      ],
    });
    const convs = await listConversations('u1');
    expect(poolQueryMock).toHaveBeenCalledOnce();
    expect(poolQueryMock.mock.calls[0]![0]).toMatch(/group by h\.user_id, h\.conversation_id/);
    expect(poolQueryMock.mock.calls[0]![1]).toEqual(['u1']);
    expect(convs).toHaveLength(2);
    expect(convs[0]?.conversationId).toBe('c2');
    expect(convs[1]?.lastModel).toBe('haiku');
  });

  it('getConversationMessages filters by user and conversation', async () => {
    await appendMessage({ userId: 'u1', conversationId: 'c1', role: 'user', content: 'q1', ts: 100 });
    await appendMessage({ userId: 'u1', conversationId: 'c1', role: 'assistant', content: 'a1', ts: 110 });
    await appendMessage({ userId: 'u2', conversationId: 'c1', role: 'user', content: 'other', ts: 105 });

    const msgs = await getConversationMessages('u1', 'c1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.content).toBe('q1');
    expect(msgs[1]?.content).toBe('a1');
  });

  it('deleteConversation removes only the targeted conversation', async () => {
    await appendMessage({ userId: 'u1', conversationId: 'c1', role: 'user', content: 'a', ts: 1 });
    await appendMessage({ userId: 'u1', conversationId: 'c2', role: 'user', content: 'b', ts: 2 });
    const removed = await deleteConversation('u1', 'c1');
    expect(removed).toBe(1);
    expect(fakeRows).toHaveLength(1);
    expect(fakeRows[0]?.conversationId).toBe('c2');
  });

  it('searchInConversation delegates to pool.query with lowered LIKE pattern', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'm1',
          user_id: 'u1',
          conversation_id: 'c1',
          role: 'user',
          content: 'Поршень группа 5',
          tool_calls_json: null,
          tool_results_json: null,
          model: null,
          input_tokens: null,
          output_tokens: null,
          context_json: null,
          ts: 100,
          created_at: 100,
        },
      ],
    });
    const hits = await searchInConversation('u1', 'c1', 'ПОРШЕНЬ');
    expect(poolQueryMock).toHaveBeenCalledOnce();
    expect(poolQueryMock.mock.calls[0]![1]).toEqual(['u1', 'c1', '%поршень%']);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain('Поршень');
  });

  it('searchInConversation returns empty array for blank query without hitting db', async () => {
    const hits = await searchInConversation('u1', 'c1', '   ');
    expect(hits).toEqual([]);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('cleanupExpiredMessages removes rows older than retention window', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = 1_000_000_000;
    const oldTs = now - (AI_CHAT_HISTORY_RETENTION_DAYS + 1) * dayMs;
    const recentTs = now - 1 * dayMs;

    await appendMessage({ userId: 'u1', conversationId: 'c1', role: 'user', content: 'old', ts: oldTs });
    await appendMessage({ userId: 'u1', conversationId: 'c1', role: 'user', content: 'recent', ts: recentTs });
    const removed = await cleanupExpiredMessages(now);
    expect(removed).toBe(1);
    expect(fakeRows).toHaveLength(1);
    expect(fakeRows[0]?.content).toBe('recent');
  });
});
