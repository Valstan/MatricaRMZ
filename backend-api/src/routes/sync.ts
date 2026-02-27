import { Router } from 'express';

export const syncRouter = Router();

syncRouter.post('/push', (_req, res) => {
  return res.status(410).json({ ok: false, error: 'синхронизация push отключена: используйте /ledger/tx/submit' });
});

syncRouter.get('/pull', (_req, res) => {
  return res.status(410).json({ ok: false, error: 'синхронизация pull отключена: используйте /ledger/state/changes' });
});


