import { Router } from 'express';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { permissionDelegations, permissions, userPermissions } from '../database/schema.js';
import { hashPassword } from '../auth/password.js';
import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode, defaultPermissionsForRole, getEffectivePermissionsForUser, hasPermission } from '../auth/permissions.js';
import {
  createEmployeeEntity,
  emitEmployeeSyncSnapshot,
  emitEmployeesSyncSnapshotAll,
  ensureEmployeeAuthDefs,
  getEmployeeAuthById,
  getEmployeeProfileById,
  getEmployeeTypeId,
  getSuperadminUserId,
  isLoginTaken,
  isSuperadminLogin,
  listEmployeesAuth,
  normalizeRole,
  setEmployeeAuth,
  setEmployeeDeleteRequest,
  setEmployeeFullName,
  setEmployeeProfile,
} from '../services/employeeAuthService.js';
import { detachIncomingLinksAndSoftDeleteEntity } from '../services/adminMasterdataService.js';
import { reassignUserReferences } from '../services/userDeletionService.js';

export const adminUsersRouter = Router();

adminUsersRouter.use(requireAuth);
adminUsersRouter.use(requirePermission(PermissionCode.AdminUsersManage));

function roleLevel(role: string) {
  const r = String(role ?? '').toLowerCase();
  if (r === 'superadmin') return 2;
  if (r === 'admin') return 1;
  return 0;
}

function ensureManageAllowed(args: {
  actorId: string;
  actorRole: string;
  targetId: string;
  targetLogin: string;
  targetRole: string;
  allowSelfPasswordOnly?: boolean;
  touchingRoleOrAccess: boolean;
}) {
  const actorLevel = roleLevel(args.actorRole);
  const targetLevel = roleLevel(args.targetRole);

  if (actorLevel < 1) return { ok: false as const, error: 'admin only' };

  if (args.actorId === args.targetId) {
    if (actorLevel >= 2) return { ok: true as const };
    if (args.allowSelfPasswordOnly && !args.touchingRoleOrAccess) return { ok: true as const };
    return { ok: false as const, error: 'cannot update own access or role' };
  }

  if (isSuperadminLogin(args.targetLogin) && args.touchingRoleOrAccess && actorLevel < 2) {
    return { ok: false as const, error: 'superadmin role is immutable' };
  }

  if (actorLevel === 1 && (targetLevel > 0 || args.targetRole === 'employee')) {
    return { ok: false as const, error: 'admin can manage only users' };
  }

  return { ok: true as const };
}

async function requestUserDelete(args: { actor: AuthenticatedRequest['user']; targetId: string }) {
  const actor = args.actor;
  const actorRole = String(actor?.role ?? '').toLowerCase();
  if (!actor?.id) return { ok: false as const, error: 'auth required' };
  if (actor.id === args.targetId) return { ok: false as const, error: 'cannot delete self' };

  const target = await getEmployeeAuthById(args.targetId);
  if (!target) return { ok: false as const, error: 'employee not found' };
  const targetRole = normalizeRole(target.login, target.systemRole);
  if (targetRole === 'superadmin' || isSuperadminLogin(target.login)) {
    return { ok: false as const, error: 'superadmin is protected' };
  }
  if (actorRole === 'admin' && targetRole !== 'user') {
    return { ok: false as const, error: 'admin can delete only users' };
  }

  await setEmployeeDeleteRequest(args.targetId, {
    requestedAt: Date.now(),
    requestedById: actor.id,
    requestedByUsername: actor.username,
  });
  return { ok: true as const, mode: 'requested' as const };
}

async function cancelUserDelete(args: { actor: AuthenticatedRequest['user']; targetId: string }) {
  if (!args.actor?.id) return { ok: false as const, error: 'auth required' };
  await setEmployeeDeleteRequest(args.targetId, {
    requestedAt: null,
    requestedById: null,
    requestedByUsername: null,
  });
  return { ok: true as const, mode: 'cancelled' as const };
}

