import { Router } from 'express';
import { z } from 'zod';
import { and, eq, gt, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { chatMessages, changeLog, entities, refreshTokens } from '../database/schema.js';
import { signAccessToken, type AuthUser } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { generateRefreshToken, getRefreshTtlDays, hashRefreshToken } from '../auth/refresh.js';
import { requireAuth, type AuthenticatedRequest } from '../auth/middleware.js';
import { randomUUID } from 'node:crypto';
import { PermissionCode, defaultPermissionsForRole, getEffectivePermissionsForUser } from '../auth/permissions.js';
import { userPermissions } from '../database/schema.js';
import { logError } from '../utils/logger.js';
import {
  createEmployeeEntity,
  ensureEmployeeAuthDefs,
  getEmployeeAuthById,
  getEmployeeAuthByLogin,
  getEmployeeTypeId,
  getSuperadminUserId,
  getEmployeeProfileById,
  isLoginTaken,
  isSuperadminLogin,
  normalizeRole,
  setEmployeeAuth,
  setEmployeeProfile,
} from '../services/employeeAuthService.js';
import { SyncTableName } from '@matricarmz/shared';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(500),
});

const registerSchema = z.object({
  login: z.string().min(1).max(100),
  password: z.string().min(6).max(500),
  fullName: z.string().min(1).max(200),
  position: z.string().min(1).max(200),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});

