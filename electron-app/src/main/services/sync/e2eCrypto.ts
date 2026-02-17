/**
 * E2E encryption/decryption for sync row sensitive fields.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { getKeyRing, keyRingToBuffers } from '../e2eKeyService.js';

const LEDGER_E2E_ENV = 'MATRICA_LEDGER_E2E';
const SENSITIVE_FIELDS = ['meta_json', 'payload_json'] as const;

export function isE2eEnabled(): boolean {
  return String(process.env[LEDGER_E2E_ENV] ?? '') === '1';
}

export function getE2eKeys(): { primary: Buffer | null; all: Buffer[] } {
  if (!isE2eEnabled()) return { primary: null, all: [] };
  const ring = getKeyRing();
  const all = keyRingToBuffers(ring);
  const primary = all[0] ?? null;
  return { primary, all };
}

function encryptTextE2e(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:e2e:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptTextE2e(value: string, key: Buffer): string {
  if (!value.startsWith('enc:e2e:v1:')) return value;
  const parts = value.split(':');
  if (parts.length !== 6) return value;
  const ivPart = parts[3];
  const tagPart = parts[4];
  const dataPart = parts[5];
  if (!ivPart || !tagPart || !dataPart) return value;
  const iv = Buffer.from(ivPart, 'base64');
  const tag = Buffer.from(tagPart, 'base64');
  const data = Buffer.from(dataPart, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

export function encryptRowSensitive(row: Record<string, unknown>, key: Buffer | null): Record<string, unknown> {
  if (!key) return row;
  const next = { ...row };
  for (const field of SENSITIVE_FIELDS) {
    const val = next[field];
    if (typeof val === 'string' && val.length > 0 && !val.startsWith('enc:e2e:v1:')) {
      next[field] = encryptTextE2e(val, key);
    }
  }
  return next;
}

export function decryptRowSensitive(row: Record<string, unknown>, keys: Buffer[]): Record<string, unknown> {
  if (!keys.length) return row;
  const next = { ...row };
  for (const field of SENSITIVE_FIELDS) {
    const val = next[field];
    if (typeof val === 'string' && val.startsWith('enc:e2e:v1:')) {
      let decrypted: string | null = null;
      for (const key of keys) {
        try {
          decrypted = decryptTextE2e(val, key);
          break;
        } catch {
          decrypted = null;
        }
      }
      if (decrypted != null) next[field] = decrypted;
    }
  }
  return next;
}
