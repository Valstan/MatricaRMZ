import { Router } from 'express';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { permissions, userPermissions, users } from '../database/schema.js';
import { hashPassword } from '../auth/password.js';
import { requireAuth, requirePermission, type AuthenticatedRequest } from '../auth/middleware.js';
import { PermissionCode, defaultPermissionsForRole, getEffectivePermissionsForUser } from '../auth/permissions.js';

export const adminUsersRouter = Router();

adminUsersRouter.use(requireAuth);
adminUsersRouter.use(requirePermission(PermissionCode.AdminUsersManage));

adminUsersRouter.get('/users', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        isActive: users.isActive,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(isNull(users.deletedAt))
      .limit(5000);
    return res.json({ ok: true, users: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.post('/users', async (req, res) => {
  try {
    const schema = z.object({
      username: z.string().min(1).max(100),
      password: z.string().min(6).max(500),
      role: z.string().min(1).max(50).default('user'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const username = parsed.data.username.trim().toLowerCase();
    const role = parsed.data.role.trim().toLowerCase();
    const ts = Date.now();

    const existing = await db.select({ id: users.id }).from(users).where(and(eq(users.username, username), isNull(users.deletedAt))).limit(1);
    if (existing[0]) return res.status(409).json({ ok: false, error: 'username already exists' });

    const id = randomUUID();
    const passwordHash = await hashPassword(parsed.data.password);
    await db.insert(users).values({
      id,
      username,
      passwordHash,
      role,
      isActive: true,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    });
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.patch('/users/:id', async (req, res) => {
  try {
    const schema = z.object({
      role: z.string().min(1).max(50).optional(),
      isActive: z.boolean().optional(),
      password: z.string().min(6).max(500).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const ts = Date.now();
    const patch: any = { updatedAt: ts };
    if (parsed.data.role) patch.role = parsed.data.role.trim().toLowerCase();
    if (typeof parsed.data.isActive === 'boolean') patch.isActive = parsed.data.isActive;
    if (parsed.data.password) patch.passwordHash = await hashPassword(parsed.data.password);

    await db.update(users).set(patch).where(eq(users.id, id));
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

adminUsersRouter.get('/users/:id/permissions', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });

    const userRow = await db
      .select({ id: users.id, username: users.username, role: users.role })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    if (!userRow[0]) return res.status(404).json({ ok: false, error: 'user not found' });

    const effective = await getEffectivePermissionsForUser(id);
    const base = defaultPermissionsForRole(userRow[0].role);

    const overrides = await db
      .select({ permCode: userPermissions.permCode, allowed: userPermissions.allowed })
      .from(userPermissions)
      .where(eq(userPermissions.userId, id))
      .limit(10_000);

    const overridesMap: Record<string, boolean> = {};
    for (const o of overrides) overridesMap[o.permCode] = !!o.allowed;

    return res.json({ ok: true, user: userRow[0], base, overrides: overridesMap, effective });
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

    // safety: admin не может сам себе отрубить admin.users.manage
    const actor = (req as unknown as AuthenticatedRequest).user;
    if (actor?.id === id && parsed.data.set[PermissionCode.AdminUsersManage] === false) {
      return res.status(400).json({ ok: false, error: 'cannot revoke own admin.users.manage' });
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


