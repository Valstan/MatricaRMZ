import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { net } from 'electron';
import { eq } from 'drizzle-orm';

import { syncState } from '../database/schema.js';
import { getSession } from './authService.js';
import { authRefresh, clearSession } from './authService.js';

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
    const row = await db.select().from(syncState).where(eq(syncState.key, 'logging.enabled')).limit(1);
    return row[0]?.value === 'true';
  } catch {
    return false;
  }
}

async function setLoggingEnabled(db: BetterSQLite3Database, enabled: boolean): Promise<void> {
  const ts = Date.now();
  await db
    .insert(syncState)
    .values({ key: 'logging.enabled', value: enabled ? 'true' : 'false', updatedAt: ts })
    .onConflictDoUpdate({ target: syncState.key, set: { value: enabled ? 'true' : 'false', updatedAt: ts } });
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
    const url = `${apiBaseUrl}/logs/client`;
    const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` });
    const response = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        logs: logsToSend,
      }),
    });

    if (response.status === 401 || response.status === 403) {
      if (session.refreshToken) {
        const refreshed = await authRefresh(db, { apiBaseUrl, refreshToken: session.refreshToken });
        if (refreshed.ok && refreshed.accessToken) {
          const headers2 = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${refreshed.accessToken}` });
          await net.fetch(url, {
            method: 'POST',
            headers: headers2,
            body: JSON.stringify({
              logs: logsToSend,
            }),
          });
        } else {
          await clearSession(db).catch(() => {});
        }
      } else {
        await clearSession(db).catch(() => {});
      }
    }
  } catch (e) {
    // Игнорируем ошибки отправки логов, чтобы не мешать работе приложения
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
