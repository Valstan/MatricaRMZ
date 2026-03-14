import { listEmployeesAuth } from './employeeAuthService.js';
import { listCriticalEvents, type CriticalEventRecord } from './criticalEventsService.js';
import { getCachedChatIdByLogin, sendTelegramMessage, sendTelegramMessageToChat } from './telegramBotService.js';
import { getInstanceRole, shouldRunBackgroundJobs } from './instanceRole.js';
import { logInfo, logWarn } from '../utils/logger.js';

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TZ = 'Europe/Moscow';
const MAX_EVENTS_PER_TICK = 50;
const LOOKBACK_DAYS = 3;
const SUPERADMIN_LOGIN_FALLBACK = 'valstan';
const DEFAULT_ALERT_ERROR_CATEGORIES = ['sync', 'network', 'database'];
const DEFAULT_RATE_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_PER_WINDOW = 12;
const DEFAULT_MAX_PER_CODE_WINDOW = 3;
const SUPPRESSED_ALERT_EVENT_CODES = new Set(['server.sync.pipeline_health.critical', 'server.sync.pipeline_health.warn']);

let started = false;

function parseBool(raw: string | undefined, fallback: boolean) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function parseNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseCategorySet(raw: string | undefined, fallback: string[]) {
  const source = String(raw ?? '').trim();
  const parts = (source ? source : fallback.join(','))
    .split(',')
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean);
  return new Set(parts);
}

function normalizeLogin(raw: string | null | undefined) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  return value.startsWith('@') ? value : `@${value}`;
}

async function resolveAlertTarget(): Promise<{ kind: 'chat'; value: string } | { kind: 'login'; value: string } | null> {
  const chatId = String(process.env.MATRICA_TELEGRAM_ALERT_CHAT_ID ?? '').trim();
  if (chatId) return { kind: 'chat', value: chatId };

  const loginEnv = normalizeLogin(process.env.MATRICA_TELEGRAM_ALERT_LOGIN);
  if (loginEnv) {
    const cachedByEnvLogin = getCachedChatIdByLogin(loginEnv);
    if (cachedByEnvLogin) return { kind: 'chat', value: cachedByEnvLogin };
    return { kind: 'login', value: loginEnv };
  }

  const list = await listEmployeesAuth().catch(() => null);
  if (!list || !list.ok) return null;

  const byRole = list.rows.find((row) => String(row.systemRole ?? '').trim().toLowerCase() === 'superadmin');
  const byLogin = list.rows.find((row) => String(row.login ?? '').trim().toLowerCase() === SUPERADMIN_LOGIN_FALLBACK);
  const row = byRole ?? byLogin ?? null;
  if (!row) return null;

  const telegramLogin = normalizeLogin(row.telegramLogin ?? '');
  if (!telegramLogin) return null;
  const cachedByLogin = getCachedChatIdByLogin(telegramLogin);
  if (cachedByLogin) return { kind: 'chat', value: cachedByLogin };
  return { kind: 'login', value: telegramLogin };
}

function shouldAlertEvent(event: CriticalEventRecord, opts: { errorEnabled: boolean; errorCategories: Set<string> }) {
  if (SUPPRESSED_ALERT_EVENT_CODES.has(String(event.eventCode ?? '').trim().toLowerCase())) return false;
  if (event.severity === 'fatal') return true;
  if (!opts.errorEnabled) return false;
  if (event.severity !== 'error') return false;
  return opts.errorCategories.has(String(event.category ?? '').trim().toLowerCase());
}

