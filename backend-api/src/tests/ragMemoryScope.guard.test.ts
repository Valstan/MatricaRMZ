// Сторож границы памяти ИИваныча.
//
// В факте `ai_agent_rag_fact` лежит текст переписки (`Q: вопрос\nA: ответ`), а блок
// «Память» подмешивается в промпт. Выборка обязана быть ограничена автором: до 30.08.2026
// условия по автору не было вовсе — брались 250 свежайших фактов ВСЕХ сотрудников, а
// принадлежность спрашивающему лишь прибавляла балл к релевантности. На проде это
// означало, что вопрос и ответ одного работника могли попасть в промпт другому.
//
// Ранжирование — не граница. Проверяем именно условие выборки: тест обязан краснеть,
// если фильтр уберут.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queries } = vi.hoisted(() => ({
  queries: { calls: [] as Array<{ sql: string; params: unknown[] }> },
}));

vi.mock('../database/db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.calls.push({ sql, params });
      return { rows: [] };
    }),
  },
  db: {},
}));

import { retrieveRagMemories } from '../services/ai/ragService.js';

beforeEach(() => {
  queries.calls = [];
});

describe('выборка памяти ассистента ограничена автором', () => {
  it('запрос фильтрует по client_id и передаёт actorId параметром', async () => {
    await retrieveRagMemories({
      actorId: 'actor-1',
      message: 'сколько двигателей в ремонте',
      context: { tab: 'engines', entityType: 'engine' },
    });

    expect(queries.calls).toHaveLength(1);
    const call = queries.calls[0]!;
    const sql = call.sql.replace(/\s+/g, ' ');

    expect(sql).toContain("scope = 'ai_agent_rag_fact'");
    // Условие по автору — именно в WHERE, а не в сортировке или скоринге.
    expect(sql).toMatch(/where[\s\S]*client_id = \$\d/i);
    expect(call.params).toContain('actor-1');
  });

  it('без токенов в вопросе к базе не ходит вовсе', async () => {
    const out = await retrieveRagMemories({ actorId: 'actor-1', message: '   ', context: {} });
    expect(out).toEqual([]);
    expect(queries.calls).toHaveLength(0);
  });
});
