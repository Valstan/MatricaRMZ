import { resolve } from 'node:path';

// Allowlist of filesystem paths that the MAIN process itself produced — a file
// dialog (files:pick) or a server download (files:download / files:original:get).
// Upload / chat-send IPC then accept ONLY these paths, so a (possibly compromised)
// renderer cannot fabricate an arbitrary absolute path to exfiltrate any file on
// disk. Entries expire after a TTL and are NOT removed on consume, so one picked
// file can still be uploaded to several scopes / sent to several recipients.
// (security-hardening-2026-06, Phase 3 — arbitrary-path read fix)

const TTL_MS = 30 * 60_000;
const issued = new Map<string, number>(); // normalized absolute path → expiresAt (ms)

function normalize(p: string): string {
  const abs = resolve(String(p || '').trim());
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function sweep(now: number): void {
  for (const [key, exp] of issued) {
    if (exp <= now) issued.delete(key);
  }
}

export function rememberIssuedPath(p: string): void {
  const raw = String(p || '').trim();
  if (!raw) return;
  issued.set(normalize(raw), Date.now() + TTL_MS);
}

export function consumeIssuedPath(p: string): boolean {
  const raw = String(p || '').trim();
  if (!raw) return false;
  const now = Date.now();
  sweep(now);
  const exp = issued.get(normalize(raw));
  return exp != null && exp > now;
}
