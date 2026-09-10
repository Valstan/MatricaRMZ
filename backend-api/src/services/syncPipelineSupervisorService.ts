import { getSyncPipelineHealth } from './diagnosticsSyncPipelineService.js';
import { listEmployeesAuth } from './employeeAuthService.js';
import {
  answerTelegramCallbackQuery,
  fetchTelegramUpdates,
  getCachedChatIdByLogin,
  isTelegramIntegrationEnabled,
  sendTelegramMessage,
  sendTelegramMessageToChat,
} from './telegramBotService.js';
import { ingestServerCriticalEvent } from './criticalEventsService.js';
import { getInstanceRole, shouldRunBackgroundJobs } from './instanceRole.js';
import {
  getSyncPipelineBotPollMetrics,
  markSyncPipelineBotPollAttempt,
  markSyncPipelineBotPollFailure,
  markSyncPipelineBotPollSuccess,
} from './syncPipelineBotPollMetricsService.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';

const DEFAULT_TZ = 'Europe/Moscow';
const DEFAULT_DAILY_TIME = '21:00';
const CHECK_TICK_MS = 60_000;
export const BOT_POLL_MS = 15_000;
const BOT_POLL_ERROR_LOG_STREAK = 3;
const BOT_POLL_SILENT_COUNTER_LOG_MS = 10 * 60_000;
let knownSuperadminChatId: string | null = null;

/**
 * Тик, который не имеет права наложиться сам на себя.
 *
 * Опрос бота приходит каждые `BOT_POLL_MS`, и худший случай прохода теперь в этот период
 * укладывается (`telegramPollWorstCaseMs`, ~10 с против 15 с). Так было не всегда: проход жил до
 * ~155 с — шесть попыток по 8 с в `telegramFetch` (лечение потерь SYN, M101) поверх трёх кругов в
 * `processBotUpdates`. Наложившийся проход Telegram видит как второго потребителя и отвечает
 * `409 Conflict: terminated by other getUpdates request` — то есть обрывает наш же предыдущий опрос
 * (GOTCHAS M108). Текст ошибки при этом описывает наблюдение Telegram, а не нашу топологию, поэтому
 * разбор уходит искать второй процесс; гарантия должна стоять здесь и быть проверяемой тестом.
 *
 * `run` обязан ловить свои ошибки — отказ опроса это штатный исход, а не исключение.
 */
export function createSingleFlightTick(
  run: () => Promise<void>,
  onSettled: (info: { elapsedMs: number; skippedTicks: number }) => void,
) {
  let inFlight = false;
  let skippedTicks = 0;
  return () => {
    if (inFlight) {
      skippedTicks += 1;
      return;
    }
    inFlight = true;
    const startedAt = Date.now();
    void run()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        const skipped = skippedTicks;
        skippedTicks = 0;
        onSettled({ elapsedMs: Date.now() - startedAt, skippedTicks: skipped });
      });
  };
}

function parseBool(raw: string | undefined, fallback: boolean) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseTime(value: string) {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeLogin(value: string | null | undefined) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  return v.startsWith('@') ? v : `@${v}`;
}

type BotUpdateLike = {
  my_chat_member?: { chat?: { id?: number | string; type?: string }; new_chat_member?: { status?: string } };
  message?: { chat?: { id?: number | string; type?: string }; from?: { username?: string } };
};

export type BotUpdateTrace =
  | { kind: 'ignored_sender'; chatId: number | string; chatType: string; fromUsername: string | null }
  | { kind: 'membership'; chatId: number | string; chatType: string; status: string };

/**
 * Что записать в журнал об обновлении, которое бот не обработает. Раньше такие обновления исчезали
 * бесследно: 10.09 владелец трижды писал `/sync_chat_id`, а в карточке суперадмина стоял не тот
 * Telegram-логин — бот отбрасывал команды, не оставив ни строки. Текст сообщения в след не попадает
 * намеренно: на вопрос «почему бот молчит» отвечают номер чата и отправитель, а не текст.
 */
export function traceUnhandledBotUpdate(upd: unknown, adminLogin: string | null | undefined): BotUpdateTrace | null {
  const u = (upd ?? {}) as BotUpdateLike;
  const member = u.my_chat_member;
  if (member?.chat?.id != null) {
    return {
      kind: 'membership',
      chatId: member.chat.id,
      chatType: String(member.chat.type ?? ''),
      status: String(member.new_chat_member?.status ?? ''),
    };
  }
  const msg = u.message;
  if (msg?.chat?.id == null) return null;
  const fromLogin = normalizeLogin(msg.from?.username);
  if (fromLogin && fromLogin === normalizeLogin(adminLogin)) return null;
  return { kind: 'ignored_sender', chatId: msg.chat.id, chatType: String(msg.chat.type ?? ''), fromUsername: fromLogin || null };
}

