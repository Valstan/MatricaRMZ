import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Keyring для AES-256-GCM ledger-шифрования.
 *
 * Формат 1 (legacy, до Phase 4): `{ keyBase64: "..." }` — один ключ, шифрование «enc:v1:iv:tag:data».
 * Формат 2 (текущий): `{ keys: [{ id, keyBase64, createdAt }], activeId, version: 2 }` —
 * новый формат «enc:v2:keyId:iv:tag:data», `activeId` указывает, каким ключом шифровать новые записи.
 *
 * Обратная совместимость: legacy-файл прозрачно превращается в keyring с одним ключом id='v1-legacy';
 * `enc:v1:...` декодируется этим ключом, а каждая новая шифровка идёт уже как `enc:v2:<activeId>:...`.
 *
 * Блок-история в `blocks/` НЕ перешифровывается (это нарушит хэши блоков). Только `state.json`
 * (проекция) — её перешифровывает rotateLedgerDataKey CLI. После ротации старые ключи остаются
 * в keyring навсегда, иначе нельзя будет повторить replay блоков.
 */

const V1_LEGACY_KEY_ID = 'v1-legacy';

export type DataKey = {
  id: string;
  keyBase64: string;
  createdAt: number;
};

export type DataKeyring = {
  version: 2;
  activeId: string;
  keys: DataKey[];
};

type LegacyKeyFile = {
  keyBase64: string;
};

type KeyringFile = {
  version: number;
  activeId: string;
  keys: DataKey[];
};

function isLegacyKeyFile(value: unknown): value is LegacyKeyFile {
  return Boolean(value && typeof value === 'object' && typeof (value as Record<string, unknown>).keyBase64 === 'string');
}

function isKeyringFile(value: unknown): value is KeyringFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.keys) && typeof v.activeId === 'string';
}

/** Безопасный seed: 32 байта для AES-256. */
function generateRawKey(): Buffer {
  return randomBytes(32);
}

