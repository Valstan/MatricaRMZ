/**
 * Сборщик критических событий → корзина промтов КАРМАНА (промт КАРМАНА #183).
 *
 * Зачем. Критические сообщения об ошибках оператору показывать не надо (заказ
 * владельца 28.11.2026): они должны САМИ уходить в корзину промтов Кармана
 * (проект «Матрица РМЗ»), чтобы разработчик брал их в работу. Одно и то же
 * сообщение от одного клиента не должно сыпаться в корзину чаще раза в четыре
 * часа.
 *
 * Что тут есть:
 *  - перечень событий, которые уходят в корзину (коды и серьёзность) —
 *    `CRITICAL_EVENTS_TO_BASKET`; владелец перечень не утверждал, поэтому он
 *    записан здесь явно и вынесен в PENDING на подтверждение;
 *  - формат записи: она должна читаться как заявка, а не как строчка лога;
 *  - окно повторов: четыре часа, отпечаток — клиент + суть сообщения (тот же
 *    приём, что у аларма «очередь застряла»: отпечаток «машина + счётчик строк»);
 *  - fail-soft: корзина недоступна — событие остаётся в журнале, программа
 *    продолжает работать, оператор ничего не видит.
 *
 * Отправляет СЕРВЕР: он и пишет события, и ходит в Карман (за аккаунтами пула).
 * Клиент про корзину не знает ничего — поэтому событие уходит, даже если клиент
 * офлайн, как только оно дошло до сервера.
 *
 * Внутренний поток промтов сюда не попадает: сборщик читает ТОЛЬКО журнал
 * критических событий и пишет по одному событию — запись в корзину. Список
 * промтов раздела он не читает вовсе.
 *
 * ⚠️ Логи сборщика не должны порождать новые критические события: `logError`
 * пишет в журнал событий (серьёзность error) — оттуда он снова попал бы в
 * корзину, и при недоступной корзине получился бы цикл. Поэтому здесь только
 * `logWarn` (серьёзность warn — в корзину не идёт) и `logInfo`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { listCriticalEvents, type CriticalEventRecord } from './criticalEventsService.js';
import { readVaultSecret } from './karmanVaultClient.js';
import { getInstanceRole, shouldRunBackgroundJobs } from './instanceRole.js';
import { logInfo, logWarn } from '../utils/logger.js';

/** Раздел КАРМАНА, в который кладутся записи. */
export const KARMAN_PROMPTS_PROJECT = 'MatricaRMZ';

/** Куда пишем запись: ручка канала промтов (тот же Карман, другой адрес и свой секрет). */
const PROMPTS_PATH = '/api/prompts';

/** Секрет канала в комнате КАРМАНА — по нему берётся право записи в корзину. */
const PROMPTS_SECRET_VAULT_KEY = 'PROMPTS_INGEST_SECRET';

/**
 * Окно повторов: одно и то же сообщение от одного клиента уходит в корзину
 * не чаще раза в четыре часа (заказ владельца 28.11.2026).
 */
export const BASKET_DEDUP_WINDOW_MS = 4 * 60 * 60_000;

/** Потолок записей на клиента в час. 0 — потолка нет (по умолчанию). */
export const DEFAULT_MAX_PER_CLIENT_PER_HOUR = 0;

/** Пауза перед повторной попыткой, если корзина была недоступна. */
const RETRY_AFTER_MS = 5 * 60_000;

type CriticalSeverity = 'warn' | 'error' | 'fatal';

const SEVERITY_RANK: Record<CriticalSeverity, number> = { warn: 0, error: 1, fatal: 2 };

export type BasketSeverity = 'error' | 'fatal';

export type BasketRule = {
  /** Код события. С `prefix` — начало кода (например, все `server.*.error`). */
  code: string;
  /** Минимальная серьёзность: событие уходит в корзину, только если не ниже. */
  severity: BasketSeverity;
  /** Правило по началу кода, а не по точному совпадению. */
  prefix?: boolean;
};

