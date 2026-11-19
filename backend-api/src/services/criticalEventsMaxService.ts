/**
 * Рассылка критических событий в МАКС (мессенджер MAX) — второй внешний канал
 * рядом с Telegram.
 *
 * Зачем: Telegram-алерт владельцу работает, но увести тревогу ещё и в МАКС — значит
 * застать её на том телефоне, где владелец сидит в этот момент. Канал включается
 * ТОЛЬКО когда задан токен бота и адресат: без них модуль — честный no-op, и
 * программа в остальном не меняется.
 *
 * Контракт MAX Bot API (dev.max.ru):
 *   POST https://platform-api2.max.ru/messages?chat_id={chat_id}
 *   (или ?user_id={user_id} — личный диалог)
 *   Authorization: {access_token}   ← токен бота, без Bearer
 *   {"text": "..."}
 * Ограничения платформы: не больше 2 сообщений в секунду в один диалог и 30 rps
 * на бота — поэтому отправки выстроены в очередь с минимальным интервалом.
 *
 * Токен бота кладёт владелец в комнату КАРМАНА (как остальные секреты) либо в
 * `/etc/matricarmz/matricarmz.env` на боксе — в репозитории его быть не должно.
 */
import { listCriticalEvents, type CriticalEventRecord } from './criticalEventsService.js';
import { shouldAlertEvent, formatEvent } from './criticalEventsTelegramService.js';
import { getInstanceRole, shouldRunBackgroundJobs } from './instanceRole.js';
import { logInfo, logWarn } from '../utils/logger.js';

const MAX_API_BASE = 'https://platform-api2.max.ru';
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TZ = 'Europe/Moscow';
const LOOKBACK_DAYS = 3;
/** Минимальный интервал между отправками: платформа разрешает 2 в секунду, берём 600 мс. */
const MIN_SEND_GAP_MS = 600;
/** Не чаще N сообщений по одному коду события за окно (анти-флуд). */
const DEFAULT_MAX_PER_CODE_WINDOW = 3;
/** Окно анти-флуда по коду события, мс. */
const DEFAULT_CODE_WINDOW_MS = 10 * 60_000;

function envText(name: string): string {
  return String(process.env[name] ?? '').trim();
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return value !== 'false' && value !== '0' && value !== 'no' && value !== 'off';
}

function parseNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function token(): string | null {
  const value = envText('MATRICA_MAX_ALERT_TOKEN');
  return value ? value : null;
}

/** Адресат: групповой чат (chat_id) либо личный диалог (user_id). */
function target(): { kind: 'chat' | 'user'; value: string } | null {
  const chatId = envText('MATRICA_MAX_ALERT_CHAT_ID');
  if (chatId) return { kind: 'chat', value: chatId };
  const userId = envText('MATRICA_MAX_ALERT_USER_ID');
  if (userId) return { kind: 'user', value: userId };
  return null;
}

/** Канал МАКС настроен (токен и адресат на месте). Без него — честный no-op. */
export function isMaxAlertConfigured(): boolean {
  return token() !== null && target() !== null;
}

let lastSentAt = 0;

/**
 * Отправить сообщение в МАКС.
 *
 * `ok: false` без попытки — если канал не настроен: это не ошибка, а «канала нет».
 * Иначе — результат ответа платформы (401 — токен неверен, 403 — бота заблокировали).
 */
