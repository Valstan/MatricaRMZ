// HTTP-клиент relay Телефона (Ф1, мандат 2026-10-05, D-111).
// Контракт — karman docs/hotline-relay.md (код: karman/app/api/hotline/route.ts,
// presence/route.ts, lib/hotline/service.ts):
//   POST /api/hotline {from,room,kind,text} + Bearer → 201 {id, created_at}
//   GET  /api/hotline?room=&since_id=&limit= → 200 {messages: [{id,room,sender,kind,text,createdAt}]}
//   POST /api/hotline/presence {label, alive_minutes} → 201
//   GET  /api/hotline/presence → 200 {presence: [{label, aliveUntil, updatedAt}]}
// Секреты — только env HOTLINE_RELAY_SECRET / HOTLINE_RELAY_URL (те же имена,
// что у hotline.sh), в репо их нет и быть не должно.

import { logWarn } from '../../utils/logger.js';

export type HotlineKind = 'question' | 'answer' | 'done' | 'ping' | 'wakeup' | 'ack';

export type HotlineMessage = {
  id: number;
  room: string;
  sender: string;
  kind: string;
  text: string;
  createdAt: string;
};

export type HotlinePresenceEntry = {
  label: string;
  aliveUntil: string;
  updatedAt: string;
};

type RelayError = { ok: false; error: string; retryable: boolean };

const FETCH_TIMEOUT_MS = 15_000;

function secret(): string | null {
  const v = String(process.env.HOTLINE_RELAY_SECRET ?? '').trim();
  return v ? v : null;
}

function baseUrl(): string | null {
  const v = String(process.env.HOTLINE_RELAY_URL ?? '').trim().replace(/\/+$/, '');
  return v ? v : null;
}

/** Relay настроен (секрет + URL на месте). Без него мост — честный no-op. */
export function isHotlineRelayConfigured(): boolean {
  return secret() !== null && baseUrl() !== null;
}

async function relayFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any } | RelayError> {
  const sec = secret();
  const base = baseUrl();
  if (!sec || !base) return { ok: false, error: 'hotline relay не настроен (нет секрета/URL)', retryable: false };
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(`${base}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${sec}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const json = await resp.json().catch(() => null);
      return { status: resp.status, json };
    } catch (e) {
      lastError = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  return { ok: false, error: `hotline relay недоступен: ${String(lastError)}`, retryable: true };
}

function httpError(status: number, what: string): RelayError {
  if (status === 400) return { ok: false, error: `${what}: relay отклонил запрос (400)`, retryable: false };
  if (status === 401) return { ok: false, error: `${what}: чужой секрет (401)`, retryable: false };
  if (status === 503) return { ok: false, error: `${what}: relay не настроен (503)`, retryable: false };
  if (status === 429) return { ok: false, error: `${what}: rate limit (429)`, retryable: true };
  return { ok: false, error: `${what}: HTTP ${status}`, retryable: status >= 500 };
}

export async function relayPost(args: {
  room: string;
  kind: HotlineKind;
  text: string;
}): Promise<{ ok: true; id: number } | RelayError> {
  const res = await relayFetch('POST', 'api/hotline', { from: 'MatricaRMZ', ...args });
  if ('ok' in res && !res.ok) return res;
  const { status, json } = res as { status: number; json: any };
  if (status !== 201) return httpError(status, 'POST /api/hotline');
  const id = Number(json?.id);
  if (!Number.isFinite(id)) return { ok: false, error: 'POST /api/hotline: нет id в ответе', retryable: false };
  return { ok: true, id };
}

export async function relayRead(args: {
  room: string;
  sinceId?: number;
  limit?: number;
}): Promise<{ ok: true; messages: HotlineMessage[] } | RelayError> {
  const q = new URLSearchParams({ room: args.room });
  if (args.sinceId !== undefined) q.set('since_id', String(args.sinceId));
  q.set('limit', String(args.limit ?? 100));
  const res = await relayFetch('GET', `api/hotline?${q.toString()}`);
  if ('ok' in res && !res.ok) return res;
  const { status, json } = res as { status: number; json: any };
  if (status !== 200) return httpError(status, 'GET /api/hotline');
  const messages = Array.isArray(json?.messages) ? json.messages : null;
  if (!messages) return { ok: false, error: 'GET /api/hotline: нет messages в ответе', retryable: false };
  return { ok: true, messages: messages as HotlineMessage[] };
}

export async function relayPresence(): Promise<{ ok: true; presence: HotlinePresenceEntry[] } | RelayError> {
  const res = await relayFetch('GET', 'api/hotline/presence');
  if ('ok' in res && !res.ok) return res;
  const { status, json } = res as { status: number; json: any };
  if (status !== 200) return httpError(status, 'GET /api/hotline/presence');
  const presence = Array.isArray(json?.presence) ? json.presence : null;
  if (!presence) return { ok: false, error: 'GET /api/hotline/presence: нет presence в ответе', retryable: false };
  return { ok: true, presence: presence as HotlinePresenceEntry[] };
}

export function logRelayError(where: string, err: RelayError): void {
  logWarn(`hotline relay: ${where}: ${err.error}`);
}
