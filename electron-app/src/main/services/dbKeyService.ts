import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Encryption key for the local SQLite (docs/plans/_archive/sqlcipher-client-db-2026-07.md).
// Same on-disk pattern as the E2E ledger key (#607): {enc,data} wrapper, safeStorage
// (DPAPI on Windows) when available. The DB is a server cache — if this key is ever
// lost the existing self-heal path recreates the DB and re-pulls, so unlike the
// ledger key an unreadable file here mints a fresh key instead of failing loudly.

const KEY_FILE = 'db-key.json';

type StoredKey = { enc: boolean; data: string };

function keyPath() {
  return join(app.getPath('userData'), KEY_FILE);
}

function atomicWrite(path: string, content: string) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function writeKey(hexKey: string): void {
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const stored: StoredKey = canEncrypt
    ? { enc: true, data: safeStorage.encryptString(hexKey).toString('hex') }
    : { enc: false, data: hexKey };
  atomicWrite(keyPath(), JSON.stringify(stored));
}

function readKey(): string | null {
  const path = keyPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredKey> | null;
    if (!parsed || typeof parsed.data !== 'string' || !parsed.data) return null;
    if (parsed.enc) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(parsed.data, 'hex'));
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Returns the hex key for the local DB, minting one on first run.
 * Returns null when the host has no OS keyring (safeStorage unavailable) AND no
 * plaintext-wrapped key exists — callers then open the DB unencrypted (availability
 * over encryption on such hosts; Windows always has DPAPI).
 */
export function loadOrCreateDbKey(log: (line: string) => void): string | null {
  const existing = readKey();
  if (existing) return existing;
  if (existsSync(keyPath())) {
    // File exists but is unreadable (corrupt / decrypt failed). The DB it guarded is
    // unreadable too — mint a fresh key and let the DB self-heal path recreate + re-pull.
    log('db-key unreadable — minting a fresh key (DB will self-heal and re-sync)');
  }
  const hexKey = randomBytes(32).toString('hex');
  try {
    writeKey(hexKey);
  } catch (e) {
    log(`db-key write failed — running with unencrypted DB: ${String(e)}`);
    return null;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    log('safeStorage unavailable — db-key stored without OS-keyring wrapping');
  }
  return hexKey;
}
