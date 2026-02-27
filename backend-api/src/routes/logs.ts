import { Router } from 'express';
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { requireAuth, type AuthenticatedRequest } from '../auth/middleware.js';

export const logsRouter = Router();
logsRouter.use(requireAuth);

function logsDir(): string {
  return process.env.MATRICA_LOGS_DIR?.trim() || 'logs';
}

function ensureLogsDir(): void {
  const dir = logsDir();
  mkdirSync(dir, { recursive: true });
}
const CLIENT_LOG_TZ = 'Europe/Moscow';

function currentClientLogDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CLIENT_LOG_TZ }).format(new Date());
}

function pruneOldClientLogs(maxDays = 10): void {
  try {
    const dir = logsDir();
    const entries = readdirSync(dir);
    const cutoff = Date.now() - Math.max(1, maxDays) * 24 * 60 * 60 * 1000;
    for (const name of entries) {
      if (!name.startsWith('client-') || !name.endsWith('.log')) continue;
      const datePart = name.slice('client-'.length, -'.log'.length);
      const ts = Date.parse(`${datePart}T00:00:00Z`);
      if (Number.isFinite(ts) && ts < cutoff) {
        const path = join(dir, name);
        const st = statSync(path, { throwIfNoEntry: false } as any);
        if (st?.isFile()) unlinkSync(path);
      }
    }
  } catch {
    // ignore prune errors
  }
}

logsRouter.post('/client', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const schema = z.object({
      logs: z.array(
        z.object({
          level: z.enum(['info', 'warn', 'error', 'debug']),
          message: z.string(),
          timestamp: z.number().optional(),
          metadata: z.record(z.unknown()).optional(),
        }),
      ),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    ensureLogsDir();
    const logFile = join(logsDir(), `client-${currentClientLogDate()}.log`);

    for (const logEntry of parsed.data.logs) {
      const timestamp = logEntry.timestamp
        ? new Date(logEntry.timestamp).toLocaleString('ru-RU', { timeZone: CLIENT_LOG_TZ })
        : new Date().toLocaleString('ru-RU', { timeZone: CLIENT_LOG_TZ });
      const logLine = `[${timestamp}] [${logEntry.level.toUpperCase()}] [${actor.username}] ${logEntry.message}${logEntry.metadata ? ' ' + JSON.stringify(logEntry.metadata) : ''}\n`;
      appendFileSync(logFile, logLine, 'utf-8');
    }

    pruneOldClientLogs(10);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