export async function sendMaxAlert(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const accessToken = token();
  const to = target();
  if (!accessToken || !to) return { ok: false, error: 'канал МАКС не настроен (нет токена/адресата)' };
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: 'пустое сообщение' };

  // Платформа: не больше 2 сообщений в секунду в один диалог.
  const wait = MIN_SEND_GAP_MS - (Date.now() - lastSentAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  const query = to.kind === 'chat' ? `chat_id=${encodeURIComponent(to.value)}` : `user_id=${encodeURIComponent(to.value)}`;
  try {
    const resp = await fetch(`${MAX_API_BASE}/messages?${query}`, {
      method: 'POST',
      headers: {
        Authorization: accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: body }),
      signal: AbortSignal.timeout(15_000),
    });
    lastSentAt = Date.now();
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return { ok: false, error: `MAX HTTP ${resp.status}: ${detail.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `MAX недоступен: ${String(e)}` };
  }
}

/**
 * Рассылка критических событий в МАКС — тот же отбор, что у Telegram (категории и
 * уровень задаются своими переменными), но свой счётчик отправок: каналы живут
 * независимо, и поломка одного не должна глушить другой.
 */
let started = false;

export function startCriticalEventsMaxService() {
  const instanceRole = getInstanceRole();
  if (!shouldRunBackgroundJobs(instanceRole)) {
    logInfo('critical events MAX notifier skipped on non-primary instance', { instanceRole: instanceRole || 'primary' }, { critical: true });
    return;
  }
  if (started) return;
  if (!isMaxAlertConfigured()) {
    logInfo('critical events MAX notifier disabled (нет MATRICA_MAX_ALERT_TOKEN/адресата)', {}, { critical: true });
    return;
  }
  if (!parseBool(process.env.MATRICA_CRITICAL_MAX_ENABLED, true)) {
    logInfo('critical events MAX notifier disabled (MATRICA_CRITICAL_MAX_ENABLED=false)', {}, { critical: true });
    return;
  }

  started = true;
  const pollMs = parseNumber(process.env.MATRICA_CRITICAL_MAX_POLL_MS, DEFAULT_POLL_MS, 3_000, 600_000);
  const errorEnabled = parseBool(process.env.MATRICA_CRITICAL_MAX_ERROR_ENABLED, true);
  const errorCategories = parseCategorySet(process.env.MATRICA_CRITICAL_MAX_ERROR_CATEGORIES);
  const codeWindowMs = parseNumber(process.env.MATRICA_CRITICAL_MAX_CODE_WINDOW_MS, DEFAULT_CODE_WINDOW_MS, 60_000, 3_600_000);
  const maxPerCodeWindow = parseNumber(
    process.env.MATRICA_CRITICAL_MAX_PER_CODE_WINDOW,
    DEFAULT_MAX_PER_CODE_WINDOW,
    1,
    50,
  );
  const seen = new Set<string>();
  const codeSentAt = new Map<string, number[]>();

  for (const event of listCriticalEvents({ days: LOOKBACK_DAYS, limit: 1000 })) {
    if (shouldAlertEvent(event, { errorEnabled, errorCategories })) seen.add(event.id);
  }

  const tick = async () => {
    try {
      const events = listCriticalEvents({ days: LOOKBACK_DAYS, limit: 1000 })
        .filter((event) => shouldAlertEvent(event, { errorEnabled, errorCategories }) && !seen.has(event.id))
        .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
      if (events.length === 0) return;

      for (const event of events.slice(0, 20)) {
        const now = Date.now();
        const codeKey = String(event.eventCode ?? '');
        const times = (codeSentAt.get(codeKey) ?? []).filter((at) => now - at <= codeWindowMs);
        if (times.length >= maxPerCodeWindow) {
          // Событие уже уходило в этот канал недавно — молча помечаем как отправленное,
          // иначе оно копится и уйдёт пачкой через час.
          seen.add(event.id);
          continue;
        }
        const sent = await sendMaxAlert(formatEvent(event));
        if (!sent.ok) {
          logWarn('critical MAX notify failed', { eventId: event.id, eventCode: event.eventCode, error: sent.error });
          continue;
        }
        times.push(now);
        codeSentAt.set(codeKey, times);
        seen.add(event.id);
      }

      if (seen.size > 5000) {
        seen.clear();
        for (const event of listCriticalEvents({ days: LOOKBACK_DAYS, limit: 1000 })) {
          if (shouldAlertEvent(event, { errorEnabled, errorCategories })) seen.add(event.id);
        }
      }
    } catch (error) {
      logWarn('critical MAX notifier tick failed', { error: String(error) });
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, pollMs);
}

/** Категории, по которым ошибка уходит в МАКС (те же, что у Telegram по умолчанию). */
function parseCategorySet(raw: string | undefined): Set<string> {
  const parts = String(raw ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return new Set(['sync', 'network', 'database']);
  return new Set(parts);
}

/** Часовой пояс подписи (тот же, что у Telegram-алертов). */
export const MAX_ALERT_TIMEZONE = DEFAULT_TZ;

export type { CriticalEventRecord };
