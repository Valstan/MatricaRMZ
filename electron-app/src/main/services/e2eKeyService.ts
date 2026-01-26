import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const KEY_FILE = 'ledger-client-key.json';
const MAX_PREVIOUS_KEYS = 5;

export type E2eKeyRing = {
  primary: string;
  previous: string[];
  updatedAt: number;
};

function keyPath() {
  return join(app.getPath('userData'), KEY_FILE);
}

function parseKeyRing(raw: string | null): E2eKeyRing | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<E2eKeyRing> & { keyBase64?: string };
    if (parsed.primary) {
      return {
        primary: String(parsed.primary),
        previous: Array.isArray(parsed.previous) ? parsed.previous.map(String) : [],
        updatedAt: Number(parsed.updatedAt ?? Date.now()),
      };
    }
    if (parsed.keyBase64) {
      return {
        primary: String(parsed.keyBase64),
        previous: [],
        updatedAt: Number(parsed.updatedAt ?? Date.now()),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function saveKeyRing(ring: E2eKeyRing) {
  writeFileSync(keyPath(), JSON.stringify(ring, null, 2));
}

export function loadOrCreateKeyRing(): E2eKeyRing {
  if (existsSync(keyPath())) {
    const existing = parseKeyRing(readFileSync(keyPath(), 'utf8'));
    if (existing) return existing;
  }
  const primary = randomBytes(32).toString('base64');
  const ring: E2eKeyRing = { primary, previous: [], updatedAt: Date.now() };
  saveKeyRing(ring);
  return ring;
}

export function getKeyRing(): E2eKeyRing {
  if (!existsSync(keyPath())) return loadOrCreateKeyRing();
  return loadOrCreateKeyRing();
}

export function rotateKey(): E2eKeyRing {
  const ring = loadOrCreateKeyRing();
  const nextPrimary = randomBytes(32).toString('base64');
  const previous = [ring.primary, ...ring.previous].slice(0, MAX_PREVIOUS_KEYS);
  const next: E2eKeyRing = { primary: nextPrimary, previous, updatedAt: Date.now() };
  saveKeyRing(next);
  return next;
}

export function exportKeyRing(): E2eKeyRing {
  return loadOrCreateKeyRing();
}

export function keyRingToBuffers(ring: E2eKeyRing): Buffer[] {
  const all = [ring.primary, ...ring.previous];
  return all.map((k) => Buffer.from(k, 'base64')).filter((buf) => buf.length > 0);
}
