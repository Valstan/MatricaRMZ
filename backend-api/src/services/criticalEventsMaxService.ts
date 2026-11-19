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
import { readVaultSecret } from './karmanVaultClient.js';
import { getInstanceRole, shouldRunBackgroundJobs } from './instanceRole.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * Токен бота: сначала env прод-бокса, потом комната КАРМАНА (ключ `MAX_ALERT_TOKEN`).
 * Комната — наш «сейф»: положили токен туда и перезапустили сервис — канал работает, и
 * токен не лежит в git.
 */
async function resolveToken(): Promise<string | null> {
  const fromEnv = envText('MATRICA_MAX_ALERT_TOKEN');
  if (fromEnv) return fromEnv;
  return await readVaultSecret('MAX_ALERT_TOKEN');
}

/**
 * Адресат: групповой чат (`MAX_ALERT_CHAT_ID`) или личный диалог (`MAX_ALERT_USER_ID`).
 * Сначала env, потом комната — тем же порядком, что и токен.
 */
async function resolveTarget(): Promise<{ kind: 'chat' | 'user'; value: string } | null> {
  const chatId = envText('MATRICA_MAX_ALERT_CHAT_ID') || (await readVaultSecret('MAX_ALERT_CHAT_ID'));
  if (chatId) return { kind: 'chat', value: chatId };
  const userId = envText('MATRICA_MAX_ALERT_USER_ID') || (await readVaultSecret('MAX_ALERT_USER_ID'));
  if (userId) return { kind: 'user', value: userId };
  return null;
}

/** Канал МАКС настроен (токен и адресат на месте). Без него — честный no-op. */
export async function isMaxAlertConfigured(): Promise<boolean> {
  const [token, to] = await Promise.all([resolveToken(), resolveTarget()]);
  return token !== null && to !== null;
}

const MAX_TARGET_HINT_FILE = 'max-target.json';

/**
 * Записная книжка: адресат, который сервер однажды определил сам.
 *
 * Зачем. У МАКС `GET /chats` отключён, поэтому адресат известен ТОЛЬКО из входящего
 * сообщения боту. Сообщение сервер вычитывает (и отвечает на него) — и адресат пропадает:
 * в комнату он не пишется (бокс read-only), а в прод-журнале `logInfo` без флага
 * `critical` не пишется ВОВСЕ (`shouldLog`: в prod-mode info молчит). Итог был такой:
 * адресат определился — и потерялся, канал остался выключенным, и понять это было
 * негде. Обе строки про адресата теперь помечены `critical: true`, а сам адресат
 * кладётся сюда.
 *
 * Это НЕ источник правды для отправки: тревоги по-прежнему уходят по адресату из
 * комнаты (`MAX_ALERT_CHAT_ID` / `MAX_ALERT_USER_ID`). Это подсказка «вот кого положить
 * в комнату» — чтобы не ловить адресат в окно в одну минуту между поллинами.
 */
function maxTargetHintPath(): string {
  return join(process.env.MATRICA_LOGS_DIR?.trim() || 'logs', MAX_TARGET_HINT_FILE);
}

function writeMaxTargetHint(to: { kind: 'chat' | 'user'; value: string }): void {
  try {
    const dir = process.env.MATRICA_LOGS_DIR?.trim() || 'logs';
    mkdirSync(dir, { recursive: true });
    writeFileSync(maxTargetHintPath(), JSON.stringify({ ...to, at: Date.now() }), 'utf8');
  } catch {
    // подсказка — не критично
  }
}

function readMaxTargetHint(): { kind: 'chat' | 'user'; value: string } | null {
  try {
    const json = JSON.parse(readFileSync(maxTargetHintPath(), 'utf8')) as { kind?: string; value?: string };
    if ((json?.kind === 'chat' || json?.kind === 'user') && json?.value) {
      return { kind: json.kind, value: String(json.value) };
    }
    return null;
  } catch {
    return null;
  }
}

let lastSentAt = 0;

/**
 * Отправить сообщение в МАКС.
 *
 * `ok: false` без попытки — если канал не настроен: это не ошибка, а «канала нет».
 * Иначе — результат ответа платформы (401 — токен неверен, 403 — бота заблокировали).
 */
export async function sendMaxAlert(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const [accessToken, to] = await Promise.all([resolveToken(), resolveTarget()]);
  if (!accessToken || !to) return { ok: false, error: 'канал МАКС не настроен (нет токена/адресата)' };
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: 'пустое сообщение' };
  return await sendMaxMessage(accessToken, to, body);
}

