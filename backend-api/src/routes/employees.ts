import { Router } from 'express';

import { requireAuth, requirePermission } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { listEmployeesAuth } from '../services/employeeAuthService.js';

export const employeesRouter = Router();

employeesRouter.use(requireAuth);
employeesRouter.use(requirePermission(PermissionCode.EmployeesCreate));

employeesRouter.get('/access', async (_req, res) => {
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