/**
 * ПЕРЕЧЕНЬ критических событий, которые уходят в корзину промтов.
 *
 * Правило перечня: в корзину идёт **ошибка или критичность** (`error`/`fatal`),
 * но не предупреждение — «предупреждение» это шум, а не задача разработчику.
 * Перечень читается сверху вниз; правило с `prefix` ловит все серверные ошибки
 * неизвестного компонента (код `server.<компонент>.error`).
 *
 * Чего здесь нет и почему:
 *  - `client.sync.network_transient` (warn) — разовый обрыв связи, задачей не является;
 *  - `client.update.full_download` (warn) — телеметрия апдейтера, не ошибка;
 *  - `server.sync.pipeline_poll_misconfigured` / `_transient` (warn) — по замыслу
 *    самих этих правил «не серьёзная ошибка».
 */
export const CRITICAL_EVENTS_TO_BASKET: readonly BasketRule[] = [
  { code: 'client.sqlite.too_many_sql_variables', severity: 'error' },
  { code: 'client.sync.invalid_row', severity: 'error' },
  { code: 'client.sync.blocked_rows', severity: 'error' },
  { code: 'client.sync.pull_gateway_error', severity: 'error' },
  { code: 'client.sync.failed', severity: 'error' },
  { code: 'client.network.net_err', severity: 'error' },
  { code: 'client.auth.refresh_failed', severity: 'error' },
  { code: 'client.backup.failed', severity: 'error' },
  { code: 'client.sync.network_flapping', severity: 'error' },
  { code: 'client.sync.stuck_pending', severity: 'error' },
  { code: 'client.critical.flagged', severity: 'error' },
  { code: 'server.', severity: 'error', prefix: true },
];

/**
 * Что делать по коду события — короткий playbook для разработчика.
 *
 * Правила написания заявок живут в программе-агенте, а не в Матрице; здесь важно,
 * чтобы прилетевшая запись читалась как заявка и не была строчкой лога. Поэтому
 * в записи есть «что случилось», «где», «когда», «версия», «код» и «что делать».
 */
const PLAYBOOK: Record<string, string> = {
  'client.sync.stuck_pending':
    'Очередь отправки на сервер застряла: строки этой машины не уходят, их не видит никто. Найти причину по разбору по таблицам и последней ошибке синка, починить очередь на машине (чаще всего — пересобрать локальную базу или разорвать зависимость), затем убедиться, что счётчик застрявших строк обнулился.',
  'client.sqlite.too_many_sql_variables':
    'Клиент упёрся в лимит параметров SQLite (999 на запрос). Найти запрос, который собирает слишком много параметров, и разбить его на части (или унести во временную таблицу).',
  'client.sync.invalid_row':
    'Сервер отдал клиенту невалидную строку синхронизации. Найти таблицу-источник (она в подробностях) и исправить строку на сервере — иначе клиент будет падать на каждой сверке.',
  'client.sync.blocked_rows':
    'Клиент не может отправить строки: не хватает зависимости (ссылка на ещё не приехавшую строку). Найти таблицу из подробностей и разорвать зависимость — отправить недостающую строку или отбросить её.',
  'client.sync.pull_gateway_error':
    'Прокси отдал 502/503/504 на чтение синхронизации. Проверить состояние бэкенда (оба инстанса) и прокси перед сервером.',
  'client.sync.failed':
    'Синхронизация на клиенте падает. Взять последнюю ошибку синка из подробностей и воспроизвести на этой машине.',
  'client.network.net_err':
    'Сетевая ошибка Chromium на клиенте. Проверить сеть на машине, антивирус и прокси; если машина заNAT или без интернета — снять её с учёта.',
  'client.auth.refresh_failed':
    'Клиент не смог обновить токен авторизации. Проверить срок жизни токена и права на этой машине.',
  'client.backup.failed':
    'Ошибка резервного копирования или доступа к папке бэкапов на клиенте. Проверить свободное место и права на папку.',
  'client.sync.network_flapping':
    'Машина часто теряет связь с сервером (число обрывов — в подробностях). Проверить сеть и антивирус на этой машине.',
  'client.critical.flagged':
    'Клиент прислал событие с критичным флагом: разобрать текст сообщения и подробности.',
  'server.db.invalid_uuid':
    'Сервер получил невалидный UUID для БД. Найти запрос (по подробностям) и починить вызов — иначе операция падает на сервере.',
  'server.sync.schema_guard_failed':
    'Сервер не прошёл проверку схемы синхронизации: клиенты и сервер разошлись по схеме. Сверить хеш схемы и выпустить совместимую сборку.',
  'server.sync.pipeline_poll_conflict':
    'Два потребителя опроса Telegram-бота (409). Проверить, что бот опрашивается в одном экземпляре, и убрать дубль.',
  'server.auth.refresh_failed':
    'Сервер не смог обновить авторизацию. Проверить срок жизни токена и настройки входа.',
  'server.diagnostics.snapshot_failed':
    'Сбой диагностического снимка на сервере. Снимок нужен для сверки и для авто-аларма застрявшей очереди — без него алармы не поднимаются.',
  'server.ai.learning_failed':
    'Сбой фонового обучения чата ИИваныча. Проверить очередь обучения и доступность модели.',
};

