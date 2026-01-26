import { Router } from 'express';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { listEmployeesAuth } from '../services/employeeAuthService.js';
import { detachIncomingLinksAndSoftDeleteEntity } from '../services/adminMasterdataService.js';

export const employeesRouter = Router();

employeesRouter.use(requireAuth);

employeesRouter.get('/access', requirePermission(PermissionCode.EmployeesView), async (_req, res) => {
  try {
    const list = await listEmployeesAuth();
    if (!list.ok) return res.status(500).json({ ok: false, error: list.error });
    const rows = list.rows.map((r) => ({
      id: r.id,
      accessEnabled: r.accessEnabled,
      systemRole: r.systemRole,
    }));
    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

employeesRouter.post('/:id/delete', requirePermission(PermissionCode.EmployeesCreate), async (req, res) => {
  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'auth required' });
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    const r = await detachIncomingLinksAndSoftDeleteEntity({ id: actor.id, username: actor.username }, id);
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
