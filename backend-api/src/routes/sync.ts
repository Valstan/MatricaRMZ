import { Router } from 'express';
import { z } from 'zod';

import { syncPushRequestSchema } from '@matricarmz/shared';
import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { pullChangesSince } from '../services/sync/pullChangesSince.js';
import type { AuthenticatedRequest } from '../auth/middleware.js';

export const syncRouter = Router();

syncRouter.post('/push', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user?.username ?? 'unknown';
    const parsed = syncPushRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    console.log(`[sync/push] user=${actor} client_id=${parsed.data.client_id} packs=${parsed.data.upserts.length}`);
    const result = await applyPushBatch(parsed.data);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[sync/push] failed', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

syncRouter.get('/pull', async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user?.username ?? 'unknown';
    const querySchema = z.object({
      since: z.coerce.number().int().nonnegative().default(0),
    });

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    console.log(`[sync/pull] user=${actor} since=${parsed.data.since}`);
    const response = await pullChangesSince(parsed.data.since);
    return res.json(response);
  } catch (e) {
    console.error('[sync/pull] failed', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