const DEFAULT_PLAYBOOK =
  'Открыть в настройках администратора раздел «Критические события», найти событие по коду из записи и разобрать подробности.';

export type BasketMachine = {
  /** Человеческое имя машины (хост). */
  name?: string | null;
  /** Версия программы на машине. */
  version?: string | null;
  /** Кто работал на машине. */
  username?: string | null;
};

export type BasketPrompt = {
  title: string;
  body: string;
};

export type BasketSendResult =
  | { ok: true; promptId: number | null; eventCode: string }
  | {
      ok: false;
      reason: 'not_configured' | 'not_allowed' | 'duplicate' | 'client_cap' | 'send_failed';
      error?: string;
      eventCode: string;
    };

function envText(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] ?? '').trim();
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

function clampText(value: unknown, max: number): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

/**
 * Попадает ли событие в корзину.
 *
 * Правило простое: ошибка или критичность + код из перечня. Предупреждение —
 * не задача разработчику, в корзину не идёт.
 */
export function shouldSendEventToBasket(event: { eventCode: string; severity: string }): boolean {
  const rank = SEVERITY_RANK[event.severity as CriticalSeverity] ?? SEVERITY_RANK.warn;
  if (rank < SEVERITY_RANK.error) return false;
  return CRITICAL_EVENTS_TO_BASKET.some((rule) => {
    if (rank < SEVERITY_RANK[rule.severity]) return false;
    return rule.prefix
      ? String(event.eventCode ?? '').startsWith(rule.code)
      : event.eventCode === rule.code;
  });
}

/**
 * Отпечаток содержания: клиент + суть сообщения.
 *
 * Взят из отпечатка журнала (`event.fingerprint`): он уже устроен правильно —
 * это источник + машина + код + суть. Для застрявшей очереди суть — «машина +
 * счётчик строк», поэтому та же беда с ВЫРОСШИМ счётчиком — новая беда, а не
 * повтор, и в корзину уходит отдельной записью.
 */
export function basketFingerprint(event: CriticalEventRecord): string {
  const fingerprint = String(event.fingerprint ?? '').trim();
  if (fingerprint) return fingerprint;
  const clientId = String(event.clientId ?? '').trim();
  const code = String(event.eventCode ?? '').trim();
  const message = String(event.humanMessage ?? '').trim();
  return `${clientId}|${code}|${message}`;
}

function formatWhen(ms: number): string {
  const ts = Number(ms);
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  try {
    return new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  } catch {
    return new Date(ts).toISOString();
  }
}

function sourceText(source: string): string {
  return source === 'server' ? 'сервер' : 'клиент';
}

/**
 * Запись в корзину читается как заявка: что случилось, где, когда, версия,
 * код события, человеческое сообщение и что делать.
 */
