/**
 * HTTP-клиент своего opencode serve (D10, слайс 2). Формы — с живого бинаря
 * v1.19.0 (его же веб-клиент, сверено 14.10.2026): create/prompt/delete/message.
 * Транспорт — напрямую из main на loopback, не релеем (релей для LAN-пиров).
 * Без бросков: все функции возвращают {ok, ...}.
 */

export const OPENCODE_SESSION_API_TIMEOUT_MS = 30_000;

export type OpencodeSessionRef = { id: string; title?: string | null };
export type OpencodeMessage = { id?: string; role?: string; [key: string]: unknown };
export type FetchImpl = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

const defaultFetch: FetchImpl = (url, init) => fetch(url, init) as unknown as ReturnType<FetchImpl>;

function baseOf(baseUrl?: string): string {
  const base = String(baseUrl ?? 'http://127.0.0.1:3080').trim().replace(/\/+$/, '');
  return base || 'http://127.0.0.1:3080';
}

async function callJson(
  fetchImpl: FetchImpl,
  baseUrl: string | undefined,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true; status: number; json: unknown } | { ok: false; error: string; status?: number }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), OPENCODE_SESSION_API_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseOf(baseUrl)}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false as const, error: `serve ${res.status}`, status: res.status };
    return { ok: true as const, status: res.status, json: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false as const, error: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

function asSessionRef(json: unknown): OpencodeSessionRef | null {
  const data = (json as { data?: unknown })?.data ?? json;
  const id = String((data as { id?: unknown })?.id ?? '').trim();
  if (!id) return null;
  return { id, title: String((data as { title?: unknown })?.title ?? '') || null };
}

/** Создать сессию (агент/модель — дефолт serve, бесплатная облачная модель раздачи). */
export async function createOpencodeSession(
  opts: { baseUrl?: string; agent?: string; model?: string; fetchImpl?: FetchImpl } = {},
): Promise<{ ok: true; session: OpencodeSessionRef } | { ok: false; error: string }> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const body: Record<string, unknown> = {};
  if (opts.agent) body.agent = opts.agent;
  if (opts.model) body.model = opts.model;
  const r = await callJson(fetchImpl, opts.baseUrl, 'POST', '/api/session', body);
  if (!r.ok) return r;
  const session = asSessionRef(r.json);
  return session ? { ok: true, session } : { ok: false, error: 'serve не вернул id сессии' };
}

/** Прочитать сессию; 404 — нет такой (удалена/свежая база) — это {ok, session: null}. */
export async function getOpencodeSession(
  sessionId: string,
  opts: { baseUrl?: string; fetchImpl?: FetchImpl } = {},
): Promise<{ ok: true; session: OpencodeSessionRef | null } | { ok: false; error: string }> {
  const id = String(sessionId ?? '').trim();
  if (!id) return { ok: false, error: 'Укажите id сессии' };
  const r = await callJson(opts.fetchImpl ?? defaultFetch, opts.baseUrl, 'GET', `/api/session/${encodeURIComponent(id)}`);
  if (!r.ok) {
    if (r.status === 404) return { ok: true, session: null };
    return r;
  }
  return { ok: true, session: asSessionRef(r.json) };
}

/** Удалить сессию; отсутствие — тоже успех (идемпотентно). */
export async function deleteOpencodeSession(
  sessionId: string,
  opts: { baseUrl?: string; fetchImpl?: FetchImpl } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = String(sessionId ?? '').trim();
  if (!id) return { ok: false, error: 'Укажите id сессии' };
  const r = await callJson(opts.fetchImpl ?? defaultFetch, opts.baseUrl, 'DELETE', `/api/session/${encodeURIComponent(id)}`);
  if (!r.ok && r.status !== 404) return r;
  return { ok: true };
}

/**
 * Вопрос в сессию (форма — из веб-клиента бинаря). Ответ приходит асинхронно
 * (обработка — дальше, чтение — messages/event): здесь возвращается только
 * принятое сообщение. Живой прогон с моделью — слайс 3.
 */
export async function promptOpencodeSession(
  sessionId: string,
  text: string,
  opts: { baseUrl?: string; fetchImpl?: FetchImpl } = {},
): Promise<{ ok: true; message: unknown } | { ok: false; error: string }> {
  const id = String(sessionId ?? '').trim();
  const body = String(text ?? '').trim();
  if (!id) return { ok: false, error: 'Укажите id сессии' };
  if (!body) return { ok: false, error: 'Пустой вопрос' };
  const r = await callJson(opts.fetchImpl ?? defaultFetch, opts.baseUrl, 'POST', `/api/session/${encodeURIComponent(id)}/prompt`, {
    text: body,
  });
  if (!r.ok) return r;
  return { ok: true, message: (r.json as { data?: unknown })?.data ?? r.json };
}

/** Сообщения сессии (ответы читаются отсюда; стриминга здесь нет — он в /event). */
export async function listOpencodeMessages(
  sessionId: string,
  opts: { baseUrl?: string; limit?: number; fetchImpl?: FetchImpl } = {},
): Promise<{ ok: true; messages: OpencodeMessage[] } | { ok: false; error: string }> {
  const id = String(sessionId ?? '').trim();
  if (!id) return { ok: false, error: 'Укажите id сессии' };
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? `?limit=${Math.floor(Number(opts.limit))}` : '';
  const r = await callJson(
    opts.fetchImpl ?? defaultFetch,
    opts.baseUrl,
    'GET',
    `/api/session/${encodeURIComponent(id)}/message${limit}`,
  );
  if (!r.ok) return r;
  const data = (r.json as { data?: unknown })?.data ?? r.json;
  return { ok: true, messages: Array.isArray(data) ? (data as OpencodeMessage[]) : [] };
}

/** Прервать выполняющийся ответ. */
export async function interruptOpencodeSession(
  sessionId: string,
  opts: { baseUrl?: string; fetchImpl?: FetchImpl } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = String(sessionId ?? '').trim();
  if (!id) return { ok: false, error: 'Укажите id сессии' };
  const r = await callJson(opts.fetchImpl ?? defaultFetch, opts.baseUrl, 'POST', `/api/session/${encodeURIComponent(id)}/interrupt`);
  if (!r.ok) return r;
  return { ok: true };
}
