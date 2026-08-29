import { Router } from 'express';

import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode } from '../auth/permissions.js';
import { getEmployeeAuthById, getEmployeeTypeId, isSuperadminLogin, listEmployeesAuth, normalizeRole } from '../services/employeeAuthService.js';
import { db } from '../database/db.js';
import { entities } from '../database/schema.js';
import { eq } from 'drizzle-orm';
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
      deleteRequestedAt: r.deleteRequestedAt ?? null,
      deleteRequestedById: r.deleteRequestedById ?? null,
      deleteRequestedByUsername: r.deleteRequestedByUsername ?? null,
    }));
    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

employeesRouter.post('/:id/delete', requirePermission(PermissionCode.EmployeesCreate), async (req, res) => {
  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'требуется авторизация' });
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id не указан' });
    // Роут принимал ЛЮБОЙ id сущности и мягко удалял её по праву employees.create
    // — включая карточку суперадмина, договоры, двигатели. Ограничиваем типом и
    // защищаем аккаунты старше актора; полный набор гейтов удаления учётки живёт
    // в /admin/users/:id/delete*. (аудит 2026-08-29)
    const employeeTypeId = await getEmployeeTypeId();
    const row = await db.select({ typeId: entities.typeId }).from(entities).where(eq(entities.id, id as any)).limit(1);
    if (!row[0]) return res.status(404).json({ ok: false, error: 'сотрудник не найден' });
    if (!employeeTypeId || String(row[0].typeId) !== String(employeeTypeId)) {
      return res.status(400).json({ ok: false, error: 'этим путём удаляются только сотрудники' });
    }
    const target = await getEmployeeAuthById(id);
    if (target) {
      const targetRole = normalizeRole(target.login, target.systemRole);
      const actorRole = String(actor.role ?? '').toLowerCase();
      if (targetRole === 'superadmin' || isSuperadminLogin(target.login)) {
        return res.status(403).json({ ok: false, error: 'учётная запись супер-админа не удаляется' });
      }
      if (targetRole === 'admin' && actorRole !== 'superadmin') {
        return res.status(403).json({ ok: false, error: 'администратор не может удалять других админов' });
      }
    }
    const r = await detachIncomingLinksAndSoftDeleteEntity({ id: actor.id, username: actor.username }, id);
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
