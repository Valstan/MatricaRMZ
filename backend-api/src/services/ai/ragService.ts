import { pool } from '../../database/db.js';
import { AI_RAG_TOP_K_DEFAULT, logSnapshot, nowMs, truncate } from './common.js';

const AI_RAG_ENABLED = String(process.env.AI_RAG_ENABLED ?? 'true').toLowerCase() === 'true';
const AI_RAG_TOP_K = Number(process.env.AI_RAG_TOP_K ?? AI_RAG_TOP_K_DEFAULT);
const AI_RAG_LOOKBACK_HOURS = Number(process.env.AI_RAG_LOOKBACK_HOURS ?? 24 * 14);
const AI_RAG_SEARCH_LIMIT = Number(process.env.AI_RAG_SEARCH_LIMIT ?? 250);

type RagMemoryFact = {
  kind: 'event' | 'assist';
  actorId: string;
  text: string;
  tab?: string | null;
  entityType?: string | null;
  at: number;
};

function tokenize(text: string) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-zа-я0-9_ ]+/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 32);
}

function scoreOverlap(queryTokens: string[], text: string) {
  if (!queryTokens.length) return 0;
  const hay = ` ${String(text ?? '').toLowerCase()} `;
  let score = 0;
  for (const t of queryTokens) {
    if (hay.includes(` ${t} `) || hay.includes(t)) score += 1;
  }
  return score;
}

function normalizeJson(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function ingestRagEventFact(args: { actorId: string; context: any; event: any }) {
  if (!AI_RAG_ENABLED) return;
  const eventType = String(args.event?.type ?? '');
  if (!eventType) return;
  const field = String(args.event?.field?.label ?? args.event?.field?.name ?? '').trim();
  const value = String(args.event?.valuePreview ?? '').trim();
  const tab = String(args.context?.tab ?? '');
  const entityType = String(args.context?.entityType ?? '');
  const text = truncate(
    [tab ? `вкладка ${tab}` : '', field ? `поле ${field}` : '', value ? `значение ${value}` : '', `событие ${eventType}`]
      .filter(Boolean)
      .join(', '),
    800,
  );
  if (!text) return;
  await logSnapshot(
    'ai_agent_rag_fact',
    {
      kind: 'event',
      actorId: args.actorId,
      tab: tab || null,
      entityType: entityType || null,
      text,
      at: nowMs(),
    },
    args.actorId,
  );
}

export async function ingestRagAssistFact(args: { actorId: string; context: any; message: string; replyText: string }) {
  if (!AI_RAG_ENABLED) return;
  const message = truncate(String(args.message ?? '').trim(), 600);
  const reply = truncate(String(args.replyText ?? '').trim(), 900);
  if (!message || !reply) return;
  await logSnapshot(
    'ai_agent_rag_fact',
    {
      kind: 'assist',
      actorId: args.actorId,
      tab: String(args.context?.tab ?? '') || null,
      entityType: String(args.context?.entityType ?? '') || null,
      text: `Q: ${message}\nA: ${reply}`,
      at: nowMs(),
    },
    args.actorId,
  );
}

export async function retrieveRagMemories(args: {
  actorId: string;
  message: string;
  context: { tab?: string; entityType?: string | null };
  topK?: number;
}): Promise<string[]> {
  if (!AI_RAG_ENABLED) return [];
  const qTokens = tokenize(args.message);
  if (!qTokens.length) return [];
  const lookbackMs =
    (Number.isFinite(AI_RAG_LOOKBACK_HOURS) && AI_RAG_LOOKBACK_HOURS > 0 ? AI_RAG_LOOKBACK_HOURS : 24 * 14) * 60 * 60_000;
  const sinceMs = nowMs() - lookbackMs;
  const res = await pool.query(
    `select payload_json
       from diagnostics_snapshots
      where scope = 'ai_agent_rag_fact'
        and created_at >= $1
      order by created_at desc
      limit $2`,
    [sinceMs, Number.isFinite(AI_RAG_SEARCH_LIMIT) ? AI_RAG_SEARCH_LIMIT : 250],
  );
  const rows = Array.isArray(res.rows) ? res.rows : [];
  const relevant: Array<{ score: number; text: string }> = [];
  const desiredTab = String(args.context?.tab ?? '').toLowerCase();
  const desiredEntityType = String(args.context?.entityType ?? '').toLowerCase();
  for (const row of rows) {
    const payload = normalizeJson((row as any).payload_json ?? null) as RagMemoryFact | null;
    if (!payload || !payload.text) continue;
    let score = scoreOverlap(qTokens, payload.text);
    const tab = String(payload.tab ?? '').toLowerCase();
    const entityType = String(payload.entityType ?? '').toLowerCase();
    if (desiredTab && tab && tab === desiredTab) score += 2;
    if (desiredEntityType && entityType && entityType === desiredEntityType) score += 2;
    if (String(payload.actorId ?? '') === args.actorId) score += 1;
    if (score <= 0) continue;
    relevant.push({ score, text: payload.text });
  }
  relevant.sort((a, b) => b.score - a.score);
  const top = relevant
    .slice(0, Number.isFinite(args.topK ?? NaN) ? Number(args.topK) : AI_RAG_TOP_K)
    .map((x) => truncate(x.text, 700));
  return Array.from(new Set(top)).slice(0, 8);
}