authRouter.post('/login', async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const username = parsed.data.username.trim().toLowerCase();
    const password = parsed.data.password;

    let u = await getEmployeeAuthByLogin(username);
    const isBootstrapSuperadmin = isSuperadminLogin(username) && (!u || !u.passwordHash);
    if (isBootstrapSuperadmin) {
      const employeeTypeId = await getEmployeeTypeId();
      if (!employeeTypeId) return res.status(500).json({ ok: false, error: 'employee type not found' });
      await ensureEmployeeAuthDefs();
      const ts = Date.now();
      const employeeId = u?.id ?? randomUUID();
      if (!u) {
        const created = await createEmployeeEntity(employeeId, ts);
        if (!created.ok) return res.status(500).json({ ok: false, error: created.error });
      }
      const passwordHash = await hashPassword(password);
      await setEmployeeAuth(employeeId, { login: username, passwordHash, systemRole: 'superadmin', accessEnabled: true });
      u = await getEmployeeAuthById(employeeId);
    }

    if (!u || !u.accessEnabled || !u.passwordHash) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    const ok = await verifyPassword(password, u.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    const role = normalizeRole(u.login, u.systemRole);
    if (role === 'employee') return res.status(403).json({ ok: false, error: 'employee has no access' });
    const authUser: AuthUser = { id: u.id, username: u.login, role };
    const accessToken = await signAccessToken(authUser);
    const permissions = await getEffectivePermissionsForUser(u.id);

    const refreshToken = generateRefreshToken();
    const ts = Date.now();
    const expiresAt = ts + getRefreshTtlDays() * 24 * 60 * 60 * 1000;
    await db.insert(refreshTokens).values({
      id: randomUUID(),
      userId: u.id,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt,
      createdAt: ts,
    });

    return res.json({ ok: true, accessToken, refreshToken, user: authUser, permissions });
  } catch (e) {
    logError('auth login failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

authRouter.post('/register', async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const login = parsed.data.login.trim().toLowerCase();
    const password = parsed.data.password;
    const fullName = parsed.data.fullName.trim();
    const position = parsed.data.position.trim();

    if (await isLoginTaken(login)) return res.status(409).json({ ok: false, error: 'login already exists' });
    if (isSuperadminLogin(login)) return res.status(403).json({ ok: false, error: 'superadmin login is reserved' });

    const ts = Date.now();
    const employeeId = randomUUID();
    const created = await createEmployeeEntity(employeeId, ts);
    if (!created.ok) return res.status(500).json({ ok: false, error: created.error });
    await ensureEmployeeAuthDefs();

    const passwordHash = await hashPassword(password);
    await setEmployeeAuth(employeeId, { login, passwordHash, systemRole: 'pending', accessEnabled: true });
    await setEmployeeProfile(employeeId, { fullName, position });

    const superadminId = await getSuperadminUserId();
    if (superadminId) {
      const msgId = randomUUID();
      const bodyText = `Новый пользователь зарегистрировался: ${fullName} (${position}), логин: ${login}.`;
      await db.insert(chatMessages).values({
        id: msgId,
        senderUserId: employeeId as any,
        senderUsername: login,
        recipientUserId: superadminId as any,
        messageType: 'text',
        bodyText,
        payloadJson: null,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      });
      await db.insert(changeLog).values({
        tableName: SyncTableName.ChatMessages,
        rowId: msgId as any,
        op: 'upsert',
        payloadJson: JSON.stringify({
          id: msgId,
          sender_user_id: employeeId,
          sender_username: login,
          recipient_user_id: superadminId,
          message_type: 'text',
          body_text: bodyText,
          payload_json: null,
          created_at: ts,
          updated_at: ts,
          deleted_at: null,
          sync_status: 'synced',
        }),
        createdAt: ts,
      });
    }

    const role = normalizeRole(login, 'pending');
    const authUser: AuthUser = { id: employeeId, username: login, role };
    const accessToken = await signAccessToken(authUser);
    const permissions = await getEffectivePermissionsForUser(employeeId);

    const refreshToken = generateRefreshToken();
    const expiresAt = ts + getRefreshTtlDays() * 24 * 60 * 60 * 1000;
    await db.insert(refreshTokens).values({
      id: randomUUID(),
      userId: employeeId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt,
      createdAt: ts,
    });

    return res.json({ ok: true, accessToken, refreshToken, user: authUser, permissions });
  } catch (e) {
    logError('auth register failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const permissions = await getEffectivePermissionsForUser(user.id).catch(() => ({}));
  return res.json({ ok: true, user, permissions });
});

authRouter.get('/users/:id/permissions-view', requireAuth, async (req, res) => {
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
    logError('auth permissions view failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

authRouter.get('/profile', requireAuth, async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });
    const profile = await getEmployeeProfileById(actor.id);
    if (!profile) return res.status(404).json({ ok: false, error: 'profile not found' });
    return res.json({ ok: true, profile });
  } catch (e) {
    logError('auth profile get failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

authRouter.patch('/profile', requireAuth, async (req, res) => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });
    const schema = z.object({
      fullName: z.string().max(200).optional().nullable(),
      position: z.string().max(200).optional().nullable(),
      sectionName: z.string().max(200).optional().nullable(),
      chatDisplayName: z.string().max(80).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const patch: { fullName?: string | null; position?: string | null; sectionName?: string | null; chatDisplayName?: string | null } = {};
    if (parsed.data.fullName !== undefined) patch.fullName = parsed.data.fullName;
    if (parsed.data.position !== undefined) patch.position = parsed.data.position;
    if (parsed.data.sectionName !== undefined) patch.sectionName = parsed.data.sectionName;
    if (parsed.data.chatDisplayName !== undefined) patch.chatDisplayName = parsed.data.chatDisplayName;
    const r = await setEmployeeProfile(actor.id, patch);
    if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
    const profile = await getEmployeeProfileById(actor.id);
    return res.json({ ok: true, profile });
  } catch (e) {
    logError('auth profile update failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

authRouter.post('/refresh', async (req, res) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const inToken = parsed.data.refreshToken;
    const tokenHash = hashRefreshToken(inToken);

    const now = Date.now();
    const rows = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), gt(refreshTokens.expiresAt, now)))
      .limit(1);
    const rt = rows[0];
    if (!rt) return res.status(401).json({ ok: false, error: 'invalid refresh token' });

    const u = await getEmployeeAuthById(String(rt.userId));
    if (!u || !u.accessEnabled || !u.login) return res.status(401).json({ ok: false, error: 'user disabled' });

    const role = normalizeRole(u.login, u.systemRole);
    if (role === 'employee') return res.status(403).json({ ok: false, error: 'employee has no access' });
    const authUser: AuthUser = { id: u.id, username: u.login, role };
    const accessToken = await signAccessToken(authUser);
    const permissions = await getEffectivePermissionsForUser(u.id);

    // Rotation refresh token: удаляем старый, выдаём новый.
    const newRefreshToken = generateRefreshToken();
    const expiresAt = now + getRefreshTtlDays() * 24 * 60 * 60 * 1000;
    await db.delete(refreshTokens).where(eq(refreshTokens.id, rt.id));
    await db.insert(refreshTokens).values({
      id: randomUUID(),
      userId: u.id,
      tokenHash: hashRefreshToken(newRefreshToken),
      expiresAt,
      createdAt: now,
    });

    return res.json({ ok: true, accessToken, refreshToken: newRefreshToken, user: authUser, permissions });
  } catch (e) {
    logError('auth refresh failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const tokenHash = hashRefreshToken(parsed.data.refreshToken);
    await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
    return res.json({ ok: true });
  } catch (e) {
    logError('auth logout failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  try {
    const schema = z.object({
      currentPassword: z.string().min(1).max(500),
      newPassword: z.string().min(6).max(500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) return res.status(401).json({ ok: false, error: 'missing user' });

    const u = await getEmployeeAuthById(actor.id);
    if (!u || !u.accessEnabled || !u.passwordHash) return res.status(403).json({ ok: false, error: 'user disabled' });

    const ok = await verifyPassword(parsed.data.currentPassword, u.passwordHash);
    if (!ok) return res.status(400).json({ ok: false, error: 'invalid current password' });

    const passwordHash = await hashPassword(parsed.data.newPassword);
    const r = await setEmployeeAuth(actor.id, { passwordHash });
    if (!r.ok) return res.status(500).json({ ok: false, error: r.error });

    return res.json({ ok: true });
  } catch (e) {
    logError('auth change-password failed', { error: String(e) });
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


