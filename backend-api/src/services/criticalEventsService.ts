import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type ClientLogLevel = 'info' | 'warn' | 'error' | 'debug';
type ServerLogLevel = 'warn' | 'error';

type CriticalCategory = 'sync' | 'network' | 'database' | 'auth' | 'storage' | 'backend' | 'other';
type CriticalSeverity = 'warn' | 'error' | 'fatal';

export type CriticalEventRecord = {
  id: string;
  createdAt: number;
  source: 'client' | 'server';
  severity: CriticalSeverity;
  category: CriticalCategory;
  eventCode: string;
  title: string;
  humanMessage: string;
  aiDetails: string;
  username: string | null;
  clientId: string | null;
  fingerprint: string;
};

const CRITICAL_EVENTS_FILE = 'critical-events.ndjson';
const RETENTION_DAYS = 10;
const MAX_EVENTS = 10_000;
const DEDUP_WINDOW_MS = 60_000;

let lastPruneAt = 0;
const dedupSeen = new Map<string, number>();

type MatchInfo = {
  code: string;
  title: string;
  category: CriticalCategory;
  severity: CriticalSeverity;
};

const CLIENT_PATTERNS: Array<{ re: RegExp; info: MatchInfo }> = [
  {
    re: /too many sql variables/i,
    info: {
      code: 'client.sqlite.too_many_sql_variables',
      title: 'Клиент уперся в лимит SQLite параметров',
      category: 'database',
      severity: 'error',
    },
  },
  {
    re: /sync_invalid_row/i,
    info: {
      code: 'client.sync.invalid_row',
      title: 'Клиент получил невалидную строку синхронизации',
      category: 'sync',
      severity: 'error',
    },
  },
  {
    re: /pull http (502|503|504)/i,
    info: {
      code: 'client.sync.pull_gateway_error',
      title: 'Ошибка gateway при pull синхронизации',
      category: 'network',
      severity: 'error',
    },
  },
  {
    re: /sync failed/i,
    info: {
      code: 'client.sync.failed',
      title: 'Сбой синхронизации на клиенте',
      category: 'sync',
      severity: 'error',
    },
  },
  {
    re: /net::err_[a-z_]+/i,
    info: {
      code: 'client.network.net_err',
      title: 'Сетевая ошибка клиента Chromium',
      category: 'network',
      severity: 'error',
    },
  },
  {
    re: /auth refresh failed/i,
    info: {
      code: 'client.auth.refresh_failed',
      title: 'Не удалось обновить токен авторизации клиента',
      category: 'auth',
      severity: 'error',
    },
  },
  {
    re: /backup (download|run|list).*(failed|error)/i,
    info: {
      code: 'client.backup.failed',
      title: 'Ошибка резервного копирования/доступа к бэкапу',
      category: 'storage',
      severity: 'error',
    },
  },
];

const SERVER_PATTERNS: Array<{ re: RegExp; info: MatchInfo }> = [
  {
    re: /invalid input syntax for type uuid/i,
    info: {
      code: 'server.db.invalid_uuid',
      title: 'Сервер получил невалидный UUID для БД',
      category: 'database',
      severity: 'fatal',
    },
  },
  {
    re: /sync schema guard failed/i,
    info: {
      code: 'server.sync.schema_guard_failed',
      title: 'Сервер не прошел проверку схемы синхронизации',
      category: 'sync',
      severity: 'fatal',
    },
  },
  {
    re: /sync pipeline bot poll failed/i,
    info: {
      code: 'server.sync.pipeline_poll_failed',
      title: 'Сбой фонового опроса sync pipeline',
      category: 'sync',
      severity: 'error',
    },
  },
  {
    re: /auth refresh failed/i,
    info: {
      code: 'server.auth.refresh_failed',
      title: 'Сервер не смог обновить авторизацию',
      category: 'auth',
      severity: 'error',
    },
  },
  {
    re: /diagnostics snapshot failed/i,
    info: {
      code: 'server.diagnostics.snapshot_failed',
      title: 'Сбой диагностического snapshot на сервере',
      category: 'backend',
      severity: 'error',
    },
  },
  {
    re: /ai chat learning failed/i,
    info: {
      code: 'server.ai.learning_failed',
      title: 'Сбой фонового AI обучения чата',
      category: 'backend',
      severity: 'error',
    },
  },
];

function logsDir(): string {
  return process.env.MATRICA_LOGS_DIR?.trim() || 'logs';
}

function eventsPath(): string {
  return join(logsDir(), CRITICAL_EVENTS_FILE);
}

function ensureLogsDir() {
  mkdirSync(logsDir(), { recursive: true });
}

function safeText(value: unknown, max = 4_000): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function normalizeClientId(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return v ? v : null;
}

function makeAiDetails(payload: Record<string, unknown>): string {
  try {
    return safeText(JSON.stringify(payload, null, 2), 16_000);
  } catch {
    return safeText(String(payload), 16_000);
  }
}

function detectByPattern(text: string, list: Array<{ re: RegExp; info: MatchInfo }>): MatchInfo | null {
  for (const item of list) {
    if (item.re.test(text)) return item.info;
  }
  return null;
}

