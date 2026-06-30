import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type {
  AiAgentAssistRequest,
  AiAgentAssistResponse,
  AiAgentConversationDeleteResponse,
  AiAgentConversationMessagesResponse,
  AiAgentConversationSearchResponse,
  AiAgentConversationsListResponse,
  AiAgentLogRequest,
  AiAgentLogResponse,
  AiAgentStreamEvent,
} from '@matricarmz/shared';

import { authRefresh, clearSession, getSession } from './authService.js';
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
    const conversationId = typeof j.conversationId === 'string' ? j.conversationId : undefined;
    return { ok: true, reply: j.reply, ...(conversationId ? { conversationId } : {}) };
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

export async function aiAgentConversationsList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { limit?: number },
): Promise<AiAgentConversationsListResponse> {
  try {
    const limit = args?.limit ? `?limit=${Math.max(1, Math.min(Math.floor(args.limit), 200))}` : '';
    const r = await httpAuthed(db, apiBaseUrl, `/ai/conversations${limit}`, { method: 'GET' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok) return { ok: false, error: 'bad response' };
    return { ok: true, items: Array.isArray(j.items) ? j.items : [] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function aiAgentConversationMessages(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { conversationId: string; limit?: number },
): Promise<AiAgentConversationMessagesResponse> {
  try {
    const qs = args?.limit ? `?limit=${Math.max(1, Math.min(Math.floor(args.limit), 1000))}` : '';
    const r = await httpAuthed(db, apiBaseUrl, `/ai/conversations/${encodeURIComponent(args.conversationId)}${qs}`, { method: 'GET' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok) return { ok: false, error: 'bad response' };
    const messages = Array.isArray(j.messages)
      ? j.messages.map((m: any) => ({
          id: String(m.id),
          conversationId: String(m.conversationId ?? args.conversationId),
          role: m.role,
          content: String(m.content ?? ''),
          model: m.model ?? null,
          inputTokens: m.inputTokens ?? null,
          outputTokens: m.outputTokens ?? null,
          ts: Number(m.ts ?? 0),
        }))
      : [];
    return { ok: true, conversationId: String(j.conversationId ?? args.conversationId), messages };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function aiAgentConversationDelete(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { conversationId: string },
): Promise<AiAgentConversationDeleteResponse> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, `/ai/conversations/${encodeURIComponent(args.conversationId)}`, { method: 'DELETE' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok) return { ok: false, error: 'bad response' };
    return { ok: true, removed: Number(j.removed ?? 0) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function aiAgentConversationSearch(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { conversationId: string; query: string; limit?: number },
): Promise<AiAgentConversationSearchResponse> {
  try {
    const r = await httpAuthed(db, apiBaseUrl, `/ai/conversations/${encodeURIComponent(args.conversationId)}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: args.query, ...(args.limit ? { limit: args.limit } : {}) }),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = r.json as any;
    if (!j?.ok) return { ok: false, error: 'bad response' };
    const items = Array.isArray(j.items)
      ? j.items.map((m: any) => ({
          id: String(m.id),
          conversationId: String(m.conversationId ?? args.conversationId),
          role: m.role,
          content: String(m.content ?? ''),
          model: m.model ?? null,
          inputTokens: m.inputTokens ?? null,
          outputTokens: m.outputTokens ?? null,
          ts: Number(m.ts ?? 0),
        }))
      : [];
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function joinUrl(base: string, path: string) {
  const b = String(base ?? '').trim().replace(/\/+$/, '');
  const p = String(path ?? '').trim().replace(/^\/+/, '');
  return `${b}/${p}`;
}

export async function aiAgentAssistStream(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: AiAgentAssistRequest,
  onEvent: (ev: AiAgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<AiAgentAssistResponse> {
  let session = await getSession(db).catch(() => null);
  if (!session?.accessToken) return { ok: false, error: 'auth required' };

  const doFetch = async (token: string): Promise<Response> => {
    return await fetch(joinUrl(apiBaseUrl, '/ai/assist?stream=1'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args ?? {}),
      ...(signal ? { signal } : {}),
    });
  };

  let response: Response;
  try {
    response = await doFetch(session.accessToken);
    if ((response.status === 401 || response.status === 403) && session.refreshToken) {
      const refreshed = await authRefresh(db, { apiBaseUrl, refreshToken: session.refreshToken });
      if (!refreshed.ok) {
        await clearSession(db).catch(() => {});
        return { ok: false, error: `HTTP ${response.status}` };
      }
      session = { ...session, accessToken: refreshed.accessToken };
      response = await doFetch(session.accessToken);
    }
    if (!response.ok || !response.body) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  let finalReply: AiAgentAssistResponse = { ok: false, error: 'stream ended without final event' };
  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evLine = /^event:\s*(.+)$/m.exec(block);
        const dataLine = /^data:\s*(.+)$/m.exec(block);
        if (!evLine || !dataLine) continue;
        const eventName = evLine[1]?.trim() ?? '';
        const data = dataLine[1]?.trim() ?? '';
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (eventName === 'final') {
          finalReply = {
            ok: true,
            reply: parsed.reply,
            ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
          };
          onEvent({
            type: 'final',
            conversationId: String(parsed.conversationId ?? ''),
            reply: parsed.reply,
            model: String(parsed.model ?? ''),
            ...(parsed.escalated ? { escalated: true } : {}),
            ...(typeof parsed.inputTokens === 'number' ? { inputTokens: parsed.inputTokens } : {}),
            ...(typeof parsed.outputTokens === 'number' ? { outputTokens: parsed.outputTokens } : {}),
          });
        } else if (eventName === 'start') {
          onEvent({ type: 'start', conversationId: String(parsed.conversationId ?? '') });
        } else if (eventName === 'text' && typeof parsed.delta === 'string') {
          onEvent({ type: 'text', delta: parsed.delta });
        } else if (eventName === 'tool_use') {
          onEvent({ type: 'tool_use', id: parsed.id, name: parsed.name, input: parsed.input ?? {} });
        } else if (eventName === 'tool_result') {
          onEvent({
            type: 'tool_result',
            toolUseId: parsed.toolUseId,
            toolName: parsed.toolName,
            content: String(parsed.content ?? ''),
            ...(parsed.isError ? { isError: true } : {}),
          });
        } else if (eventName === 'step_done') {
          onEvent({ type: 'step_done', step: Number(parsed.step ?? 0), stopReason: parsed.stopReason ?? null });
        } else if (eventName === 'error') {
          finalReply = { ok: false, error: String(parsed.error ?? 'stream error') };
          onEvent({ type: 'error', error: String(parsed.error ?? 'stream error') });
        }
      }
    }
    onEvent({ type: 'done' });
    return finalReply;
  } catch (e) {
    onEvent({ type: 'error', error: String(e) });
    return { ok: false, error: String(e) };
  }
}
