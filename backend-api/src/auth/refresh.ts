import { createHash, randomBytes } from 'node:crypto';

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateRefreshToken(): string {
  // base64url без '=' для удобства хранения/копирования
  return randomBytes(48).toString('base64url');
}

export function getRefreshTtlDays(): number {
  const raw = process.env.MATRICA_REFRESH_TTL_DAYS ?? '30';
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.max(Math.floor(n), 1), 365);
}