export function buildBasketPrompt(
  event: CriticalEventRecord,
  machine?: BasketMachine | null,
): BasketPrompt {
  const clientId = String(event.clientId ?? '').trim();
  const machineName = clampText(machine?.name, 120);
  const version = clampText(machine?.version, 60);
  const operator = clampText(machine?.username, 120);
  const code = String(event.eventCode ?? '').trim() || 'без кода';
  const title = clampText(event.title, 200) || code;
  const humanMessage = clampText(event.humanMessage, 2_000) || '—';
  const details = clampText(event.aiDetails, 8_000) || '—';

  const lines: string[] = [];
  lines.push(
    'Автоматическая запись из программы «Матрица РМЗ» — не диктовка владельца. Взять в работу по коду события.',
  );
  lines.push('');
  lines.push('## Что случилось');
  lines.push(title);
  lines.push(humanMessage);
  lines.push('');
  lines.push('## Где');
  lines.push(
    `- Машина: ${machineName ? `${machineName} (${clientId || 'id неизвестен'})` : clientId || 'неизвестна'}`,
  );
  lines.push(`- Источник события: ${sourceText(String(event.source ?? ''))}`);
  lines.push(`- Версия программы: ${version || 'неизвестна'}`);
  lines.push(`- Кто работал на машине: ${operator || 'неизвестен'}`);
  lines.push('');
  lines.push('## Когда');
  lines.push(`${formatWhen(Number(event.createdAt ?? 0))} (МСК)`);
  lines.push('');
  lines.push('## Код события');
  lines.push(`- Код: ${code}`);
  lines.push(`- Категория: ${String(event.category ?? 'other')}`);
  lines.push(`- Серьёзность: ${String(event.severity ?? 'error')}`);
  lines.push(`- Запись в журнале: ${String(event.id ?? '')}`);
  lines.push('');
  lines.push('## Что делать');
  lines.push(PLAYBOOK[code] ?? DEFAULT_PLAYBOOK);
  lines.push('');
  lines.push('## Детали для разбора');
  lines.push(details);

  return {
    title: clampText(`Критическое событие: ${title}`, 200),
    body: lines.join('\n'),
  };
}

/* ───────────────────────── адрес и секрет канала ───────────────────────── */

const SECRETS_URL_SUFFIX = '/api/secrets';

export type KarmanPromptsConfig = {
  /** Адрес сервиса (без ручки `/api/prompts`). */
  base: string;
  /** Секрет канала промтов. */
  token: string;
};

/**
 * Адрес ручек промтов: явная настройка, иначе — вывод из адреса хранилища
 * (секреты и промты живут в одном Кармане). Адрес сервиса в репозитории не
 * хранится — это правило репо (публичный репо).
 */
export function resolveKarmanPromptsBase(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = envText(env, 'MATRICA_KARMAN_PROMPTS_URL').replace(/\/+$/, '');
  if (explicit) return explicit;
  const vault = envText(env, 'SECRETS_VAULT_URL').replace(/\/+$/, '');
  if (!vault) return '';
  if (vault.endsWith(SECRETS_URL_SUFFIX)) return vault.slice(0, -SECRETS_URL_SUFFIX.length);
  return vault;
}

/**
 * Секрет канала: сначала env бокса, потом комната КАРМАНА (ключ
 * `PROMPTS_INGEST_SECRET`). Нет секрета — канал просто не настроен (no-op),
 * а не ошибка.
 */
export async function resolveKarmanPromptsConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<KarmanPromptsConfig | null> {
  const base = resolveKarmanPromptsBase(env);
  if (!base) return null;
  const fromEnv = envText(env, 'MATRICA_PROMPTS_INGEST_SECRET');
  const token = fromEnv || (await readVaultSecret(PROMPTS_SECRET_VAULT_KEY).catch(() => null)) || '';
  if (!token) return null;
  return { base, token };
}

/* ────────────────────────────── журнал отправок ──────────────────────────── */

const BASKET_LOG_FILE = 'critical-events-basket.ndjson';

type BasketSentRow = {
  fingerprint: string;
  at: number;
  eventCode: string;
  clientId: string | null;
  promptId: number | null;
};

function defaultLogsDir(): string {
  return process.env.MATRICA_LOGS_DIR?.trim() || 'logs';
}

function basketLogPath(dir: string): string {
  return join(dir, BASKET_LOG_FILE);
}

function readSentRows(dir: string): BasketSentRow[] {
  const path = basketLogPath(dir);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    if (!raw.trim()) return [];
    return raw
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        try {
          const parsed = JSON.parse(trimmed) as BasketSentRow;
          if (!parsed || typeof parsed !== 'object' || !parsed.fingerprint) return null;
          return parsed;
        } catch {
          return null;
        }
      })
      .filter((row): row is BasketSentRow => Boolean(row));
  } catch {
    return [];
  }
}

