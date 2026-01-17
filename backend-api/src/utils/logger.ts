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
  // eslint-disable-next-line no-console
  console.log(formatLine('info', message, meta));
}

export function logWarn(message: string, meta?: LogMeta, opts?: { critical?: boolean }) {
  if (!shouldLog('warn', opts?.critical === true)) return;
  // eslint-disable-next-line no-console
  console.warn(formatLine('warn', message, meta));
}

export function logError(message: string, meta?: LogMeta) {
  if (!shouldLog('error', true)) return;
  // eslint-disable-next-line no-console
  console.error(formatLine('error', message, meta));
}

export function logDebug(message: string, meta?: LogMeta) {
  if (!shouldLog('debug', false)) return;
  // eslint-disable-next-line no-console
  console.log(formatLine('debug', message, meta));
}