/** Уникальный id ключа: timestamp + random suffix, без секретов. */
function generateKeyId(now: number = Date.now()): string {
  return `k-${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

export function loadKeyring(keyFilePath: string): DataKeyring | null {
  if (!existsSync(keyFilePath)) return null;
  const raw = readFileSync(keyFilePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (isKeyringFile(parsed)) {
    return {
      version: 2,
      activeId: String(parsed.activeId),
      keys: parsed.keys.map((k) => ({
        id: String(k.id),
        keyBase64: String(k.keyBase64),
        createdAt: Number(k.createdAt) || 0,
      })),
    };
  }

  if (isLegacyKeyFile(parsed)) {
    return {
      version: 2,
      activeId: V1_LEGACY_KEY_ID,
      keys: [
        {
          id: V1_LEGACY_KEY_ID,
          keyBase64: parsed.keyBase64,
          createdAt: 0,
        },
      ],
    };
  }

  return null;
}

export function createInitialKeyring(): DataKeyring {
  const id = generateKeyId();
  return {
    version: 2,
    activeId: id,
    keys: [{ id, keyBase64: generateRawKey().toString('base64'), createdAt: Date.now() }],
  };
}

export function saveKeyring(keyFilePath: string, keyring: DataKeyring): void {
  const serialized: KeyringFile = {
    version: 2,
    activeId: keyring.activeId,
    keys: keyring.keys,
  };
  writeFileSync(keyFilePath, JSON.stringify(serialized, null, 2));
}

/** Добавляет в keyring новый случайный ключ и делает его активным. Возвращает обновлённый keyring и id нового ключа. */
export function rotateAddNewActiveKey(keyring: DataKeyring): { keyring: DataKeyring; newKeyId: string } {
  const id = generateKeyId();
  const next: DataKeyring = {
    version: 2,
    activeId: id,
    keys: [...keyring.keys, { id, keyBase64: generateRawKey().toString('base64'), createdAt: Date.now() }],
  };
  return { keyring: next, newKeyId: id };
}

function getActiveKeyBuffer(keyring: DataKeyring): { id: string; buffer: Buffer } {
  const active = keyring.keys.find((k) => k.id === keyring.activeId);
  if (!active) throw new Error(`ledger keyring: activeId "${keyring.activeId}" not present in keys`);
  return { id: active.id, buffer: Buffer.from(active.keyBase64, 'base64') };
}

function findKeyBuffer(keyring: DataKeyring, keyId: string): Buffer | null {
  const found = keyring.keys.find((k) => k.id === keyId);
  return found ? Buffer.from(found.keyBase64, 'base64') : null;
}

/**
 * Шифрование. Если keyring всё ещё в legacy-режиме (единственный ключ `v1-legacy`),
 * выдаёт совместимый `enc:v1:iv:tag:data` (чтобы не ломать downgrade backend и не требовать миграции).
 * В остальных случаях — `enc:v2:<activeId>:iv:tag:data`.
 *
 * Переход на enc:v2 происходит автоматически при первом `rotateAddNewActiveKey` (новый ключ
 * получает свой id, после чего активный != `v1-legacy`).
 */
export function encryptWithKeyring(plainText: string, keyring: DataKeyring): string {
  const { id, buffer } = getActiveKeyBuffer(keyring);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', buffer, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (id === V1_LEGACY_KEY_ID) {
    return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }
  return `enc:v2:${id}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Расшифровка. Поддерживает:
 *  - `enc:v2:<keyId>:iv:tag:data` — берёт ключ keyId из keyring;
 *  - `enc:v1:iv:tag:data` — берёт ключ id=`v1-legacy` (если он в keyring);
 *  - всё остальное возвращает as-is.
 */
export function decryptWithKeyring(value: string, keyring: DataKeyring): string {
  if (typeof value !== 'string') return value;
  if (value.startsWith('enc:v2:')) {
    const parts = value.split(':');
    if (parts.length !== 6) return value;
    const [, , keyId, ivRaw, tagRaw, dataRaw] = parts;
    if (!keyId || !ivRaw || !tagRaw || !dataRaw) return value;
    const buffer = findKeyBuffer(keyring, keyId);
    if (!buffer) {
      throw new Error(`ledger keyring: unknown keyId "${keyId}" (rotate without removing keys to keep history readable)`);
    }
    const iv = Buffer.from(ivRaw, 'base64');
    const tag = Buffer.from(tagRaw, 'base64');
    const data = Buffer.from(dataRaw, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', buffer, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  }
  if (value.startsWith('enc:v1:')) {
    const parts = value.split(':');
    if (parts.length !== 5) return value;
    const [, , ivRaw, tagRaw, dataRaw] = parts;
    if (!ivRaw || !tagRaw || !dataRaw) return value;
    const buffer = findKeyBuffer(keyring, V1_LEGACY_KEY_ID);
    if (!buffer) {
      throw new Error(`ledger keyring: enc:v1 data present, but legacy key "${V1_LEGACY_KEY_ID}" missing from keyring`);
    }
    const iv = Buffer.from(ivRaw, 'base64');
    const tag = Buffer.from(tagRaw, 'base64');
    const data = Buffer.from(dataRaw, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', buffer, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  }
  return value;
}

export function encryptRowSensitiveWithKeyring(
  row: Record<string, unknown>,
  keyring: DataKeyring,
): Record<string, unknown> {
  const next = { ...row };
  for (const field of ['meta_json', 'payload_json']) {
    const val = next[field];
    if (typeof val === 'string' && val.length > 0) {
      // e2e-client-encrypted значения трогать нельзя.
      if (val.startsWith('enc:e2e:v1:')) continue;
      // Уже зашифровано серверным ключом — не двойное шифрование.
      if (val.startsWith('enc:v1:') || val.startsWith('enc:v2:')) continue;
      next[field] = encryptWithKeyring(val, keyring);
    }
  }
  return next;
}

export function decryptRowSensitiveWithKeyring(
  row: Record<string, unknown>,
  keyring: DataKeyring,
): Record<string, unknown> {
  const next = { ...row };
  for (const field of ['meta_json', 'payload_json']) {
    const val = next[field];
    if (typeof val === 'string' && (val.startsWith('enc:v1:') || val.startsWith('enc:v2:'))) {
      next[field] = decryptWithKeyring(val, keyring);
    }
  }
  return next;
}

/** True если строка зашифрована НЕ активным ключом из keyring (или это legacy v1). Полезно для миграции. */
export function isStaleEncrypted(value: unknown, keyring: DataKeyring): boolean {
  if (typeof value !== 'string') return false;
  if (value.startsWith('enc:v1:')) return true;
  if (value.startsWith('enc:v2:')) {
    const parts = value.split(':');
    if (parts.length !== 6) return false;
    const keyId = parts[2];
    return keyId !== keyring.activeId;
  }
  return false;
}

/** Constants exported for CLI / tests. */
export const DATA_KEYRING_CONSTANTS = {
  V1_LEGACY_KEY_ID,
} as const;