function appendSentRow(dir: string, row: BasketSentRow): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(basketLogPath(dir), `${JSON.stringify(row)}\n`, 'utf-8');
  } catch (e) {
    logWarn('корзина промтов: не удалось записать отметку об отправке', { error: String(e) });
  }
}

/** Журнал отправок не должен расти вечно: держим неделю. */
function pruneSentRows(dir: string, now: number): void {
  const rows = readSentRows(dir);
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const kept = rows.filter((row) => Number(row.at) >= cutoff);
  if (kept.length === rows.length) return;
  try {
    mkdirSync(dir, { recursive: true });
    const body = kept.map((row) => JSON.stringify(row)).join('\n');
    writeFileSync(basketLogPath(dir), body ? `${body}\n` : '', 'utf-8');
  } catch {
    // журнал отправок — вспомогательный, его потеря не ломает работу
  }
}

/* ─────────────────────────────── сборщик ────────────────────────────────── */

export type KarmanBasketDeps = {
  /** Подмена fetch (тесты). */
  fetchImpl?: typeof fetch;
  /** Время (тесты двигают часы). */
  now?: () => number;
  /** Папка журналов (тесты пишут в свою). */
  logsDir?: string;
  /** Машина по clientId: имя, версия, кто работал. */
  resolveMachine?: (clientId: string | null) => Promise<BasketMachine | null>;
  /** Окно повторов, мс (тесты). */
  windowMs?: number;
  /** Потолок записей на клиента в час; 0 — без потолка. */
  maxPerClientPerHour?: number;
  /** Готовая настройка канала (тесты); в бою — резолвится сама. */
  config?: KarmanPromptsConfig | null;
};

export type KarmanBasketCollector = {
  /** Отправить одно событие в корзину (если оно проходит по перечню и окну). */
  handleEvent(event: CriticalEventRecord): Promise<BasketSendResult>;
  /** Один проход по журналу: забрать новые события и отправить их. */
  tick(): Promise<BasketSendResult[]>;
  /** Пометить события как уже обработанные (то, что лежало в журнале до старта). */
  prime(events: CriticalEventRecord[]): void;
  /** Сбросить состояние (тесты). */
  reset(): void;
};

/**
 * Машина по clientId: имя хоста, версия программы, кто работал.
 *
 * Версию берём из реестра клиентов (`client_settings`): сервер и так знает, чем
 * машина представилась. Если машина неизвестна — пишем «неизвестна», но запись
 * всё равно уходит: неизвестная машина — тоже повод для разбора.
 */
async function resolveMachineFromRegistry(clientId: string | null): Promise<BasketMachine | null> {
  const id = String(clientId ?? '').trim();
  if (!id) return null;
  try {
    const { getOrCreateClientSettings } = await import('./clientSettingsService.js');
    const row = await getOrCreateClientSettings(id);
    return {
      name: row.lastHostname ?? null,
      version: row.lastVersion ?? null,
      username: row.lastUsername ?? null,
    };
  } catch {
    return null;
  }
}

/** Версия программы из подробностей события — если её туда положили. */
function versionFromDetails(event: CriticalEventRecord): string | null {
  const raw = String(event.aiDetails ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const version = String(parsed.appVersion ?? '').trim();
    return version || null;
  } catch {
    return null;
  }
}

/**
 * Создать сборщик. Всё, что ходит наружу и пишет на диск, — через зависимости:
 * тесты не должны ни ходить в сеть, ни писать в боевые логи.
 */