/** Отправить в конкретный чат/диалог (минуя настройку адресата) — нужно для разового ответа боту. */
async function sendMaxMessage(
  accessToken: string,
  to: { kind: 'chat' | 'user'; value: string },
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
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
 * Разовый сбор адресата: узнать, куда писать.
 *
 * Почему так: с июня 2026 `GET /chats` у МАКС **отключён** — бот не может узнать список
 * своих чатов, и адресата приходится выяснять иначе: владелец пишет боту одно
 * сообщение, а мы читаем его через long polling (`GET /updates`) и отвечаем в тот же чат,
 * показав адресат. Дальше адресат кладётся в комнату КАРМАН (`MAX_ALERT_CHAT_ID`) — и
 * тревоги идут туда молча.
 *
 * Long polling тут — только для ОДНОГО раза (узнать адресата); сами тревоги — исходящие
 * сообщения, и платформа запрещает long polling именно как способ обработки событий
 * (для этого у неё webhook), а не как способ отправки.
 */
export async function discoverMaxTarget(): Promise<
  { ok: true; chatId?: string; userId?: string; text: string } | { ok: false; error: string }
> {
  const accessToken = await resolveToken();
  if (!accessToken) return { ok: false, error: 'нет токена бота (env или комната КАРМАНА)' };
  try {
    const resp = await fetch(`${MAX_API_BASE}/updates?timeout=5&limit=100`, {
      headers: { Authorization: accessToken },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return { ok: false, error: `MAX HTTP ${resp.status}: ${detail.slice(0, 200)}` };
    }
    const payload = (await resp.json().catch(() => null)) as unknown;
    const found = extractMessageTarget(payload);
    if (!found) return { ok: false, error: 'в обновлениях нет сообщений — напишите боту что-нибудь' };
    return { ok: true, ...found };
  } catch (e) {
    return { ok: false, error: `MAX недоступен: ${String(e)}` };
  }
}

/**
 * Достать из ответа обновлений первый разговор: чат, автор и текст сообщения.
 *
 * Форма события взята из работающей реализации в «Сарафане» (`web/api/max_webhook.py`):
 * при старте диалога MAX присылает событие `bot_started`, и **`chat_id` лежит на верхнем
 * уровне** события, а не внутри `message`. Поэтому ищем рекурсивно по всему объекту, а не
 * по одному месту: форма события у МАКС менялась и может измениться ещё.
 */
function extractMessageTarget(payload: unknown): { chatId?: string; userId?: string; text: string } | null {
  const updates = (payload as { updates?: unknown[] } | null)?.updates;
  const list = Array.isArray(updates) ? updates : payload ? [payload] : [];
  for (const update of list) {
    const found = findChatRef(update);
    if (found) return found;
  }
  return null;
}

/** Рекурсивный поиск `chat_id`/`user_id` и текста в объекте события. */
function findChatRef(node: unknown, depth = 0): { chatId?: string; userId?: string; text: string } | null {
  if (depth > 6 || node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findChatRef(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const chat = (obj.chat ?? {}) as Record<string, unknown>;
  const user = (obj.user ?? {}) as Record<string, unknown>;
  const chatId = obj.chat_id ?? chat.chat_id ?? chat.id;
  const userId = obj.user_id ?? user.user_id ?? user.id;
  if (chatId == null && userId == null) {
    // Ищем глубже: событие может лежать во вложенном объекте.
    for (const value of Object.values(obj)) {
      const hit = findChatRef(value, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const out: { chatId?: string; userId?: string; text: string } = { text: String(obj.text ?? '') };
  if (chatId != null) out.chatId = String(chatId);
  if (userId != null) out.userId = String(userId);
  return out;
}

/**
 * Фоновая попытка узнать адресата: токен есть, а адресата нет (владелец ещё не написал
 * боту). Как только он напишет — бот отвечает, и адресат печатается в лог: его кладут в
 * комнату КАРМАН ключом `MAX_ALERT_CHAT_ID`, и тревоги идут в МАКС.
 */
export async function tryDiscoverMaxTargetOnce(): Promise<void> {
  const accessToken = await resolveToken();
  if (!accessToken) return;
  if (await resolveTarget()) return;
  const found = await discoverMaxTarget();
  if (!found.ok) {
    // critical: в проде info-молчит (shouldLog) — без этого флага адресат был бы не виден
    // нигде, и выглядело бы как «бот молчит».
    logInfo('канал МАКС: адресат пока не известен', { error: found.error }, { critical: true });
    return;
  }
  const to = found.chatId ? { kind: 'chat' as const, value: found.chatId } : { kind: 'user' as const, value: found.userId ?? '' };
  await sendMaxMessage(
    accessToken,
    to,
    'Матрица РМЗ на связи: тревоги завода будут приходить сюда.\n' +
      `Адресат: ${to.kind === 'chat' ? 'чат' : 'личный диалог'} ${to.value}.\n` +
      'Его нужно положить в комнату КАРМАНА ключом MAX_ALERT_CHAT_ID (или MAX_ALERT_USER_ID) — ' +
      'и канал поднимется сам.',
  );
  writeMaxTargetHint(to);
  logInfo('канал МАКС: адресат определён', { kind: to.kind, id: to.value }, { critical: true });
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
  if (!parseBool(process.env.MATRICA_CRITICAL_MAX_ENABLED, true)) {
    logInfo('critical events MAX notifier disabled (MATRICA_CRITICAL_MAX_ENABLED=false)', {}, { critical: true });
    return;
  }
  started = true;

  // Токен и адресат могут лежать в комнате КАРМАНА — читаем её асинхронно, поэтому
  // старт канала уходит в отдельную задачу.
  void (async () => {
    if (!(await isMaxAlertConfigured())) {
      const token = await resolveToken();
      if (!token) {
        logInfo('critical events MAX notifier disabled (нет MATRICA_MAX_ALERT_TOKEN в env и в комнате)', {}, { critical: true });
        return;
      }
      // Токен есть, адресата нет: ждём, пока владелец напишет боту, и узнаём адресат сами.
      logInfo('critical events MAX: токен есть, адресат не задан — ждём сообщения боту', {}, { critical: true });
      // Если адресат уже определялся раньше — напоминаем, какой ключ и куда положить:
      // сообщение боту сервер вычитывает, а в комнату записать не может (бокс read-only).
      const hint = readMaxTargetHint();
      if (hint) {
        logInfo(
          'канал МАКС: адресат был определён раньше — положите его в комнату КАРМАНА',
          {
            kind: hint.kind,
            id: hint.value,
            ключ: hint.kind === 'chat' ? 'MAX_ALERT_CHAT_ID' : 'MAX_ALERT_USER_ID',
          },
          { critical: true },
        );
      }
    }
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

    // Раз в минуту пробуем узнать адресата (если его ещё нет) — и отвечаем боту.
    setInterval(() => {
      void tryDiscoverMaxTargetOnce().catch(() => null);
    }, 60_000);
  })();
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
