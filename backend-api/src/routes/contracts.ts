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

/**
 * Двери записи договоров и контрагентов (план contract-cutover-2026-10, C1).
 * Пути — ровно те, что зовёт клиент (`electron-app/src/main/ipc/register/contracts.ts`):
 * `/contracts`, `/contracts/:id`, `/contracts/:id/patch`, `/counterparties`, …
 * Роутеры монтируются в `app.ts` под этими же префиксами, поэтому внутри —
 * пути БЕЗ префикса. 08.10.2026 на проде было наоборот (`/contracts` + `/contracts`
 * внутри = фактический `/contracts/contracts`), и сохранение договора у оператора
 * молча падало 404 четыре дня после cutover 3.61.0 — сервис был жив, маршрут мёртв.
 */
export const contractsRouter = Router();
contractsRouter.use(requireAuth);
contractsRouter.use(requirePermission(PermissionCode.ContractsEdit));

export const counterpartiesRouter = Router();
counterpartiesRouter.use(requireAuth);
counterpartiesRouter.use(requirePermission(PermissionCode.ContractsEdit));

function actorOf(req: unknown): { id: string; username: string; role?: string } {
  const user = (req as AuthenticatedRequest).user ?? {};
  return { id: String(user.id ?? ''), username: String(user.username ?? ''), ...(user.role ? { role: String(user.role) } : {}) };
}

contractsRouter.post('/', async (req, res) => {
  const r = await createContractStrict(req.body, actorOf(req));
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row });
});

contractsRouter.get('/:id', async (req, res) => {
  const r = await getContractStrict(String(req.params.id ?? ''));
  if (!r.ok) return res.status(404).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row });
});

contractsRouter.post('/:id/patch', async (req, res) => {
  const r = await patchContractStrict(String(req.params.id ?? ''), req.body, actorOf(req));
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row, changed: r.changed });
});

counterpartiesRouter.post('/', async (req, res) => {
  const r = await createCounterpartyStrict(req.body, actorOf(req));
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row });
});

counterpartiesRouter.get('/:id', async (req, res) => {
  const r = await getCounterpartyStrict(String(req.params.id ?? ''));
  if (!r.ok) return res.status(404).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row });
});

counterpartiesRouter.post('/:id/patch', async (req, res) => {
  const r = await patchCounterpartyStrict(String(req.params.id ?? ''), req.body, actorOf(req));
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  return res.json({ ok: true, row: r.row, changed: r.changed });
});
