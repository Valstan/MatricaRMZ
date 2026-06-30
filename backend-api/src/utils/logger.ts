import { ingestServerLogForCriticalEvent } from '../services/criticalEventsService.js';

type LogMode = 'dev' | 'prod';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogMeta = Record<string, unknown> | undefined;

function getLogMode(): LogMode {
  const raw = String(process.env.MATRICA_LOG_MODE ?? '').trim().toLowerCase();
  if (raw === 'dev' || raw === 'production') return 'dev';
  if (raw === 'prod') return 'prod';
  return process.env.NODE_ENV === 'development' ? 'dev' : 'prod';
}

function shouldLog(level: LogLevel, critical: boolean): boolean {
  if (critical) return true;
  const mode = getLogMode();
  if (mode === 'dev') return true;
  return level === 'warn' || level === 'error';
}

function formatLine(level: LogLevel, message: string, meta?: LogMeta): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (!meta || Object.keys(meta).length === 0) return base;
  return `${base} ${JSON.stringify(meta)}`;
}

export function logInfo(message: string, meta?: LogMeta, opts?: { critical?: boolean }) {
  if (!shouldLog('info', opts?.critical === true)) return;
  console.log(formatLine('info', message, meta));
}

export function logWarn(message: string, meta?: LogMeta, opts?: { critical?: boolean }) {
  if (!shouldLog('warn', opts?.critical === true)) return;
  console.warn(formatLine('warn', message, meta));
  try {
    ingestServerLogForCriticalEvent({
      level: 'warn',
      message,
      ...(meta ? { metadata: meta } : {}),
      critical: opts?.critical === true,
    });
  } catch {
    // ignore monitor logging failures
  }
}

export function logError(message: string, meta?: LogMeta) {
  if (!shouldLog('error', true)) return;
  console.error(formatLine('error', message, meta));
  try {
    ingestServerLogForCriticalEvent({
      level: 'error',
      message,
      ...(meta ? { metadata: meta } : {}),
      critical: true,
    });
  } catch {
    // ignore monitor logging failures
  }
}

export function logDebug(message: string, meta?: LogMeta) {
  if (!shouldLog('debug', false)) return;
  console.log(formatLine('debug', message, meta));
}

// Сериализует ошибку для лога, сохраняя `.cause`. Drizzle оборачивает PG-ошибку в `cause`
// (SQLSTATE `code`, `detail`, `severity`); `String(e)` их теряет — из-за чего обрыв коннекта
// к БД виден в логе лишь как generic «Failed query: …» без настоящей причины. Возвращает
// meta-объект для logError/logWarn (ключ `error` сохранён → дроп-ин замена `{ error: String(e) }`).
export function describeError(e: unknown): Record<string, unknown> {
  const error = String(e);
  const cause = (e as { cause?: unknown } | null | undefined)?.cause;
  if (cause == null) return { error };
  const c = cause as { code?: unknown; detail?: unknown; severity?: unknown };
  return {
    error,
    cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    ...(c.code != null ? { code: String(c.code) } : {}),
    ...(c.detail != null ? { detail: String(c.detail) } : {}),
    ...(c.severity != null ? { severity: String(c.severity) } : {}),
  };
}