function formatEvent(event: CriticalEventRecord) {
  const ts = new Date(Number(event.createdAt)).toLocaleString('ru-RU', { timeZone: DEFAULT_TZ });
  const prefix = event.severity === 'fatal' ? 'Критический алерт' : 'Серьезная ошибка';
  const header = `[${prefix}] ${event.title}`;
  const details = [
    `время: ${ts}`,
    `источник: ${event.source}`,
    `уровень: ${event.severity}`,
    `категория: ${event.category}`,
    `код: ${event.eventCode}`,
    event.clientId ? `clientId: ${event.clientId}` : null,
    event.username ? `user: ${event.username}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return `${header}\n${details}\n\n${event.humanMessage}`;
}

async function sendAlert(text: string) {
  const target = await resolveAlertTarget();
  if (!target) return { ok: false as const, error: 'цель Telegram-алерта не настроена (chat id/login)' };
  if (target.kind === 'chat') {
    return await sendTelegramMessageToChat({ chatId: target.value, text });
  }
  return await sendTelegramMessage({ toLogin: target.value, text });
}

export function startCriticalEventsTelegramService() {
  const instanceRole = getInstanceRole();
  if (!shouldRunBackgroundJobs(instanceRole)) {
    logInfo('critical events telegram notifier skipped on non-primary instance', { instanceRole: instanceRole || 'primary' }, { critical: true });
    return;
  }

  if (started) return;
  started = true;

  const enabled = parseBool(process.env.MATRICA_CRITICAL_TELEGRAM_ENABLED, true);
  if (!enabled) {
    logInfo('critical events telegram notifier disabled');
    return;
  }

  const pollMsRaw = Number(process.env.MATRICA_CRITICAL_TELEGRAM_POLL_MS ?? DEFAULT_POLL_MS);
  const pollMs = Number.isFinite(pollMsRaw) && pollMsRaw >= 3_000 ? Math.trunc(pollMsRaw) : DEFAULT_POLL_MS;
  const errorEnabled = parseBool(process.env.MATRICA_CRITICAL_TELEGRAM_ERROR_ENABLED, true);
  const errorCategories = parseCategorySet(process.env.MATRICA_CRITICAL_TELEGRAM_ERROR_CATEGORIES, DEFAULT_ALERT_ERROR_CATEGORIES);
  const rateWindowMs = parseNumber(process.env.MATRICA_CRITICAL_TELEGRAM_RATE_WINDOW_MS, DEFAULT_RATE_WINDOW_MS, 60_000, 3_600_000);
  const maxPerWindow = parseNumber(process.env.MATRICA_CRITICAL_TELEGRAM_MAX_PER_WINDOW, DEFAULT_MAX_PER_WINDOW, 1, 200);
  const maxPerCodeWindow = parseNumber(
    process.env.MATRICA_CRITICAL_TELEGRAM_MAX_PER_CODE_WINDOW,
    DEFAULT_MAX_PER_CODE_WINDOW,
    1,
    50,
  );
  const seen = new Set<string>();
  const globalSentAt: number[] = [];
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

      const queue = events.slice(0, MAX_EVENTS_PER_TICK);
      for (const event of queue) {
        const now = Date.now();
        while (globalSentAt.length > 0) {
          const firstGlobal = globalSentAt[0];
          if (firstGlobal == null || now - firstGlobal <= rateWindowMs) break;
          globalSentAt.shift();
        }
        const codeKey = `${String(event.severity)}|${String(event.eventCode ?? '')}`;
        const codeTimes = codeSentAt.get(codeKey) ?? [];
        while (codeTimes.length > 0) {
          const firstCode = codeTimes[0];
          if (firstCode == null || now - firstCode <= rateWindowMs) break;
          codeTimes.shift();
        }
        codeSentAt.set(codeKey, codeTimes);

        if (globalSentAt.length >= maxPerWindow || codeTimes.length >= maxPerCodeWindow) {
          seen.add(event.id);
          logWarn('critical telegram notify suppressed by anti-flood', {
            eventId: event.id,
            eventCode: event.eventCode,
            severity: event.severity,
            globalRateCount: globalSentAt.length,
            codeRateCount: codeTimes.length,
            rateWindowMs,
          });
          continue;
        }

        const text = formatEvent(event);
        const sent = await sendAlert(text);
        if (!sent.ok) {
          logWarn('critical telegram notify failed', {
            eventId: event.id,
            eventCode: event.eventCode,
            error: sent.error,
          });
          continue;
        }
        globalSentAt.push(now);
        codeTimes.push(now);
        codeSentAt.set(codeKey, codeTimes);
        seen.add(event.id);
      }

      if (seen.size > 5000) {
        seen.clear();
        for (const event of listCriticalEvents({ days: LOOKBACK_DAYS, limit: 1000 })) {
          if (shouldAlertEvent(event, { errorEnabled, errorCategories })) seen.add(event.id);
        }
      }
    } catch (error) {
      logWarn('critical telegram notifier tick failed', { error: String(error) });
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, pollMs);

  logInfo('critical events telegram notifier started', { pollMs });
}