function getTimeParts(timeZone: string) {
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const map = new Map(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.get('year') ?? 0),
    month: Number(map.get('month') ?? 0),
    day: Number(map.get('day') ?? 0),
    hour: Number(map.get('hour') ?? 0),
    minute: Number(map.get('minute') ?? 0),
  };
}

function formatDateKey(parts: { year: number; month: number; day: number }) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function formatTimeKey(parts: { hour: number; minute: number }) {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function levelEmoji(level: string) {
  if (level === 'critical') return 'КРИТ';
  if (level === 'warn') return 'ВНИМАНИЕ';
  return 'НОРМАЛЬНО';
}

function formatPipelineMessage(health: Awaited<ReturnType<typeof getSyncPipelineHealth>>, source: 'nightly' | 'manual') {
  const lines: string[] = [];
  lines.push(`[Синхронизация] ${levelEmoji(health.status)} (${source === 'nightly' ? 'плановый запуск' : 'ручной запуск'})`);
  lines.push(
    `последовательность: журнал=${health.seq.ledgerLastSeq}, проекция=${health.seq.projectionMaxSeq}, отставание проекции=${health.seq.indexToProjectionLag}, сожжённых номеров=${health.seq.ledgerToIndexLag}`,
  );
  lines.push(
    `дрейф: entity_types=${health.tables.entity_types.diffRatio.toFixed(4)}, entities=${health.tables.entities.diffRatio.toFixed(4)}, attribute_defs=${health.tables.attribute_defs.diffRatio.toFixed(4)}, attribute_values=${health.tables.attribute_values.diffRatio.toFixed(4)}, operations=${health.tables.operations.diffRatio.toFixed(4)}`,
  );
  if (health.reasons?.length) lines.push(`причины: ${health.reasons.join('; ')}`);
  return lines.join('\n');
}

function mirrorPipelineAlertToCriticalEvents(health: Awaited<ReturnType<typeof getSyncPipelineHealth>>, source: 'nightly' | 'manual') {
  if (health.status === 'ok') return;
  const severity = health.status === 'critical' ? 'fatal' : 'warn';
  const title = health.status === 'critical' ? 'Критический сбой sync pipeline' : 'Предупреждение sync pipeline';
  const humanMessage = formatPipelineMessage(health, source);
  ingestServerCriticalEvent({
    eventCode: `server.sync.pipeline_health.${health.status}`,
    title,
    humanMessage,
    category: 'sync',
    severity,
    dedupMessage: `${health.status}|${health.reasons.join(';')}|${health.seq.indexToProjectionLag}|${health.tables.operations.diffRatio.toFixed(4)}`,
    aiDetails: {
      component: 'sync',
      source: 'sync_pipeline_supervisor',
      trigger: source,
      health,
    },
  });
}

async function getSuperadminTelegram() {
  const list = await listEmployeesAuth().catch(() => null);
  if (!list || !list.ok) return null;
  const byRole = list.rows.find((r) => String(r.systemRole ?? '').toLowerCase() === 'superadmin');
  const byLogin = list.rows.find((r) => String(r.login ?? '').trim().toLowerCase() === 'valstan');
  const row = byRole ?? byLogin ?? null;
  if (!row) return null;
  const telegramLogin = normalizeLogin(row.telegramLogin ?? '');
  if (!telegramLogin) return null;
  return { telegramLogin };
}

async function sendToSuperadmin(text: string, withKeyboard = false) {
  const replyMarkup = withKeyboard
    ? {
        inline_keyboard: [
          [
            { text: 'Проверить синхронизацию', callback_data: 'sync:check_now' },
            { text: 'Помощь', callback_data: 'sync:help' },
          ],
        ],
      }
    : undefined;

  const envChatId = String(process.env.MATRICA_TELEGRAM_ALERT_CHAT_ID ?? '').trim();
  if (envChatId) {
    const res = await sendTelegramMessageToChat({ chatId: envChatId, text, replyMarkup });
    if (res.ok) {
      knownSuperadminChatId = envChatId;
      return res;
    }
  }

  if (knownSuperadminChatId && knownSuperadminChatId !== envChatId) {
    const byChat = await sendTelegramMessageToChat({ chatId: knownSuperadminChatId, text, replyMarkup });
    if (byChat.ok) return byChat;
  }

  const admin = await getSuperadminTelegram();
  if (!admin) return { ok: false as const, error: 'Цель Telegram-уведомлений не настроена (MATRICA_TELEGRAM_ALERT_CHAT_ID / superadmin login)' };

  const cachedChatId = getCachedChatIdByLogin(admin.telegramLogin);
  if (cachedChatId) {
    const byCache = await sendTelegramMessageToChat({ chatId: cachedChatId, text, replyMarkup });
    if (byCache.ok) {
      knownSuperadminChatId = cachedChatId;
      return byCache;
    }
  }

  const byLogin = await sendTelegramMessage({ toLogin: admin.telegramLogin, text, replyMarkup });
  return byLogin;
}

export function startSyncPipelineSupervisorService() {
  const instanceRole = getInstanceRole();
  if (!shouldRunBackgroundJobs(instanceRole)) {
    logInfo('sync pipeline supervisor skipped on non-primary instance', { instanceRole: instanceRole || 'primary' }, { critical: true });
    return;
  }

  const enabled = parseBool(process.env.MATRICA_SYNC_PIPELINE_NIGHTLY_ENABLED, true);
  if (!enabled) {
    logInfo('sync pipeline supervisor disabled');
    return;
  }
  const timeZone = String(process.env.MATRICA_SYNC_PIPELINE_NIGHTLY_TZ ?? DEFAULT_TZ);
  const dailyTime = parseTime(String(process.env.MATRICA_SYNC_PIPELINE_NIGHTLY_TIME ?? DEFAULT_DAILY_TIME)) ?? DEFAULT_DAILY_TIME;
  const sendOkSummary = parseBool(process.env.MATRICA_SYNC_PIPELINE_NIGHTLY_OK_SUMMARY, false);
  const telegramEnabled = isTelegramIntegrationEnabled();
  if (!telegramEnabled) {
    logInfo('sync pipeline: Telegram отключён (MATRICA_TELEGRAM_ENABLED=false), опрос бота и ночные уведомления в TG не используются');
  }
  const actionsEnabled = parseBool(process.env.MATRICA_SYNC_PIPELINE_TELEGRAM_ACTIONS_ENABLED, true) && telegramEnabled;
  const botPollSilentCounterLogMs = parseNumber(
    process.env.MATRICA_SYNC_PIPELINE_BOT_POLL_COUNTER_LOG_MS,
    BOT_POLL_SILENT_COUNTER_LOG_MS,
    60_000,
    24 * 60 * 60_000,
  );

  let lastNightlyDate = '';
  let updateOffset = 0;
  let botPollingDisabledLogged = false;
  let botPollFailureStreak = 0;
  let lastBotPollError = '';
  let lastMetricsLogAt = Date.now();
  let lastMetricsAttempts = 0;
  let lastMetricsFailures = 0;
  let lastMetricsTransient = 0;
  let lastMetricsConflict = 0;
  let lastMetricsMisconfigured = 0;
  let lastMetricsOther = 0;
  let noSuperadminLoginLogged = false;
  const tracedSenders = new Set<string>();

  const logUpdateTrace = (trace: BotUpdateTrace) => {
    if (trace.kind === 'membership') {
      logInfo('telegram bot membership changed', { ...trace }, { critical: true });
      return;
    }
    const key = `${trace.chatId}|${trace.fromUsername ?? ''}`;
    if (tracedSenders.has(key)) return;
    tracedSenders.add(key);
    logInfo('telegram bot ignored a message: sender is not the superadmin', { ...trace }, { critical: true });
  };

  const replyInChat = async (chatId: string | number, command: string, message: { text: string; replyMarkup?: unknown }) => {
    const res = await sendTelegramMessageToChat({ chatId, ...message });
    if (!res.ok) logWarn('telegram bot reply failed', { chatId, command, error: res.error });
  };

  const logBotPollSilentCounter = (force = false) => {
    const now = Date.now();
    if (!force && now - lastMetricsLogAt < botPollSilentCounterLogMs) return;
    lastMetricsLogAt = now;
    const metrics = getSyncPipelineBotPollMetrics();
    const deltaAttempts = Math.max(0, metrics.totalAttempts - lastMetricsAttempts);
    const deltaFailures = Math.max(0, metrics.totalFailures - lastMetricsFailures);
    const deltaTransient = Math.max(0, metrics.transientFailures - lastMetricsTransient);
    const deltaConflict = Math.max(0, metrics.conflictFailures - lastMetricsConflict);
    const deltaMisconfigured = Math.max(0, metrics.misconfiguredFailures - lastMetricsMisconfigured);
    const deltaOther = Math.max(0, metrics.otherFailures - lastMetricsOther);
    lastMetricsAttempts = metrics.totalAttempts;
    lastMetricsFailures = metrics.totalFailures;
    lastMetricsTransient = metrics.transientFailures;
    lastMetricsConflict = metrics.conflictFailures;
    lastMetricsMisconfigured = metrics.misconfiguredFailures;
    lastMetricsOther = metrics.otherFailures;
    if (deltaFailures <= 0) return;
    const failurePct = deltaAttempts > 0 ? Number(((deltaFailures / deltaAttempts) * 100).toFixed(2)) : null;
    logInfo('sync pipeline bot poll silent counter', {
      component: 'sync',
      subsystem: 'pipeline_bot_poll',
      periodMs: botPollSilentCounterLogMs,
      attempts: deltaAttempts,
      failures: deltaFailures,
      failurePct,
      transient: deltaTransient,
      conflict: deltaConflict,
      misconfigured: deltaMisconfigured,
      other: deltaOther,
      currentStreak: metrics.currentFailureStreak,
      maxStreak: metrics.maxFailureStreak,
      lastError: metrics.lastError,
    });
  };

  const runNightlyCheck = async () => {
    const health = await getSyncPipelineHealth();
    mirrorPipelineAlertToCriticalEvents(health, 'nightly');
    const shouldSend = health.status !== 'ok' || sendOkSummary;
    if (!shouldSend) return;
    if (!telegramEnabled) return;
    const text = formatPipelineMessage(health, 'nightly');
    const sent = await sendToSuperadmin(text, true);
    if (!sent.ok) {
      logWarn('sync pipeline nightly notify skipped', { error: sent.error, status: health.status });
      return;
    }
    logInfo('sync pipeline nightly report sent', { status: health.status, sendOkSummary });
  };

  const tickNightly = async () => {
    try {
      const parts = getTimeParts(timeZone);
      const dateKey = formatDateKey(parts);
      const timeKey = formatTimeKey(parts);
      if (timeKey !== dailyTime) return;
      if (lastNightlyDate === dateKey) return;
      await runNightlyCheck();
      lastNightlyDate = dateKey;
    } catch (e) {
      logError('sync pipeline nightly check failed', { error: String(e) });
    }
  };

  const handleCommand = async (chatId: string | number, command: string) => {
    const cmd = String(command ?? '').trim().toLowerCase();
    if (cmd === '/sync_help') {
      await replyInChat(chatId, cmd, {
        text: 'Доступные команды:\n/sync_status — текущий статус синхронизации\n/sync_help — помощь\n/sync_chat_id — узнать chat_id текущего чата',
      });
      return;
    }
    if (cmd === '/sync_chat_id') {
      await replyInChat(chatId, cmd, {
        text: `chat_id: ${chatId}`,
      });
      return;
    }
    if (cmd === '/sync_status') {
      const health = await getSyncPipelineHealth();
      mirrorPipelineAlertToCriticalEvents(health, 'manual');
      await replyInChat(chatId, cmd, {
        text: formatPipelineMessage(health, 'manual'),
        replyMarkup: {
          inline_keyboard: [
            [
              { text: 'Проверить синхронизацию', callback_data: 'sync:check_now' },
              { text: 'Помощь', callback_data: 'sync:help' },
            ],
          ],
        },
      });
      return;
    }
  };

  const processBotUpdates = async () => {
    if (!actionsEnabled) return;
    const token = String(process.env.MATRICA_TELEGRAM_BOT_TOKEN ?? '').trim();
    if (!token) {
      if (!botPollingDisabledLogged) {
        botPollingDisabledLogged = true;
        logWarn('sync pipeline bot actions disabled: telegram token is missing');
      }
      return;
    }
    botPollingDisabledLogged = false;
    markSyncPipelineBotPollAttempt();
    // Повторов внутри прохода нет намеренно: опрос идёт каждые BOT_POLL_MS, и следующий тик —
    // это и есть повтор. Прежние два круга по 800/1600 мс поверх шести попыток `telegramFetch`
    // растягивали проход до ~155 с при периоде 15 с; тик съедал сам себя, а Telegram видел в этом
    // второго потребителя (M108). Отказ прохода ничего не теряет: `updateOffset` не сдвигается,
    // те же обновления приедут через 15 с.
    const updatesRes = await fetchTelegramUpdates({ offset: updateOffset, limit: 25, timeoutSec: 0 });
    if (!updatesRes.ok) {
      botPollFailureStreak += 1;
      const err = String(updatesRes.error ?? '');
      const changedError = err !== lastBotPollError;
      lastBotPollError = err;
      const kind = markSyncPipelineBotPollFailure(err);
      const isTransient = kind === 'transient';
      const shouldLog = isTransient
        ? botPollFailureStreak >= BOT_POLL_ERROR_LOG_STREAK && (botPollFailureStreak === BOT_POLL_ERROR_LOG_STREAK || botPollFailureStreak % 5 === 0)
        : (botPollFailureStreak >= BOT_POLL_ERROR_LOG_STREAK && (botPollFailureStreak === BOT_POLL_ERROR_LOG_STREAK || botPollFailureStreak % 5 === 0)) || changedError;
      if (shouldLog) {
        logWarn('sync pipeline bot poll failed', {
          component: 'sync',
          subsystem: 'pipeline_bot_poll',
          error: updatesRes.error,
          transient: isTransient,
          streak: botPollFailureStreak,
        });
      }
      return;
    }
    markSyncPipelineBotPollSuccess();
    if (botPollFailureStreak > 0) {
      logInfo('sync pipeline bot poll recovered', { streak: botPollFailureStreak });
      logBotPollSilentCounter(true);
      botPollFailureStreak = 0;
      lastBotPollError = '';
    }
    if (!updatesRes.updates.length) return;
    const admin = await getSuperadminTelegram();
    if (!admin) {
      // Обновления не разбираются и `updateOffset` не сдвигается — без этой строки бот молчит без причины.
      if (!noSuperadminLoginLogged) {
        noSuperadminLoginLogged = true;
        logWarn('telegram bot: superadmin has no telegram login, updates are not processed', {
          pending: updatesRes.updates.length,
        });
      }
      return;
    }
    noSuperadminLoginLogged = false;
    const adminLogin = normalizeLogin(admin.telegramLogin);

    for (const upd of updatesRes.updates) {
      const updateId = Number(upd?.update_id ?? 0);
      if (Number.isFinite(updateId)) updateOffset = Math.max(updateOffset, updateId + 1);

      const cb = upd?.callback_query;
      if (cb?.id && cb?.from) {
        const fromLogin = normalizeLogin(cb?.from?.username ?? '');
        const chatId = cb?.message?.chat?.id;
        if (!chatId) continue;
        if (!fromLogin || fromLogin !== adminLogin) {
          await answerTelegramCallbackQuery({ callbackQueryId: String(cb.id), text: 'Недоступно' });
          continue;
        }
        knownSuperadminChatId = String(chatId);
        const data = String(cb?.data ?? '');
        if (data === 'sync:check_now') {
          const health = await getSyncPipelineHealth();
          mirrorPipelineAlertToCriticalEvents(health, 'manual');
          await replyInChat(chatId, 'sync:check_now', { text: formatPipelineMessage(health, 'manual') });
          await answerTelegramCallbackQuery({ callbackQueryId: String(cb.id), text: 'Готово' });
          continue;
        }
        if (data === 'sync:help') {
          await replyInChat(chatId, 'sync:help', {
            text: 'Команды:\n/sync_status — текущий статус синхронизации\n/sync_help — помощь\n/sync_chat_id — узнать chat_id текущего чата',
          });
          await answerTelegramCallbackQuery({ callbackQueryId: String(cb.id), text: 'Ок' });
        }
        continue;
      }

      const trace = traceUnhandledBotUpdate(upd, adminLogin);
      if (trace) {
        logUpdateTrace(trace);
        continue;
      }
      const msg = upd?.message;
      if (!msg?.text || !msg?.chat?.id) continue;
      knownSuperadminChatId = String(msg.chat.id);
      await handleCommand(msg.chat.id, String(msg.text));
    }
  };

  void tickNightly();
  setInterval(() => void tickNightly(), CHECK_TICK_MS);
  setInterval(() => logBotPollSilentCounter(false), CHECK_TICK_MS);
  if (actionsEnabled) {
    const tickBotUpdates = createSingleFlightTick(
      () =>
        processBotUpdates().catch((e) => {
          markSyncPipelineBotPollFailure(String(e));
          logWarn('sync pipeline bot polling failed', { component: 'sync', subsystem: 'pipeline_bot_poll', error: String(e) });
        }),
      ({ elapsedMs, skippedTicks }) => {
        if (skippedTicks <= 0) return;
        logWarn('sync pipeline bot poll slower than its tick', {
          component: 'sync',
          subsystem: 'pipeline_bot_poll',
          elapsedMs,
          tickMs: BOT_POLL_MS,
          skippedTicks,
        });
      },
    );
    setInterval(tickBotUpdates, BOT_POLL_MS);
  }

  logInfo('sync pipeline supervisor started', {
    timeZone,
    dailyTime,
    sendOkSummary,
    actionsEnabled,
    telegramEnabled,
    botPollSilentCounterLogMs,
  });
}

