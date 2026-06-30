import { Router } from 'express';
import type { Request, Response } from 'express';

import type { AuthenticatedRequest } from '../auth/middleware.js';
import { globalSearch } from '../services/globalSearchService.js';

export const searchRouter = Router();

// GET /search?q=...&limit=...  — unified server-side search (L3) over heavy datasets.
// Mounted behind requireAuth; per-kind permission filtering happens inside globalSearch.
searchRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthenticatedRequest).user;
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.json({ query: '', hits: [], truncated: false });
    return;
  }
  const rawLimit = Number(req.query.limit);
  const opts = Number.isFinite(rawLimit) && rawLimit > 0 ? { perKindLimit: rawLimit } : {};
  const result = await globalSearch(user.id, q, opts);
  res.json(result);
});
