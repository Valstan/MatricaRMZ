import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { getSession } from './authService.js';
import { SettingsKey, settingsGetBoolean, settingsGetString, settingsSetBoolean, settingsSetString } from './settingsStore.js';
import { httpAuthed } from './httpClient.js';

const LOG_BUFFER_MAX = 100;
const LOG_SEND_INTERVAL_MS = 5000; // 5 секунд

type LogEntry = {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

export type LoggingMode = 'dev' | 'prod';

let logBuffer: LogEntry[] = [];
let sendInterval: NodeJS.Timeout | null = null;
let currentApiBaseUrl: string | null = null;

async function getLoggingEnabled(db: BetterSQLite3Database): Promise<boolean> {
  try {
    return await settingsGetBoolean(db, SettingsKey.LoggingEnabled, true);
  } catch {
    return true;
  }
}

async function getLoggingMode(db: BetterSQLite3Database): Promise<LoggingMode> {
  try {
    const raw = await settingsGetString(db, SettingsKey.LoggingMode);
    const v = String(raw ?? '').trim().toLowerCase();
    return v === 'dev' ? 'dev' : 'prod';
  } catch {
    return 'dev';
  }
}

async function setLoggingEnabled(db: BetterSQLite3Database, enabled: boolean): Promise<void> {
  await settingsSetBoolean(db, SettingsKey.LoggingEnabled, enabled);
}

async function setLoggingMode(db: BetterSQLite3Database, mode: LoggingMode): Promise<void> {
  await settingsSetString(db, SettingsKey.LoggingMode, mode);
}

async function sendLogs(db: BetterSQLite3Database, apiBaseUrl: string): Promise<void> {
  if (logBuffer.length === 0) return;
  const enabled = await getLoggingEnabled(db);
  if (!enabled) {
    logBuffer = [];
    return;
  }

  const session = await getSession(db).catch(() => null);
  if (!session?.accessToken) {
    logBuffer = [];
    return;
  }

  const logsToSend = [...logBuffer];
  logBuffer = [];

  try {
    const r = await httpAuthed(
      db,
      apiBaseUrl,
      '/logs/client',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: logsToSend }),
      },
      { timeoutMs: 10_000 },
    );
    // Если отправка не удалась — вернём логи в буфер (с лимитом), чтобы попробовать позже.
    if (!r.ok) {
      logBuffer = [...logsToSend, ...logBuffer].slice(-LOG_BUFFER_MAX);
    }
  } catch {
    // Игнорируем ошибки отправки логов, чтобы не мешать работе приложения
    logBuffer = [...logsToSend, ...logBuffer].slice(-LOG_BUFFER_MAX);
  }
}

export function startLogSender(db: BetterSQLite3Database, apiBaseUrl: string): void {
  currentApiBaseUrl = apiBaseUrl;
  if (sendInterval) return;
  sendInterval = setInterval(() => {
    if (currentApiBaseUrl) {
      void sendLogs(db, currentApiBaseUrl);
    }
  }, LOG_SEND_INTERVAL_MS);
}

export function stopLogSender(): void {
  if (sendInterval) {
    clearInterval(sendInterval);
    sendInterval = null;
  }
}

function shouldSendLog(level: LogEntry['level'], metadata: LogEntry['metadata'], mode: LoggingMode): boolean {
  if (metadata?.critical === true) return true;
  if (mode === 'dev') return true;
  return level === 'warn' || level === 'error';
}

export async function logMessage(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const enabled = await getLoggingEnabled(db);
  if (!enabled) return;
  const mode = await getLoggingMode(db);
  if (!shouldSendLog(level, metadata, mode)) return;

  logBuffer.push({
    level,
    message,
    timestamp: Date.now(),
    metadata,
  });

  if (logBuffer.length >= LOG_BUFFER_MAX) {
    await sendLogs(db, apiBaseUrl);
  }
}

export async function logMessageGetEnabled(db: BetterSQLite3Database): Promise<boolean> {
  return getLoggingEnabled(db);
}

export async function logMessageSetEnabled(db: BetterSQLite3Database, enabled: boolean, apiBaseUrl?: string): Promise<void> {
  await setLoggingEnabled(db, enabled);
  if (!enabled) {
    logBuffer = [];
    stopLogSender();
  } else if (apiBaseUrl) {
    startLogSender(db, apiBaseUrl);
  }
}

export async function logMessageGetMode(db: BetterSQLite3Database): Promise<LoggingMode> {
  return getLoggingMode(db);
}

export async function logMessageSetMode(db: BetterSQLite3Database, mode: LoggingMode): Promise<void> {
  await setLoggingMode(db, mode);
}