async function confirmUserDelete(args: { actor: AuthenticatedRequest['user']; targetId: string }) {
  const actor = args.actor;
  if (!actor?.id) return { ok: false as const, error: 'auth required' };
  if (actor.id === args.targetId) return { ok: false as const, error: 'cannot delete self' };
  const target = await getEmployeeAuthById(args.targetId);
  if (!target) return { ok: false as const, error: 'employee not found' };
  const targetRole = normalizeRole(target.login, target.systemRole);
  if (targetRole === 'superadmin' || isSuperadminLogin(target.login)) {
    return { ok: false as const, error: 'superadmin is protected' };
  }

  const superadminId = await getSuperadminUserId();
  if (!superadminId) return { ok: false as const, error: 'superadmin not found' };
  const superadmin = await getEmployeeAuthById(superadminId);
  const superadminUsername = superadmin?.fullName || superadmin?.login || superadminId;

  await reassignUserReferences({
    fromUserId: args.targetId,
    toUserId: superadminId,
    toUsername: superadminUsername,
    actor: { id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' },
  });

  const r = await detachIncomingLinksAndSoftDeleteEntity({ id: actor.id, username: actor.username, role: actor.role ?? 'superadmin' }, args.targetId);
  if (!r.ok) return r;
  return { ok: true as const, mode: 'deleted' as const };
}

adminUsersRouter.get('/users', async (_req, res) => {
  try {
    const list = await listEmployeesAuth();
    if (!list.ok) return res.status(500).json({ ok: false, error: list.error });
    const users = list.rows.map((r) => {
      const role = normalizeRole(r.login, r.systemRole);
      const username = r.fullName || r.login || r.id;
      return {
        id: r.id,
        username,
        login: r.login,
        fullName: r.fullName,
        role,
        isActive: r.accessEnabled,
        deleteRequestedAt: r.deleteRequestedAt ?? null,
        deleteRequestedById: r.deleteRequestedById ?? null,
        deleteRequestedByUsername: r.deleteRequestedByUsername ?? null,
      };
    });
    return res.json({ ok: true, users });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.get('/users/access-report', async (_req, res) => {
  try {
    const list = await listEmployeesAuth();
    if (!list.ok) return res.status(500).json({ ok: false, error: list.error });
    const rows = list.rows
      .map((r) => {
        const role = normalizeRole(r.login, r.systemRole);
        const username = r.fullName || r.login || r.id;
        return {
          id: r.id,
          fullName: r.fullName ?? '',
          username,
          login: r.login ?? '',
          role,
          isActive: r.accessEnabled === true,
        };
      })
      .filter((r) => r.isActive && r.role !== 'pending');
    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/users/sync-snapshot', async (_req, res) => {
  try {
    const r = await emitEmployeesSyncSnapshotAll();
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/users', async (req, res) => {
  try {
    const schema = z.object({
      employeeId: z.string().uuid().optional(),
      fullName: z.string().max(200).optional(),
      login: z.string().min(1).max(100),
      password: z.string().min(6).max(500),
      role: z.string().min(1).max(50).default('user'),
      accessEnabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const actor = (req as unknown as AuthenticatedRequest).user;
    const actorRole = String(actor?.role ?? '').toLowerCase();
    const login = parsed.data.login.trim().toLowerCase();
    const role = parsed.data.role.trim().toLowerCase();
    const accessEnabled = parsed.data.accessEnabled ?? true;

    if (await isLoginTaken(login)) return res.status(409).json({ ok: false, error: 'login already exists' });

    const actorLevel = roleLevel(actorRole);
    if (actorLevel < 2) return res.status(403).json({ ok: false, error: 'superadmin only' });
    if (actorLevel === 1 && role !== 'user') return res.status(403).json({ ok: false, error: 'admin can create only users' });
    if (role === 'employee' && actorLevel < 2) {
      return res.status(403).json({ ok: false, error: 'superadmin only' });
    }
    if (isSuperadminLogin(login) && actorLevel < 2) {
      return res.status(403).json({ ok: false, error: 'superadmin login is reserved' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    let employeeId = parsed.data.employeeId;
    const ts = Date.now();

    if (!employeeId) {
      const employeeTypeId = await getEmployeeTypeId();
      if (!employeeTypeId) return res.status(500).json({ ok: false, error: 'employee type not found' });
      employeeId = randomUUID();
      const created = await createEmployeeEntity(employeeId, ts);
      if (!created.ok) return res.status(500).json({ ok: false, error: created.error });
    }

    await ensureEmployeeAuthDefs();
    const finalRole = actorLevel === 1 ? 'user' : role;
    const finalAccess = actorLevel === 1 ? false : accessEnabled;
    await setEmployeeAuth(employeeId, {
      login,
      passwordHash,
      systemRole: finalRole,
      accessEnabled: finalAccess,
    });
    if (parsed.data.fullName) await setEmployeeFullName(employeeId, parsed.data.fullName);

    return res.json({ ok: true, id: employeeId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/users/:id/delete', async (req, res) => {
  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'auth required' });
    const actorRole = String(actor.role ?? '').toLowerCase();
    if (!(await hasPermission(actor.id, PermissionCode.EmployeesCreate))) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (actorRole === 'superadmin') {
      const r = await confirmUserDelete({ actor, targetId: id });
      return res.json(r);
    }
    const r = await requestUserDelete({ actor, targetId: id });
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/users/:id/delete-request', async (req, res) => {
  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'auth required' });
    if (!(await hasPermission(actor.id, PermissionCode.EmployeesCreate))) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const r = await requestUserDelete({ actor, targetId: id });
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/users/:id/delete-confirm', async (req, res) => {
  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'auth required' });
    if (!(await hasPermission(actor.id, PermissionCode.EmployeesCreate))) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (String(actor.role ?? '').toLowerCase() !== 'superadmin') {
      return res.status(403).json({ ok: false, error: 'superadmin only' });
    }
    const r = await confirmUserDelete({ actor, targetId: id });
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/users/:id/delete-cancel', async (req, res) => {
  try {
    const actor = (req as unknown as AuthenticatedRequest).user;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'auth required' });
    if (!(await hasPermission(actor.id, PermissionCode.EmployeesCreate))) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (String(actor.role ?? '').toLowerCase() !== 'superadmin') {
      return res.status(403).json({ ok: false, error: 'superadmin only' });
    }
    const r = await cancelUserDelete({ actor, targetId: id });
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/users/pending/approve', async (req, res) => {
  try {
    const schema = z.object({
      pendingUserId: z.string().uuid(),
      action: z.enum(['approve', 'merge']),
      role: z.enum(['user', 'admin']).optional(),
      targetUserId: z.string().uuid().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const actor = (req as unknown as AuthenticatedRequest).user;
    const actorRole = String(actor?.role ?? '').toLowerCase();
    const actorLevel = roleLevel(actorRole);
    if (actorLevel < 1) return res.status(403).json({ ok: false, error: 'admin only' });

    const pendingId = parsed.data.pendingUserId;
    const pending = await getEmployeeAuthById(pendingId);
    if (!pending) return res.status(404).json({ ok: false, error: 'pending user not found' });
    const pendingRole = normalizeRole(pending.login, pending.systemRole);
    if (pendingRole !== 'pending') return res.status(400).json({ ok: false, error: 'user is not pending' });

    if (parsed.data.action === 'approve') {
      const role = (parsed.data.role ?? 'user').toLowerCase();
      await setEmployeeAuth(pendingId, { systemRole: role, accessEnabled: true });
      await emitEmployeeSyncSnapshot(pendingId);
      return res.json({ ok: true });
    }

    const targetUserId = parsed.data.targetUserId;
    if (!targetUserId) return res.status(400).json({ ok: false, error: 'targetUserId is required for merge' });
    const target = await getEmployeeAuthById(targetUserId);
    if (!target) return res.status(404).json({ ok: false, error: 'target user not found' });

    const pendingProfile = await getEmployeeProfileById(pendingId);
    if (pendingProfile) {
      const patch: { fullName?: string | null; position?: string | null; sectionName?: string | null; chatDisplayName?: string | null } = {};
      if (pendingProfile.fullName?.trim()) patch.fullName = pendingProfile.fullName.trim();
      if (pendingProfile.position?.trim()) patch.position = pendingProfile.position.trim();
      if (pendingProfile.sectionName?.trim()) patch.sectionName = pendingProfile.sectionName.trim();
      if (pendingProfile.chatDisplayName?.trim()) patch.chatDisplayName = pendingProfile.chatDisplayName.trim();
      if (Object.keys(patch).length > 0) {
        const r = await setEmployeeProfile(targetUserId, patch);
        if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
      }
    }

    await setEmployeeAuth(pendingId, { systemRole: 'merged', accessEnabled: false });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.patch('/users/:id', async (req, res) => {
  try {
    const schema = z.object({
      login: z.string().min(1).max(100).optional(),
      fullName: z.string().max(200).optional(),
      role: z.string().min(1).max(50).optional(),
      accessEnabled: z.boolean().optional(),
      password: z.string().min(6).max(500).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const target = await getEmployeeAuthById(id);
    if (!target) return res.status(404).json({ ok: false, error: 'employee not found' });

    const actor = (req as unknown as AuthenticatedRequest).user;
    const actorId = String(actor?.id ?? '');
    const actorRole = String(actor?.role ?? '').toLowerCase();
    const targetRole = normalizeRole(target.login, target.systemRole);

    const touchingRoleOrAccess = parsed.data.role !== undefined || parsed.data.accessEnabled !== undefined;
    const manageGate = ensureManageAllowed({
      actorId,
      actorRole,
      targetId: id,
      targetLogin: target.login,
      targetRole,
      allowSelfPasswordOnly: true,
      touchingRoleOrAccess,
    });
    if (!manageGate.ok) return res.status(403).json({ ok: false, error: manageGate.error });

    if (parsed.data.login && (await isLoginTaken(parsed.data.login, id))) {
      return res.status(409).json({ ok: false, error: 'login already exists' });
    }
    if (parsed.data.login && isSuperadminLogin(parsed.data.login) && roleLevel(actorRole) < 2) {
      return res.status(403).json({ ok: false, error: 'superadmin login is reserved' });
    }

    if (actorRole !== 'superadmin' && (parsed.data.role !== undefined || parsed.data.accessEnabled !== undefined)) {
      return res.status(403).json({ ok: false, error: 'superadmin only for role/access' });
    }
    if (actorRole === 'admin' && parsed.data.role && parsed.data.role.trim().toLowerCase() !== 'user') {
      return res.status(403).json({ ok: false, error: 'admin can assign only user role' });
    }
    if (parsed.data.role && parsed.data.role.trim().toLowerCase() === 'employee' && roleLevel(actorRole) < 2) {
      return res.status(403).json({ ok: false, error: 'superadmin only' });
    }

    if (parsed.data.password) {
      await setEmployeeAuth(id, { passwordHash: await hashPassword(parsed.data.password) });
    }
    if (parsed.data.role || parsed.data.accessEnabled !== undefined || parsed.data.login) {
      const patch: { login?: string | null; systemRole?: string | null; accessEnabled?: boolean | null } = {};
      if (parsed.data.login !== undefined) patch.login = parsed.data.login ? parsed.data.login.trim().toLowerCase() : null;
      if (parsed.data.role !== undefined) patch.systemRole = parsed.data.role ? parsed.data.role.trim().toLowerCase() : 'user';
      if (parsed.data.accessEnabled !== undefined) patch.accessEnabled = parsed.data.accessEnabled;
      await setEmployeeAuth(id, patch);
    }
    if (parsed.data.fullName) await setEmployeeFullName(id, parsed.data.fullName);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.get('/users/:id/permissions', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const userRow = await getEmployeeAuthById(id);
    if (!userRow) return res.status(404).json({ ok: false, error: 'employee not found' });
    const role = normalizeRole(userRow.login, userRow.systemRole);
    const username = userRow.fullName || userRow.login || id;

    const allCodes = Object.values(PermissionCode);
    const effective = await getEffectivePermissionsForUser(id);
    const base = defaultPermissionsForRole(role);

    const overrides = await db
      .select({ permCode: userPermissions.permCode, allowed: userPermissions.allowed })
      .from(userPermissions)
      .where(eq(userPermissions.userId, id))
      .limit(10_000);

    const overridesMap: Record<string, boolean> = {};
    for (const o of overrides) overridesMap[o.permCode] = !!o.allowed;

    return res.json({
      ok: true,
      user: { id, username, login: userRow.login, role, isActive: userRow.accessEnabled },
      allCodes,
      base,
      overrides: overridesMap,
      effective,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.put('/users/:id/permissions', async (req, res) => {
  try {
    const schema = z.object({
      // map permCode -> allowed(true/false)
      set: z.record(z.boolean()),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const actor = (req as unknown as AuthenticatedRequest).user;
    const actorId = String(actor?.id ?? '');
    const actorRole = String(actor?.role ?? '').toLowerCase();

    const target = await getEmployeeAuthById(id);
    if (!target) return res.status(404).json({ ok: false, error: 'employee not found' });
    const targetRole = normalizeRole(target.login, target.systemRole);

    const manageGate = ensureManageAllowed({
      actorId,
      actorRole,
      targetId: id,
      targetLogin: target.login,
      targetRole,
      allowSelfPasswordOnly: false,
      touchingRoleOrAccess: true,
    });
    if (!manageGate.ok) return res.status(403).json({ ok: false, error: manageGate.error });

    // policy: `admin.users.manage` только для role=admin/superadmin
    if (Object.prototype.hasOwnProperty.call(parsed.data.set, PermissionCode.AdminUsersManage)) {
      if (targetRole !== 'admin' && targetRole !== 'superadmin' && parsed.data.set[PermissionCode.AdminUsersManage] === true) {
        return res.status(400).json({ ok: false, error: 'admin.users.manage is allowed only for role=admin' });
      }
    }
    // policy: chat admin permissions only for admin/superadmin
    if (Object.prototype.hasOwnProperty.call(parsed.data.set, PermissionCode.ChatAdminView)) {
      const next = parsed.data.set[PermissionCode.ChatAdminView];
      if ((targetRole === 'admin' || targetRole === 'superadmin') && next === false) {
        return res.status(400).json({ ok: false, error: 'chat.admin.view is required for admin roles' });
      }
      if (targetRole !== 'admin' && targetRole !== 'superadmin' && next === true) {
        return res.status(400).json({ ok: false, error: 'chat.admin.view is allowed only for role=admin' });
      }
    }
    if (Object.prototype.hasOwnProperty.call(parsed.data.set, PermissionCode.ChatExport)) {
      const next = parsed.data.set[PermissionCode.ChatExport];
      if ((targetRole === 'admin' || targetRole === 'superadmin') && next === false) {
        return res.status(400).json({ ok: false, error: 'chat.export is required for admin roles' });
      }
      if (targetRole !== 'admin' && targetRole !== 'superadmin' && next === true) {
        return res.status(400).json({ ok: false, error: 'chat.export is allowed only for role=admin' });
      }
    }

    if (actorRole === 'admin' && targetRole !== 'user') {
      return res.status(403).json({ ok: false, error: 'admin can manage only users' });
    }

    const ts = Date.now();
    const entries = Object.entries(parsed.data.set);
    for (const [permCode, allowed] of entries) {
      await db
        .insert(userPermissions)
        .values({ id: randomUUID(), userId: id, permCode, allowed: !!allowed, createdAt: ts })
        .onConflictDoUpdate({
          target: [userPermissions.userId, userPermissions.permCode],
          set: { allowed: !!allowed, createdAt: ts },
        });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/permissions/seed', async (_req, res) => {
  try {
    const ts = Date.now();
    const codes: [string, string][] = Object.values(PermissionCode).map((c) => [c, c]);
    for (const [code, description] of codes) {
      await db
        .insert(permissions)
        .values({ code, description, createdAt: ts })
        .onConflictDoNothing();
    }
    return res.json({ ok: true, count: codes.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// -----------------------------
// Permission delegations (временные делегирования прав)
// -----------------------------

adminUsersRouter.get('/users/:id/delegations', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const actor = (req as unknown as AuthenticatedRequest).user;
    const actorId = String(actor?.id ?? '');
    const actorRole = String(actor?.role ?? '');

    const target = await getEmployeeAuthById(id);
    if (!target) return res.status(404).json({ ok: false, error: 'employee not found' });
    const targetRole = normalizeRole(target.login, target.systemRole);
    const gate = ensureManageAllowed({
      actorId,
      actorRole,
      targetId: id,
      targetLogin: target.login,
      targetRole,
      allowSelfPasswordOnly: false,
      touchingRoleOrAccess: true,
    });
    if (!gate.ok) return res.status(403).json({ ok: false, error: gate.error });

    const rows = await db
      .select({
        id: permissionDelegations.id,
        fromUserId: permissionDelegations.fromUserId,
        toUserId: permissionDelegations.toUserId,
        permCode: permissionDelegations.permCode,
        startsAt: permissionDelegations.startsAt,
        endsAt: permissionDelegations.endsAt,
        note: permissionDelegations.note,
        createdAt: permissionDelegations.createdAt,
        createdByUserId: permissionDelegations.createdByUserId,
        revokedAt: permissionDelegations.revokedAt,
        revokedByUserId: permissionDelegations.revokedByUserId,
        revokeNote: permissionDelegations.revokeNote,
      })
      .from(permissionDelegations)
      .where(eq(permissionDelegations.toUserId, id))
      .limit(2000);

    return res.json({ ok: true, delegations: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/delegations', async (req, res) => {
  try {
    const schema = z.object({
      fromUserId: z.string().uuid(),
      toUserId: z.string().uuid(),
      permCode: z.string().min(1).max(200),
      // ms epoch
      startsAt: z.number().int().optional(),
      endsAt: z.number().int(),
      note: z.string().max(2000).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });
    const actorId = String(actor.id);
    const actorRole = String(actor.role ?? '').toLowerCase();

    const now = Date.now();
    const startsAt = parsed.data.startsAt ?? now;
    const endsAt = parsed.data.endsAt;
    if (endsAt <= startsAt) return res.status(400).json({ ok: false, error: 'endsAt must be > startsAt' });
    if (endsAt <= now) return res.status(400).json({ ok: false, error: 'endsAt must be in the future' });
    if (parsed.data.fromUserId === parsed.data.toUserId) return res.status(400).json({ ok: false, error: 'cannot delegate to self' });
    if (parsed.data.fromUserId === actorId || parsed.data.toUserId === actorId) {
      return res.status(403).json({ ok: false, error: 'cannot change own permissions' });
    }

    const fromUser = await getEmployeeAuthById(parsed.data.fromUserId);
    const toUser = await getEmployeeAuthById(parsed.data.toUserId);
    if (!fromUser || !toUser) return res.status(404).json({ ok: false, error: 'employee not found' });
    const fromRole = normalizeRole(fromUser.login, fromUser.systemRole);
    const toRole = normalizeRole(toUser.login, toUser.systemRole);

    const gateFrom = ensureManageAllowed({
      actorId,
      actorRole,
      targetId: parsed.data.fromUserId,
      targetLogin: fromUser.login,
      targetRole: fromRole,
      allowSelfPasswordOnly: false,
      touchingRoleOrAccess: true,
    });
    if (!gateFrom.ok) return res.status(403).json({ ok: false, error: gateFrom.error });
    const gateTo = ensureManageAllowed({
      actorId,
      actorRole,
      targetId: parsed.data.toUserId,
      targetLogin: toUser.login,
      targetRole: toRole,
      allowSelfPasswordOnly: false,
      touchingRoleOrAccess: true,
    });
    if (!gateTo.ok) return res.status(403).json({ ok: false, error: gateTo.error });

    // разрешаем делегировать только существующие permissions.code
    const permRow = await db
      .select({ code: permissions.code })
      .from(permissions)
      .where(eq(permissions.code, parsed.data.permCode))
      .limit(1);
    if (!permRow[0]) return res.status(400).json({ ok: false, error: 'unknown permCode' });

    // sanity: делегирующий должен иметь это право сейчас (effective)
    const fromEffective = await getEffectivePermissionsForUser(parsed.data.fromUserId);
    if (fromEffective[parsed.data.permCode] !== true) {
      return res.status(400).json({ ok: false, error: 'fromUser does not have this permission effectively' });
    }

    const id = randomUUID();
    await db.insert(permissionDelegations).values({
      id,
      fromUserId: parsed.data.fromUserId,
      toUserId: parsed.data.toUserId,
      permCode: parsed.data.permCode,
      startsAt,
      endsAt,
      note: parsed.data.note ?? null,
      createdAt: now,
      createdByUserId: actor.id,
      revokedAt: null,
      revokedByUserId: null,
      revokeNote: null,
    });

    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/delegations/:id/revoke', async (req, res) => {
  try {
    const schema = z.object({ note: z.string().max(2000).optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const actor = (req as unknown as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });
    const actorId = String(actor.id);
    const actorRole = String(actor.role ?? '').toLowerCase();

    const existing = await db
      .select({
        id: permissionDelegations.id,
        fromUserId: permissionDelegations.fromUserId,
        toUserId: permissionDelegations.toUserId,
        revokedAt: permissionDelegations.revokedAt,
      })
      .from(permissionDelegations)
      .where(eq(permissionDelegations.id, id))
      .limit(1);
    const delegation = existing[0];
    if (!delegation) return res.status(404).json({ ok: false, error: 'delegation not found' });
    if (delegation.revokedAt) return res.json({ ok: true });
    if (String(delegation.fromUserId) === actorId || String(delegation.toUserId) === actorId) {
      return res.status(403).json({ ok: false, error: 'cannot change own permissions' });
    }

    const fromUser = await getEmployeeAuthById(String(delegation.fromUserId));
    const toUser = await getEmployeeAuthById(String(delegation.toUserId));
    if (!fromUser || !toUser) return res.status(404).json({ ok: false, error: 'employee not found' });
    const fromRole = normalizeRole(fromUser.login, fromUser.systemRole);
    const toRole = normalizeRole(toUser.login, toUser.systemRole);

    const gateFrom = ensureManageAllowed({
      actorId,
      actorRole,
      targetId: String(delegation.fromUserId),
      targetLogin: fromUser.login,
      targetRole: fromRole,
      allowSelfPasswordOnly: false,
      touchingRoleOrAccess: true,
    });
    if (!gateFrom.ok) return res.status(403).json({ ok: false, error: gateFrom.error });
    const gateTo = ensureManageAllowed({
      actorId,
      actorRole,
      targetId: String(delegation.toUserId),
      targetLogin: toUser.login,
      targetRole: toRole,
      allowSelfPasswordOnly: false,
      touchingRoleOrAccess: true,
    });
    if (!gateTo.ok) return res.status(403).json({ ok: false, error: gateTo.error });

    const now = Date.now();
    await db
      .update(permissionDelegations)
      .set({ revokedAt: now, revokedByUserId: actor.id, revokeNote: parsed.data.note ?? null })
      .where(and(eq(permissionDelegations.id, id), isNull(permissionDelegations.revokedAt)));

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


