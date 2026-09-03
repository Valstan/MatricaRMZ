// Attachments up to MAX_LOCAL_BYTES stay on the box (MATRICA_UPLOADS_DIR), larger ones go
// to Yandex.Disk. One knob, read by the upload route and by files:offload-to-yandex, so the
// two never disagree about where the boundary is.

export const DEFAULT_MAX_LOCAL_BYTES = 10 * 1024 * 1024;

export function parseBytesEnv(raw: string | undefined, fallback: number, name = 'MATRICA_MAX_LOCAL_BYTES'): number {
  const s = (raw ?? '').trim();
  if (!s) return fallback;
  if (!/^\d+$/.test(s)) throw new Error(`${name}: ожидается целое число байт без суффиксов, получено "${s}"`);
  return Number(s);
}

export function maxLocalBytes(env: NodeJS.ProcessEnv = process.env): number {
  return parseBytesEnv(env.MATRICA_MAX_LOCAL_BYTES, DEFAULT_MAX_LOCAL_BYTES);
}
