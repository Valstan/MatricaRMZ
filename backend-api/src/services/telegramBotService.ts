import { logWarn } from '../utils/logger.js';

const MAX_TEXT_LEN = 4000;
const DEFAULT_ATTEMPTS = 6;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 8_000;
let missingTokenWarned = false;
const loginToChatIdCache = new Map<string, string>();

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/**
 * Глобальное включение интеграции с Telegram (api.telegram.org).
 * При `false` не выполняются опрос getUpdates и отправка сообщений — без лишней нагрузки при блокировке сети.
 * По умолчанию `true` (обратная совместимость).
 */
export function isTelegramIntegrationEnabled(): boolean {
  return parseBoolEnv(process.env.MATRICA_TELEGRAM_ENABLED, true);
}

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : fallback;
}

// Сеть хостера теряет около половины SYN к диапазонам Telegram (замер 04.09.2026: 11/20 и 13/20 на двух
// боксах myjino), остальной интернет и ICMP целы, а установленное соединение живёт нормально. Поэтому
// лечение — короткая попытка и повтор, а не смена адреса: HTTP-ответ любого кода повтора не требует.
async function telegramFetch(url: string, init?: RequestInit, extraTimeoutMs = 0): Promise<Response> {
  const attempts = positiveIntEnv('MATRICA_TELEGRAM_ATTEMPTS', DEFAULT_ATTEMPTS);
  const timeoutMs = positiveIntEnv('MATRICA_TELEGRAM_ATTEMPT_TIMEOUT_MS', DEFAULT_ATTEMPT_TIMEOUT_MS) + extraTimeoutMs;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastError = e;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw new Error(`telegram unreachable after ${attempts} attempts: ${String(lastError)}`);
}

function normalizeLogin(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  return value.startsWith('@') ? value : `@${value}`;
}

function getToken(): string | null {
  if (!isTelegramIntegrationEnabled()) return null;
  const token = String(process.env.MATRICA_TELEGRAM_BOT_TOKEN ?? '').trim();
  if (token) return token;
  if (!missingTokenWarned) {
    missingTokenWarned = true;
    logWarn('telegram bot token is missing; delivery disabled');
  }
  return null;
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_LEN) return text;
  return text.slice(0, MAX_TEXT_LEN - 1) + '…';
}

function normalizeUserLogin(raw: string): string {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  return value.startsWith('@') ? value : `@${value}`;
}

