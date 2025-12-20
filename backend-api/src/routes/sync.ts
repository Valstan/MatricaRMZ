import { Router } from 'express';
import { z } from 'zod';

import { syncPushRequestSchema } from '@matricarmz/shared';
import { applyPushBatch } from '../services/sync/applyPushBatch.js';
import { pullChangesSince } from '../services/sync/pullChangesSince.js';

export const syncRouter = Router();

syncRouter.post('/push', async (req, res) => {
  const parsed = syncPushRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const result = await applyPushBatch(parsed.data);
  return res.json({ ok: true, ...result });
});

syncRouter.get('/pull', async (req, res) => {
  const querySchema = z.object({
    since: z.coerce.number().int().nonnegative().default(0),
  });

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  }

  const response = await pullChangesSince(parsed.data.since);
  return res.json(response);
});


