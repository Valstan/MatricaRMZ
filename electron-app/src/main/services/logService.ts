import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { getSession } from './authService.js';
import { SettingsKey, settingsGetBoolean, settingsSetBoolean } from './settingsStore.js';
import { httpAuthed } from './httpClient.js';

const LOG_BUFFER_MAX = 100;
const LOG_SEND_INTERVAL_MS = 5000; // 5 секунд

type LogEntry = {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

let logBuffer: LogEntry[] = [];
let sendInterval: NodeJS.Timeout | null = null;
let currentApiBaseUrl: string | null = null;

async function getLoggingEnabled(db: BetterSQLite3Database): Promise<boolean> {
  try {
    return await settingsGetBoolean(db, SettingsKey.LoggingEnabled, false);
  } catch {
    return false;
  }
}

async function setLoggingEnabled(db: BetterSQLite3Database, enabled: boolean): Promise<void> {
  await settingsSetBoolean(db, SettingsKey.LoggingEnabled, enabled);
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

export async function logMessage(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const enabled = await getLoggingEnabled(db);
  if (!enabled) return;

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
