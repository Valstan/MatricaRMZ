import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { desc, eq } from 'drizzle-orm';

import { db } from '../database/db.js';
import { diagnosticsSnapshots } from '../database/schema.js';
import { getSuperadminUserId, listEmployeesAuth } from './employeeAuthService.js';
import { logError, logInfo } from '../utils/logger.js';

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 1000;

const STATE_SCOPE = 'ai_agent_chat_state';
const CHAT_SCOPE = 'ai_agent_chat_corpus';
const OLLAMA_MODEL_CHAT = process.env.OLLAMA_MODEL_CHAT || process.env.OLLAMA_MODEL || 'qwen3:8b';

type ChatRow = {
  id: string;
  sender_user_id: string;
  sender_username: string;
  recipient_user_id: string | null;
  message_type: string;
  body_text: string | null;
  payload_json: string | null;
  created_at: number;
};

let roPool: Pool | null = null;
let roPoolInitError = false;

function nowMs() {
  return Date.now();
}

function truncate(text: string, max = 1000) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function getReadonlyPool(): Pool | null {
  if (roPool) return roPool;
  if (roPoolInitError) return null;
  const user = process.env.OLLAMA_DB_RO_USER;
  const password = process.env.OLLAMA_DB_RO_PASSWORD;
  const database = process.env.PGDATABASE;
  if (!user || !password || !database) {
    roPoolInitError = true;
    logError('ai chat learning disabled: missing read-only DB env', {
      missingUser: !user,
      missingPassword: !password,
      missingDatabase: !database,
    });
    return null;
  }
  const host = process.env.PGHOST ?? 'localhost';
  const port = Number(process.env.PGPORT ?? 5432);
  roPool = new Pool({
    host,
    port,
    user,
    password,
    database,
    max: 2,
    idleTimeoutMillis: 10_000,
  });
  return roPool;
}

async function getUserIdByLogin(login: string) {
  const list = await listEmployeesAuth().catch(() => null);
  if (!list || !list.ok) return null;
  const target = String(login ?? '').trim().toLowerCase();
  const row = list.rows.find((r) => String(r.login ?? '').trim().toLowerCase() === target);
  return row?.id ? String(row.id) : null;
}

async function getLastSeenAt(): Promise<number | null> {
  const rows = await db
    .select({ payload: diagnosticsSnapshots.payloadJson, createdAt: diagnosticsSnapshots.createdAt })
    .from(diagnosticsSnapshots)
    .where(eq(diagnosticsSnapshots.scope, STATE_SCOPE))
    .orderBy(desc(diagnosticsSnapshots.createdAt))
    .limit(1);
  const payloadRaw = rows[0]?.payload ?? null;
  if (!payloadRaw) return null;
  try {
    const parsed = JSON.parse(String(payloadRaw));
    const last = Number(parsed?.lastSeenAt ?? NaN);
    return Number.isFinite(last) ? last : null;
  } catch {
    return null;
  }
}

async function saveState(lastSeenAt: number) {
  const ts = nowMs();
  await db.insert(diagnosticsSnapshots).values({
    id: randomUUID(),
    scope: STATE_SCOPE,
    clientId: null,
    payloadJson: JSON.stringify({ lastSeenAt }),
    createdAt: ts,
  });
}

async function storeChatSnapshot(payload: unknown) {
  const ts = nowMs();
  await db.insert(diagnosticsSnapshots).values({
    id: randomUUID(),
    scope: CHAT_SCOPE,
    clientId: null,
    payloadJson: JSON.stringify(payload ?? {}),
    createdAt: ts,
  });
}

async function loadChatMessages(sinceMs: number, windowStartMs: number, limit: number) {
  const pool = getReadonlyPool();
  if (!pool) return [];
  const res = await pool.query(
    `select id, sender_user_id, sender_username, recipient_user_id, message_type, body_text, payload_json, created_at
       from chat_messages
      where deleted_at is null
        and created_at > $1
        and created_at >= $2
      order by created_at asc
      limit $3`,
    [sinceMs, windowStartMs, limit],
  );
  return (res.rows ?? []) as ChatRow[];
}

function normalizeMessage(row: ChatRow) {
  return {
    id: String(row.id),
    senderUserId: String(row.sender_user_id),
    senderUsername: String(row.sender_username),
    recipientUserId: row.recipient_user_id == null ? null : String(row.recipient_user_id),
    messageType: String(row.message_type),
    bodyText: row.body_text == null ? null : truncate(row.body_text, 1500),
    payloadJson: row.payload_json == null ? null : truncate(row.payload_json, 2000),
    createdAt: Number(row.created_at),
  };
}

export function startAiAgentChatLearningService() {
  const enabled = String(process.env.AI_CHAT_LEARNING_ENABLED ?? 'true').toLowerCase() === 'true';
  if (!enabled) return;
  const intervalMs = Number(process.env.AI_CHAT_LEARNING_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const windowHours = Number(process.env.AI_CHAT_LEARNING_WINDOW_HOURS ?? DEFAULT_WINDOW_HOURS);
  const limit = Number(process.env.AI_CHAT_LEARNING_LIMIT ?? DEFAULT_LIMIT);

  const tick = async () => {
    try {
      const windowMs = Number.isFinite(windowHours) && windowHours > 0 ? windowHours * 60 * 60_000 : DEFAULT_WINDOW_HOURS * 60 * 60_000;
      const windowStart = nowMs() - windowMs;
      const lastSeen = (await getLastSeenAt()) ?? windowStart;
      const effectiveSince = Math.max(lastSeen, windowStart);
      const rows = await loadChatMessages(effectiveSince, windowStart, Number.isFinite(limit) ? limit : DEFAULT_LIMIT);
      if (!rows.length) return;

      const aiAgentId = await getUserIdByLogin('ai-agent');
      const superadminId = await getSuperadminUserId();
      const messages = rows.map(normalizeMessage);
      const lastRow = messages[messages.length - 1];
      const payload = {
        windowStart,
        windowEnd: nowMs(),
        aiAgentUserId: aiAgentId,
        superadminUserId: superadminId,
        model: OLLAMA_MODEL_CHAT,
        channel: 'chat',
        messages,
      };
      await storeChatSnapshot(payload);
      if (lastRow?.createdAt) {
        await saveState(lastRow.createdAt);
      }
      logInfo('ai chat learning snapshot saved', { count: messages.length, lastSeenAt: lastRow?.createdAt ?? null });
    } catch (e) {
      logError('ai chat learning failed', { error: String(e) });
    }
  };

  void tick();
  setInterval(() => void tick(), Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS);
}
