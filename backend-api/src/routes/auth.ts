import { Router } from 'express';
import { z } from 'zod';
import { and, eq, gt, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { refreshTokens, users } from '../database/schema.js';
import { signAccessToken, type AuthUser } from '../auth/jwt.js';
import { verifyPassword } from '../auth/password.js';
import { generateRefreshToken, getRefreshTtlDays, hashRefreshToken } from '../auth/refresh.js';
import { requireAuth, type AuthenticatedRequest } from '../auth/middleware.js';
import { randomUUID } from 'node:crypto';
import { getEffectivePermissionsForUser } from '../auth/permissions.js';
import { logError } from '../utils/logger.js';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(500),
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

    const rows = await db
      .select()
      .from(users)
      .where(and(eq(users.username, username), eq(users.isActive, true), isNull(users.deletedAt)))
      .limit(1);
    const u = rows[0];
    if (!u) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    const ok = await verifyPassword(password, u.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    const authUser: AuthUser = { id: u.id, username: u.username, role: u.role };
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

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  const permissions = await getEffectivePermissionsForUser(user.id).catch(() => ({}));
  return res.json({ ok: true, user, permissions });
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

    const userRows = await db
      .select()
      .from(users)
      .where(and(eq(users.id, rt.userId), eq(users.isActive, true), isNull(users.deletedAt)))
      .limit(1);
    const u = userRows[0];
    if (!u) return res.status(401).json({ ok: false, error: 'user disabled' });

    const authUser: AuthUser = { id: u.id, username: u.username, role: u.role };
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


