import type { NextFunction, Request, Response } from 'express';

import type { AuthUser } from './jwt.js';
import { verifyAccessToken } from './jwt.js';
import { hasPermission } from './permissions.js';

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
    (req as AuthenticatedRequest).user = user;
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


