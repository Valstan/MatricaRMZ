import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type {
  AiAgentAssistRequest,
  AiAgentAssistResponse,
  AiAgentLogRequest,
  AiAgentLogResponse,
  AiAgentOllamaHealthRequest,
  AiAgentOllamaHealthResponse,
} from '@matricarmz/shared';

import { httpAuthed } from './httpClient.js';

export async function aiAgentAssist(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: AiAgentAssistRequest,
): Promise<AiAgentAssistResponse> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, '/ai/assist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok || !j?.reply) return { ok: false, error: 'bad response' };
    return { ok: true, reply: j.reply };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function aiAgentLogEvent(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: AiAgentLogRequest,
): Promise<AiAgentLogResponse> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, '/ai/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok) return { ok: false, error: 'bad response' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function aiAgentOllamaHealth(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: AiAgentOllamaHealthRequest,
): Promise<AiAgentOllamaHealthResponse> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, '/ai/ollama-health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j || typeof j.ok !== 'boolean') return { ok: false, error: 'bad response' };
    return j as AiAgentOllamaHealthResponse;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
