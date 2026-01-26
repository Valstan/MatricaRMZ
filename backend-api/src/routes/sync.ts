import { Router } from 'express';
import { z } from 'zod';

import { syncPushRequestSchema } from '@matricarmz/shared';
import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { pullChangesSince } from '../services/sync/pullChangesSince.js';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { logError, logInfo } from '../utils/logger.js';

export const syncRouter = Router();

syncRouter.post('/push', async (req, res) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const actor = user?.username ?? 'unknown';
    const parsed = syncPushRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    logInfo('sync push', { user: actor, client_id: parsed.data.client_id, packs: parsed.data.upserts.length }, { critical: true });
    const result = await applyPushBatch(parsed.data, {
      id: user?.id ?? '',
      username: actor,
      role: user?.role ?? '',
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    logError('sync push failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

syncRouter.get('/pull', async (req, res) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const actor = user?.username ?? 'unknown';
    const querySchema = z.object({
      since: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(20000).optional(),
    });

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    logInfo('sync pull', { user: actor, since: parsed.data.since }, { critical: true });
    const response = await pullChangesSince(parsed.data.since, { id: user?.id ?? '', role: user?.role ?? '' }, parsed.data.limit);
    return res.json(response);
  } catch (e) {
    logError('sync pull failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


