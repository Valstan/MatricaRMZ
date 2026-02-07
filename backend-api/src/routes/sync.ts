import { Router } from 'express';

export const syncRouter = Router();

syncRouter.post('/push', (_req, res) => {
  return res.status(410).json({ ok: false, error: 'sync push disabled: use /ledger/tx/submit' });
});

syncRouter.get('/pull', (_req, res) => {
  return res.status(410).json({ ok: false, error: 'sync pull disabled: use /ledger/state/changes' });
});


