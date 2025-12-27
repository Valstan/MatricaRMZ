import { Router } from 'express';
import { appendFileSync, mkdirSync } from 'node:fs';
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
    const logFile = join(logsDir(), `client-${new Date().toISOString().split('T')[0]}.log`);

    for (const logEntry of parsed.data.logs) {
      const timestamp = logEntry.timestamp ? new Date(logEntry.timestamp).toISOString() : new Date().toISOString();
      const logLine = `[${timestamp}] [${logEntry.level.toUpperCase()}] [${actor.username}] ${logEntry.message}${logEntry.metadata ? ' ' + JSON.stringify(logEntry.metadata) : ''}\n`;
      appendFileSync(logFile, logLine, 'utf-8');
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