export function createKarmanBasketCollector(deps: KarmanBasketDeps = {}): KarmanBasketCollector {
  const now = deps.now ?? (() => Date.now());
  const dir = deps.logsDir ?? defaultLogsDir();
  const windowMs = deps.windowMs ?? BASKET_DEDUP_WINDOW_MS;
  const maxPerClientPerHour = deps.maxPerClientPerHour ?? DEFAULT_MAX_PER_CLIENT_PER_HOUR;
  const resolveMachine = deps.resolveMachine ?? resolveMachineFromRegistry;
  const fetchImpl = deps.fetchImpl ?? fetch;

  // Уже обработанные события (по id) — чтобы не слать одно и то же событие дважды.
  const seen = new Set<string>();
  // Когда повторить попытку, если корзина была недоступна.
  const retryAt = new Map<string, number>();

  async function config(): Promise<KarmanPromptsConfig | null> {
    if (deps.config !== undefined) return deps.config;
    return await resolveKarmanPromptsConfig();
  }

  async function post(
    prompt: BasketPrompt,
    cfg: KarmanPromptsConfig,
  ): Promise<{ ok: true; id: number | null } | { ok: false; error: string }> {
    try {
      const res = await fetchImpl(`${cfg.base}${PROMPTS_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
          // Разметка потребителя для аудита Кармана — как у клиента пула аккаунтов.
          'X-Matricarmz-Project': KARMAN_PROMPTS_PROJECT,
          'X-Matricarmz-Area': 'critical-events',
        },
        body: JSON.stringify({ project: KARMAN_PROMPTS_PROJECT, title: prompt.title, body: prompt.body }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
      }
      let id: number | null = null;
      try {
        const parsed = text ? (JSON.parse(text) as { id?: unknown }) : null;
        id = typeof parsed?.id === 'number' ? parsed.id : null;
      } catch {
        id = null;
      }
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function handleEvent(event: CriticalEventRecord): Promise<BasketSendResult> {
    const eventCode = String(event.eventCode ?? '');
    if (!shouldSendEventToBasket(event)) {
      return { ok: false, reason: 'not_allowed', eventCode };
    }
    const at = now();
    const fingerprint = basketFingerprint(event);
    const sentRows = readSentRows(dir);
    const alreadySent = sentRows.some(
      (row) => row.fingerprint === fingerprint && at - Number(row.at) < windowMs,
    );
    if (alreadySent) {
      return { ok: false, reason: 'duplicate', eventCode };
    }
    if (maxPerClientPerHour > 0) {
      const id = String(event.clientId ?? '').trim();
      if (id) {
        const hourAgo = at - 60 * 60_000;
        const count = sentRows.filter((row) => row.clientId === id && Number(row.at) >= hourAgo).length;
        if (count >= maxPerClientPerHour) {
          return { ok: false, reason: 'client_cap', eventCode };
        }
      }
    }
    const cfg = await config();
    if (!cfg) {
      return { ok: false, reason: 'not_configured', eventCode };
    }
    const machine = await resolveMachine(event.clientId ?? null).catch(() => null);
    const version = versionFromDetails(event);
    const prompt = buildBasketPrompt(event, {
      ...(machine ?? {}),
      ...(version ? { version } : {}),
    });
    const sent = await post(prompt, cfg);
    if (!sent.ok) {
      // Корзина недоступна — событие остаётся в журнале, программа работает.
      logWarn('корзина промтов: запись не ушла', {
        eventCode,
        eventId: String(event.id ?? ''),
        error: sent.error,
      });
      return { ok: false, reason: 'send_failed', error: sent.error, eventCode };
    }
    appendSentRow(dir, {
      fingerprint,
      at,
      eventCode,
      clientId: event.clientId ?? null,
      promptId: sent.id,
    });
    logInfo(
      'критическое событие ушло в корзину промтов',
      { eventCode, eventId: String(event.id ?? ''), clientId: event.clientId ?? null, promptId: sent.id },
      { critical: true },
    );
    return { ok: true, promptId: sent.id, eventCode };
  }

  async function tick(): Promise<BasketSendResult[]> {
    const results: BasketSendResult[] = [];
    let events: CriticalEventRecord[];
    try {
      events = listCriticalEvents({ days: 3, limit: 1000 });
    } catch (e) {
      logWarn('корзина промтов: журнал критических событий не прочитан', { error: String(e) });
      return results;
    }
    const at = now();
    const ordered = [...events].sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
    for (const event of ordered) {
      if (seen.has(event.id)) continue;
      const nextTry = retryAt.get(event.id);
      if (nextTry != null && nextTry > at) continue;
      const result = await handleEvent(event);
      results.push(result);
      if (result.ok || result.reason === 'duplicate' || result.reason === 'not_allowed' || result.reason === 'client_cap') {
        seen.add(event.id);
      } else {
        // Не ушло (корзина недоступна или не настроена) — попробуем позже.
        retryAt.set(event.id, at + RETRY_AFTER_MS);
      }
    }
    if (seen.size > 5000) {
      seen.clear();
      for (const event of listCriticalEvents({ days: 3, limit: 1000 })) seen.add(event.id);
    }
    pruneSentRows(dir, at);
    return results;
  }

  function prime(events: CriticalEventRecord[]): void {
    for (const event of events) seen.add(event.id);
  }

  function reset(): void {
    seen.clear();
    retryAt.clear();
  }

  return { handleEvent, tick, prime, reset };
}

/* ────────────────────────────── фоновый запуск ───────────────────────────── */

let started = false;
let collector: KarmanBasketCollector | null = null;

const DEFAULT_POLL_MS = 30_000;
const LOOKBACK_DAYS = 3;

/**
 * Фоновый сборщик: сервер читает журнал критических событий и отправляет новые
 * в корзину промтов КАРМАНА.
 *
 * Почему фон, а не «в момент записи»: журнал пишут оба инстанса сервера, а
 * отправка должна идти с одного (иначе запись уйдёт дважды). Так же устроены
 * каналы Telegram и МАКС — тот же готовый приём, второй механизм не заводим.
 */
export function startCriticalEventsKarmanService(): void {
  if (started) return;
  const instanceRole = getInstanceRole();
  if (!shouldRunBackgroundJobs(instanceRole)) {
    logInfo(
      'корзина промтов: сборщик не запущен (не primary)',
      { instanceRole: instanceRole || 'primary' },
      { critical: true },
    );
    return;
  }
  if (!parseBool(process.env.MATRICA_CRITICAL_KARMAN_ENABLED, true)) {
    logInfo(
      'корзина промтов: сборщик выключен (MATRICA_CRITICAL_KARMAN_ENABLED=false)',
      {},
      { critical: true },
    );
    return;
  }
  started = true;

  void (async () => {
    const created = createKarmanBasketCollector({
      maxPerClientPerHour: parseNumber(
        process.env.MATRICA_CRITICAL_BASKET_MAX_PER_CLIENT_PER_HOUR,
        DEFAULT_MAX_PER_CLIENT_PER_HOUR,
        0,
        100,
      ),
    });
    collector = created;
    // События, которые лежат в журнале ДО старта, в корзину не идут: иначе первый
    // же выкат обрушил бы на владельца весь накопленный backlog. В корзину идёт
    // то, что случилось при работающем сборщике; всё остальное остаётся в журнале.
    // (Помечаются события из выборки журнала за последние 3 дня — их не больше тысячи;
    // при большем потоке «до старта» часть всё же уйдёт в корзину — это настоящие
    // события, а не шум.)
    try {
      created.prime(listCriticalEvents({ days: LOOKBACK_DAYS, limit: 1000 }));
    } catch {
      // журнал пуст или недоступен — начинаем с чистого листа
    }
    const pollMs = parseNumber(
      process.env.MATRICA_CRITICAL_KARMAN_POLL_MS,
      DEFAULT_POLL_MS,
      5_000,
      600_000,
    );
    const tick = async () => {
      try {
        await created.tick();
      } catch (error) {
        logWarn('корзина промтов: проход не удался', { error: String(error) });
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), pollMs);
    timer.unref?.();
    // Настроен ли канал — говорим сразу и честно: без секрета канала модуль молчит
    // (события при этом остаются в журнале). Секрет может появиться в комнате позже —
    // тогда канал заработает сам, без перезапуска.
    const cfg = await resolveKarmanPromptsConfig();
    logInfo(
      'корзина промтов: сборщик запущен',
      { project: KARMAN_PROMPTS_PROJECT, pollMs, channelConfigured: cfg !== null },
      { critical: true },
    );
    if (!cfg) {
      logWarn(
        'корзина промтов: канал не настроен — нет адреса или секрета PROMPTS_INGEST_SECRET',
        {},
        { critical: true },
      );
    }
  })();
}

/** Сборщик для тестов и ручной проверки. */
export function getKarmanBasketCollector(): KarmanBasketCollector | null {
  return collector;
}