function shouldKeepServerEvent(level: ServerLogLevel, message: string, meta?: Record<string, unknown>, critical?: boolean): boolean {
  if (critical) return true;
  if (level === 'error') return true;
  const component = String(meta?.component ?? '').toLowerCase();
  if (component === 'sync') return true;
  return /sync|database|gateway|timeout|connection reset|502|503|504/i.test(message);
}

function eventFingerprint(source: 'client' | 'server', username: string | null, clientId: string | null, code: string, message: string): string {
  const raw = `${source}|${username ?? ''}|${clientId ?? ''}|${code}|${message}`;
  return createHash('sha1').update(raw).digest('hex');
}

function shouldSkipDedup(fingerprint: string, now: number): boolean {
  const prev = dedupSeen.get(fingerprint) ?? 0;
  dedupSeen.set(fingerprint, now);
  return prev > 0 && now - prev < DEDUP_WINDOW_MS;
}

function parseLine(line: string): CriticalEventRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as CriticalEventRecord;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.id || !parsed.createdAt || !parsed.eventCode) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readEvents(): CriticalEventRecord[] {
  const path = eventsPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    if (!raw.trim()) return [];
    const rows = raw
      .split('\n')
      .map((line) => parseLine(line))
      .filter((item): item is CriticalEventRecord => Boolean(item));
    return rows;
  } catch {
    return [];
  }
}

function writeEvents(rows: CriticalEventRecord[]) {
  ensureLogsDir();
  const path = eventsPath();
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(path, body ? `${body}\n` : '', 'utf-8');
}

function maybePrune(now: number) {
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const rows = readEvents()
    .filter((row) => Number(row.createdAt) >= cutoff)
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  const trimmed = rows.length > MAX_EVENTS ? rows.slice(rows.length - MAX_EVENTS) : rows;
  writeEvents(trimmed);
}

function appendEvent(event: CriticalEventRecord) {
  const now = Date.now();
  if (shouldSkipDedup(event.fingerprint, now)) return;
  ensureLogsDir();
  appendFileSync(eventsPath(), `${JSON.stringify(event)}\n`, 'utf-8');
  maybePrune(now);
}

export function ingestClientLogForCriticalEvent(args: {
  username: string;
  level: ClientLogLevel;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}) {
  const text = safeText(args.message, 8_000);
  if (!text) return;
  const detected = detectByPattern(text, CLIENT_PATTERNS);
  const isCritical = args.metadata?.critical === true;
  if (!detected && !isCritical) return;

  const info: MatchInfo =
    detected ??
    ({
      code: 'client.critical.flagged',
      title: 'Клиент отправил событие с критичным флагом',
      category: 'other',
      severity: args.level === 'warn' ? 'warn' : 'error',
    } as const);
  const createdAt = Number(args.timestamp ?? Date.now());
  const clientId = normalizeClientId(args.metadata?.clientId);
  const humanMessage = safeText(`${info.title}: ${text}`, 2_000);
  const aiDetails = makeAiDetails({
    source: 'client',
    level: args.level,
    username: args.username,
    clientId,
    message: args.message,
    metadata: args.metadata ?? {},
    timestamp: createdAt,
  });

  appendEvent({
    id: randomUUID(),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    source: 'client',
    severity: info.severity,
    category: info.category,
    eventCode: info.code,
    title: info.title,
    humanMessage,
    aiDetails,
    username: args.username ? String(args.username) : null,
    clientId,
    fingerprint: eventFingerprint('client', args.username, clientId, info.code, text),
  });
}

export function ingestServerLogForCriticalEvent(args: {
  level: ServerLogLevel;
  message: string;
  metadata?: Record<string, unknown>;
  critical?: boolean;
}) {
  const text = safeText(args.message, 8_000);
  if (!text) return;
  if (!shouldKeepServerEvent(args.level, text, args.metadata, args.critical)) return;

  const detected = detectByPattern(text, SERVER_PATTERNS);
  const component = String(args.metadata?.component ?? '').trim().toLowerCase();
  const info: MatchInfo =
    detected ??
    ({
      code: `server.${component || 'general'}.error`,
      title: component ? `Критичная ошибка сервера (${component})` : 'Критичная ошибка сервера',
      category: component === 'sync' ? 'sync' : 'backend',
      severity: args.level === 'warn' ? 'warn' : 'error',
    } as const);

  const humanMessage = safeText(`${info.title}: ${text}`, 2_000);
  const aiDetails = makeAiDetails({
    source: 'server',
    level: args.level,
    message: args.message,
    metadata: args.metadata ?? {},
    timestamp: Date.now(),
  });

  appendEvent({
    id: randomUUID(),
    createdAt: Date.now(),
    source: 'server',
    severity: info.severity,
    category: info.category,
    eventCode: info.code,
    title: info.title,
    humanMessage,
    aiDetails,
    username: null,
    clientId: normalizeClientId(args.metadata?.clientId),
    fingerprint: eventFingerprint('server', null, normalizeClientId(args.metadata?.clientId), info.code, text),
  });
}

export function listCriticalEvents(args?: { days?: number; limit?: number }): CriticalEventRecord[] {
  const days = Math.max(1, Math.min(30, Number(args?.days ?? RETENTION_DAYS)));
  const limit = Math.max(1, Math.min(1_000, Number(args?.limit ?? 300)));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = readEvents()
    .filter((row) => Number(row.createdAt) >= cutoff)
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  return rows.slice(0, limit);
}

