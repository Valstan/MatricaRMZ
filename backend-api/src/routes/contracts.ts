import { Router } from 'express';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import {
  createContractStrict,
  createCounterpartyStrict,
  getContractStrict,
  getCounterpartyStrict,
  patchContractStrict,
  patchCounterpartyStrict,
} from '../services/contractStrictService.js';

export const contractsRouter = Router();

contractsRouter.use(requireAuth);
contractsRouter.use(requirePermission(PermissionCode.ContractsEdit));

function actorOf(req: unknown): { id: string; username: string; role?: string } {
  const user = (req as AuthenticatedRequest).user ?? {};
  return { id: String(user.id ?? ''), username: String(user.username ?? ''), ...(user.role ? { role: String(user.role) } : {}) };
}

contractsRouter.post('/contracts', async (req, res) => {
  const r = await createContractStrict(req.body, actorOf(req));
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row });
});

contractsRouter.get('/contracts/:id', async (req, res) => {
  const r = await getContractStrict(String(req.params.id ?? ''));
  if (!r.ok) return res.status(404).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row });
});

contractsRouter.post('/contracts/:id/patch', async (req, res) => {
  const r = await patchContractStrict(String(req.params.id ?? ''), req.body, actorOf(req));
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row, changed: r.changed });
});

contractsRouter.post('/counterparties', async (req, res) => {
  const r = await createCounterpartyStrict(req.body, actorOf(req));
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row });
});

contractsRouter.get('/counterparties/:id', async (req, res) => {
  const r = await getCounterpartyStrict(String(req.params.id ?? ''));
  if (!r.ok) return res.status(404).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row });
});

contractsRouter.post('/counterparties/:id/patch', async (req, res) => {
  const r = await patchCounterpartyStrict(String(req.params.id ?? ''), req.body, actorOf(req));
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row, changed: r.changed });
});
