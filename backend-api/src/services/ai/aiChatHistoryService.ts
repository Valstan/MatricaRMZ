import { randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';

import { db, pool } from '../../database/db.js';
import { aiChatHistory } from '../../database/schema.js';
import { nowMs } from './common.js';

export const AI_CHAT_HISTORY_RETENTION_DAYS = Math.max(
  1,
  Math.min(Number(process.env.AI_CHAT_HISTORY_RETENTION_DAYS ?? 90), 3650),
);

export type ChatRole = 'user' | 'assistant' | 'tool';

export type AppendMessageArgs = {
  userId: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  toolCalls?: unknown;
  toolResults?: unknown;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  context?: unknown;
  ts?: number;
};

export type ChatHistoryRecord = {
  id: string;
  userId: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  toolCalls: unknown | null;
  toolResults: unknown | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  context: unknown | null;
  ts: number;
  createdAt: number;
};

export type ConversationSummary = {
  conversationId: string;
  lastMessageAt: number;
  lastUserMessage: string;
  messageCount: number;
  lastModel: string | null;
};

function parseJson(text: string | null): unknown | null {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rowToRecord(row: typeof aiChatHistory.$inferSelect): ChatHistoryRecord {
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    role: row.role as ChatRole,
    content: row.content,
    toolCalls: parseJson(row.toolCallsJson),
    toolResults: parseJson(row.toolResultsJson),
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    context: parseJson(row.contextJson),
    ts: row.ts,
    createdAt: row.createdAt,
  };
}

export async function appendMessage(args: AppendMessageArgs): Promise<ChatHistoryRecord> {
  const ts = args.ts ?? nowMs();
  const row = {
    id: randomUUID(),
    userId: args.userId,
    conversationId: args.conversationId,
    role: args.role,
    content: args.content,
    toolCallsJson: args.toolCalls != null ? JSON.stringify(args.toolCalls) : null,
    toolResultsJson: args.toolResults != null ? JSON.stringify(args.toolResults) : null,
    model: args.model ?? null,
    inputTokens: args.inputTokens ?? null,
    outputTokens: args.outputTokens ?? null,
    contextJson: args.context != null ? JSON.stringify(args.context) : null,
    ts,
    createdAt: ts,
  };
  await db.insert(aiChatHistory).values(row);
  return rowToRecord(row as typeof aiChatHistory.$inferSelect);
}

export async function listConversations(
  userId: string,
  limit = 50,
): Promise<ConversationSummary[]> {
  const cap = Math.max(1, Math.min(Math.floor(limit), 200));
  const sql = `
    select
      h.conversation_id,
      max(h.ts) as last_message_at,
      count(*)::int as message_count,
      (
        select h2.content from ai_chat_history h2
        where h2.user_id = h.user_id and h2.conversation_id = h.conversation_id and h2.role = 'user'
        order by h2.ts desc limit 1
      ) as last_user_message,
      (
        select h3.model from ai_chat_history h3
        where h3.user_id = h.user_id and h3.conversation_id = h.conversation_id and h3.model is not null
        order by h3.ts desc limit 1
      ) as last_model
    from ai_chat_history h
    where h.user_id = $1
    group by h.user_id, h.conversation_id
    order by max(h.ts) desc
    limit ${cap}
  `;
  const res = await pool.query(sql, [userId]);
  return (res.rows ?? []).map((r: any) => ({
    conversationId: String(r.conversation_id),
    lastMessageAt: Number(r.last_message_at ?? 0),
    messageCount: Number(r.message_count ?? 0),
    lastUserMessage: String(r.last_user_message ?? ''),
    lastModel: r.last_model ?? null,
  }));
}

export async function getConversationMessages(
  userId: string,
  conversationId: string,
  limit = 200,
): Promise<ChatHistoryRecord[]> {
  const cap = Math.max(1, Math.min(Math.floor(limit), 1000));
  const rows = (await db
    .select()
    .from(aiChatHistory)
    .where(and(eq(aiChatHistory.userId, userId), eq(aiChatHistory.conversationId, conversationId)))
    .orderBy(aiChatHistory.ts)
    .limit(cap)) as typeof aiChatHistory.$inferSelect[];
  return rows.map(rowToRecord);
}

export async function deleteConversation(userId: string, conversationId: string): Promise<number> {
  const res = await db
    .delete(aiChatHistory)
    .where(and(eq(aiChatHistory.userId, userId), eq(aiChatHistory.conversationId, conversationId)))
    .returning({ id: aiChatHistory.id });
  return res.length;
}

export async function searchInConversation(
  userId: string,
  conversationId: string,
  query: string,
  limit = 50,
): Promise<ChatHistoryRecord[]> {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return [];
  const cap = Math.max(1, Math.min(Math.floor(limit), 200));
  const pattern = `%${trimmed.toLowerCase()}%`;
  const sql = `
    select id, user_id, conversation_id, role, content, tool_calls_json, tool_results_json,
           model, input_tokens, output_tokens, context_json, ts, created_at
    from ai_chat_history
    where user_id = $1 and conversation_id = $2 and lower(content) like $3
    order by ts desc
    limit ${cap}
  `;
  const res = await pool.query(sql, [userId, conversationId, pattern]);
  return (res.rows ?? []).map((r: any) =>
    rowToRecord({
      id: r.id,
      userId: r.user_id,
      conversationId: r.conversation_id,
      role: r.role,
      content: r.content,
      toolCallsJson: r.tool_calls_json,
      toolResultsJson: r.tool_results_json,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      contextJson: r.context_json,
      ts: Number(r.ts),
      createdAt: Number(r.created_at),
    } as typeof aiChatHistory.$inferSelect),
  );
}

export async function cleanupExpiredMessages(now: number = nowMs()): Promise<number> {
  const cutoff = now - AI_CHAT_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const res = await db
    .delete(aiChatHistory)
    .where(lt(aiChatHistory.ts, cutoff))
    .returning({ id: aiChatHistory.id });
  return res.length;
}

const CLEANUP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.AI_CHAT_HISTORY_CLEANUP_INTERVAL_MS ?? 24 * 60 * 60 * 1000),
);

let cleanupTimer: NodeJS.Timeout | null = null;

export function startAiChatHistoryCleanup() {
  if (cleanupTimer) return;
  const enabled = String(process.env.AI_CHAT_HISTORY_CLEANUP_ENABLED ?? 'true').toLowerCase() === 'true';
  if (!enabled) return;
  const tick = async () => {
    try {
      const removed = await cleanupExpiredMessages();
      if (removed > 0) {
        console.log(`[ai-chat-history] cleanup removed ${removed} messages older than ${AI_CHAT_HISTORY_RETENTION_DAYS}d`);
      }
    } catch (e) {
      console.warn('[ai-chat-history] cleanup error:', e);
    }
  };
  cleanupTimer = setInterval(tick, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
  setTimeout(tick, 30_000).unref?.();
}

export function stopAiChatHistoryCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
