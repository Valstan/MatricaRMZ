import { SignJWT, jwtVerify } from 'jose';

export type AuthUser = {
  id: string;
  username: string;
  role: string;
};

type JwtPayload = {
  sub: string;
  username: string;
  role: string;
};

function getJwtSecret(): Uint8Array {
  const secret = process.env.MATRICA_JWT_SECRET ?? '';
  if (secret.trim().length < 32) {
    throw new Error('MATRICA_JWT_SECRET is not configured (must be 32+ chars)');
  }
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(user: AuthUser): Promise<string> {
  const payload: JwtPayload = { sub: user.id, username: user.username, role: user.role };
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(getJwtSecret());
}

export async function signAccessTokenWithTtl(user: AuthUser, ttlHours: number): Promise<string> {
  const safeHours = Math.max(1, Math.min(24 * 30, Math.floor(Number(ttlHours) || 0)));
  const payload: JwtPayload = { sub: user.id, username: user.username, role: user.role };
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${safeHours}h`)
    .sign(getJwtSecret());
}

export async function verifyAccessToken(token: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, getJwtSecret(), { algorithms: ['HS256'] });
  const sub = String(payload.sub ?? '');
  const username = String((payload as any).username ?? '');
  const role = String((payload as any).role ?? '');
  if (!sub || !username || !role) throw new Error('Invalid token payload');
  return { id: sub, username, role };
}


