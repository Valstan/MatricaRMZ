import type { NextFunction, Request, Response } from 'express';

import type { AuthUser } from './jwt.js';
import { verifyAccessToken } from './jwt.js';
import { hasPermission } from './permissions.js';
import { getEmployeeAuthById, normalizeRole } from '../services/employeeAuthService.js';

export type AuthenticatedRequest = Request & { user: AuthUser };

function extractBearerToken(req: Request): string | null {
  const raw = req.header('authorization') ?? req.header('Authorization') ?? '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1];
  return token ? token.trim() : null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = extractBearerToken(req);
    if (!token) return res.status(401).json({ ok: false, error: 'missing bearer token' });
    const user = await verifyAccessToken(token);
    const auth = await getEmployeeAuthById(user.id);
    if (!auth?.accessEnabled) {
      return res.status(403).json({ ok: false, error: 'user disabled' });
    }
    const login = auth.login?.trim() ? auth.login.trim() : user.username;
    const role = normalizeRole(login, auth.systemRole);
    (req as AuthenticatedRequest).user = { id: user.id, username: login, role };
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }
}

export function requirePermission(permCode: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user?.id) return res.status(401).json({ ok: false, error: 'missing user' });
      const ok = await hasPermission(user.id, permCode);
      if (!ok) return res.status(403).json({ ok: false, error: 'forbidden' });
      return next();
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  };
}