async function fetchUpdatesInternal(args?: { offset?: number; limit?: number; timeoutSec?: number }) {
  if (!isTelegramIntegrationEnabled()) {
    return { ok: true as const, updates: [] as any[] };
  }
  const token = getToken();
  if (!token) return { ok: false as const, error: 'токен не указан' };
  const offset = Number(args?.offset ?? 0);
  const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 20)));
  const timeoutSec = Math.max(0, Math.min(30, Number(args?.timeoutSec ?? 0)));
  const qs = new URLSearchParams({
    offset: Number.isFinite(offset) ? String(Math.trunc(offset)) : '0',
    limit: String(Math.trunc(limit)),
    timeout: String(Math.trunc(timeoutSec)),
  });
  try {
    const r = await telegramFetch(`https://api.telegram.org/bot${token}/getUpdates?${qs.toString()}`, undefined, timeoutSec * 1000);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false as const, error: `telegram HTTP ${r.status}: ${t || 'нет тела ответа'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok || !Array.isArray(json?.result)) {
      return { ok: false as const, error: 'ответ Telegram некорректен' };
    }
    return { ok: true as const, updates: json.result as any[] };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

function hydrateLoginCacheFromUpdates(updates: any[]) {
  for (const upd of updates ?? []) {
    const from = upd?.message?.from ?? upd?.callback_query?.from ?? null;
    const chatId = upd?.message?.chat?.id ?? upd?.callback_query?.message?.chat?.id ?? null;
    const username = normalizeUserLogin(from?.username ?? '');
    if (!username || chatId == null) continue;
    loginToChatIdCache.set(username, String(chatId));
  }
}

export function getCachedChatIdByLogin(rawLogin: string) {
  const normalized = normalizeUserLogin(rawLogin);
  if (!normalized) return null;
  return loginToChatIdCache.get(normalized) ?? null;
}

async function resolveChatIdByLogin(login: string): Promise<string | null> {
  if (!isTelegramIntegrationEnabled()) return null;
  const normalized = normalizeUserLogin(login);
  if (!normalized) return null;
  const cached = loginToChatIdCache.get(normalized);
  if (cached) return cached;
  const updates = await fetchUpdatesInternal({ limit: 100, timeoutSec: 0 });
  if (!updates.ok) return null;
  hydrateLoginCacheFromUpdates(updates.updates);
  return loginToChatIdCache.get(normalized) ?? null;
}

export async function sendTelegramMessage(args: { toLogin: string; text: string; replyMarkup?: unknown }) {
  if (!isTelegramIntegrationEnabled()) {
    return { ok: false as const, error: 'Telegram отключён (MATRICA_TELEGRAM_ENABLED=false)' };
  }
  const token = getToken();
  if (!token) return { ok: false as const, error: 'токен не указан' };
  const normalizedLogin = normalizeLogin(args.toLogin);
  const chatId = normalizedLogin;
  if (!chatId) return { ok: false as const, error: 'логин пользователя не указан' };

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: truncateText(String(args.text ?? '')),
  };
  if (args.replyMarkup) body.reply_markup = args.replyMarkup;

  try {
    const r = await telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const rawErr = `telegram HTTP ${r.status}: ${t || 'нет тела ответа'}`;
      // Telegram does not allow direct send to arbitrary user @username.
      // If bot already saw user updates (/start), resolve chat_id and retry.
      if (rawErr.includes('chat not found') && normalizedLogin) {
        const resolvedChatId = await resolveChatIdByLogin(normalizedLogin);
        if (resolvedChatId) {
          const retryBody: Record<string, unknown> = { ...body, chat_id: resolvedChatId };
          const rr = await telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(retryBody),
          });
          if (rr.ok) {
            const retryJson = (await rr.json().catch(() => null)) as any;
            if (retryJson?.ok) return { ok: true as const };
          }
        }
      }
      return { ok: false as const, error: rawErr };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok) return { ok: false as const, error: 'ответ Telegram некорректен' };
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function sendTelegramMessageToChat(args: { chatId: string | number; text: string; replyMarkup?: unknown }) {
  if (!isTelegramIntegrationEnabled()) {
    return { ok: false as const, error: 'Telegram отключён (MATRICA_TELEGRAM_ENABLED=false)' };
  }
  const token = getToken();
  if (!token) return { ok: false as const, error: 'токен не указан' };
  const chatId = String(args.chatId ?? '').trim();
  if (!chatId) return { ok: false as const, error: 'идентификатор чата не указан' };
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: truncateText(String(args.text ?? '')),
  };
  if (args.replyMarkup) body.reply_markup = args.replyMarkup;
  try {
    const r = await telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false as const, error: `telegram HTTP ${r.status}: ${t || 'нет тела ответа'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok) return { ok: false as const, error: 'ответ Telegram некорректен' };
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function answerTelegramCallbackQuery(args: { callbackQueryId: string; text?: string }) {
  if (!isTelegramIntegrationEnabled()) {
    return { ok: false as const, error: 'Telegram отключён (MATRICA_TELEGRAM_ENABLED=false)' };
  }
  const token = getToken();
  if (!token) return { ok: false as const, error: 'токен не указан' };
  const callbackQueryId = String(args.callbackQueryId ?? '').trim();
  if (!callbackQueryId) return { ok: false as const, error: 'идентификатор callback-запроса не указан' };
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };
  if (args.text) body.text = String(args.text).trim();
  try {
    const r = await telegramFetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false as const, error: `telegram HTTP ${r.status}: ${t || 'нет тела ответа'}` };
    }
    const json = (await r.json().catch(() => null)) as any;
    if (!json?.ok) return { ok: false as const, error: 'ответ Telegram некорректен' };
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

export async function fetchTelegramUpdates(args?: { offset?: number; limit?: number; timeoutSec?: number }) {
  const res = await fetchUpdatesInternal(args);
  if (res.ok) hydrateLoginCacheFromUpdates(res.updates);
  return res;
}

export function formatTelegramMessage(bodyText: string, senderName: string) {
  const text = String(bodyText ?? '').trim();
  const sender = String(senderName ?? '').trim() || 'Пользователь';
  return `${text}\n\n— ${sender}`;
}
