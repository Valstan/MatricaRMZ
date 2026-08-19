import type { NextFunction, Request, Response } from 'express';

import type { AuthUser } from './jwt.js';
import { verifyAccessToken } from './jwt.js';
import { hasPermission } from './permissions.js';
import { recordRestAuthzDenial } from '../services/authzDenialLog.js';
import { getEmployeeAuthById, normalizeRole } from '../services/employeeAuthService.js';

export type AuthenticatedRequest = Request & { user: AuthUser };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractBearerToken(req: Request): string | null {
  const raw = req.header('authorization') ?? req.header('Authorization') ?? '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1];
  return token ? token.trim() : null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, code: 'token_missing', error: 'missing bearer token' });
  let user: AuthUser;
  try {
    user = await verifyAccessToken(token);
  } catch {
    return res.status(401).json({ ok: false, code: 'token_invalid', error: 'invalid token' });
  }
  if (!UUID_RE.test(user.id)) return res.status(401).json({ ok: false, code: 'token_invalid', error: 'invalid user id in token' });
  let auth: Awaited<ReturnType<typeof getEmployeeAuthById>>;
  try {
    auth = await getEmployeeAuthById(user.id);
  } catch {
    // DB/EAV hiccup is not an auth verdict: 503 keeps clients logged in (M28 tail).
    return res.status(503).json({ ok: false, code: 'auth_backend_unavailable', error: 'auth backend unavailable' });
  }
  if (auth == null) {
    // Auth attribute defs unavailable = infra/seed state, never a user state.
    return res.status(503).json({ ok: false, code: 'auth_defs_unavailable', error: 'auth definitions unavailable' });
  }
  if (!auth.accessEnabled) {
    return res.status(403).json({ ok: false, code: 'user_disabled', error: 'user disabled' });
  }
  const login = auth.login?.trim() ? auth.login.trim() : user.username;
  const role = normalizeRole(login, auth.systemRole);
  (req as AuthenticatedRequest).user = { id: user.id, username: login, role };
  return next();
}

export function requirePermission(permCode: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user?.id) return res.status(401).json({ ok: false, error: 'missing user' });
      const ok = await hasPermission(user.id, permCode);
      if (!ok) {
        recordRestAuthzDenial(user, permCode, req.baseUrl + req.path);
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
      return next();
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  };
}


