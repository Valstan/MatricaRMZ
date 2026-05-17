import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createInitialKeyring,
  decryptRowSensitiveWithKeyring,
  decryptWithKeyring,
  encryptRowSensitiveWithKeyring,
  encryptWithKeyring,
  isStaleEncrypted,
  loadKeyring,
  rotateAddNewActiveKey,
  saveKeyring,
  DATA_KEYRING_CONSTANTS,
} from './dataKeyring.js';

function tmpKeyFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ledger-keyring-')), 'data-key.json');
}

describe('dataKeyring', () => {
  it('roundtrips encrypt/decrypt with single-key keyring', () => {
    const keyring = createInitialKeyring();
    const original = 'hello world {"a":1}';
    const enc = encryptWithKeyring(original, keyring);
    expect(enc.startsWith('enc:v2:')).toBe(true);
    expect(enc.split(':')[2]).toBe(keyring.activeId);
    expect(decryptWithKeyring(enc, keyring)).toBe(original);
  });

  it('legacy {keyBase64} file: загружается как v1-legacy keyring, шифрует в enc:v1 (downgrade-safe)', () => {
    const path = tmpKeyFile();
    const legacyKey = Buffer.from('0'.repeat(32), 'utf8').toString('base64');
    writeFileSync(path, JSON.stringify({ keyBase64: legacyKey }));
    const keyring = loadKeyring(path);
    expect(keyring).not.toBeNull();
    expect(keyring!.activeId).toBe(DATA_KEYRING_CONSTANTS.V1_LEGACY_KEY_ID);
    expect(keyring!.keys[0]!.id).toBe(DATA_KEYRING_CONSTANTS.V1_LEGACY_KEY_ID);

    const enc = encryptWithKeyring('payload', keyring!);
    // Пока keyring legacy — пишем enc:v1, чтобы старый backend мог прочитать без миграции.
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(decryptWithKeyring(enc, keyring!)).toBe('payload');
  });

  it('rotates key: new active id, old keys remain in ring; both old and new ciphertexts decrypt', () => {
    const k1 = createInitialKeyring();
    const old = encryptWithKeyring('old-value', k1);
    const { keyring: k2, newKeyId } = rotateAddNewActiveKey(k1);
    const fresh = encryptWithKeyring('new-value', k2);

    expect(newKeyId).not.toBe(k1.activeId);
    expect(k2.activeId).toBe(newKeyId);
    expect(k2.keys).toHaveLength(2);

    // Старый ciphertext всё ещё читается (старый ключ остался в keyring).
    expect(decryptWithKeyring(old, k2)).toBe('old-value');
    // Новый ciphertext читается активным ключом.
    expect(decryptWithKeyring(fresh, k2)).toBe('new-value');
  });

  it('throws on unknown keyId in enc:v2 (defensive)', () => {
    const k = createInitialKeyring();
    const ct = encryptWithKeyring('x', k);
    const parts = ct.split(':');
    parts[2] = 'unknown-id'; // ломаем keyId
    const tampered = parts.join(':');
    expect(() => decryptWithKeyring(tampered, k)).toThrow(/unknown keyId/);
  });

  it('persists keyring to disk and reloads identically', () => {
    const path = tmpKeyFile();
    const original = createInitialKeyring();
    saveKeyring(path, original);
    const reloaded = loadKeyring(path);
    expect(reloaded).toEqual(original);
    // На диске реально хранится формат версии 2.
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk.version).toBe(2);
    expect(Array.isArray(onDisk.keys)).toBe(true);
  });

  it('encryptRowSensitive шифрует meta_json/payload_json, e2e-payload не трогает, повторно не шифрует', () => {
    const k = createInitialKeyring();
    const row = {
      id: '1',
      meta_json: '{"a":1}',
      payload_json: '{"b":2}',
      e2e_field: 'enc:e2e:v1:should-stay',
      already: 'enc:v2:fake-id:aaa:bbb:ccc',
      other: 'plain',
    } as Record<string, unknown>;

    const enc = encryptRowSensitiveWithKeyring({ ...row, payload_json: row.e2e_field as string }, k);
    expect(String(enc.payload_json)).toBe('enc:e2e:v1:should-stay'); // не тронуто

    const enc2 = encryptRowSensitiveWithKeyring(row, k);
    expect(String(enc2.meta_json).startsWith('enc:v2:')).toBe(true);
    expect(String(enc2.payload_json).startsWith('enc:v2:')).toBe(true);
    expect(enc2.other).toBe('plain');
    // повторный вызов на уже зашифрованной строке не делает двойного шифрования
    const enc3 = encryptRowSensitiveWithKeyring(enc2, k);
    expect(enc3.meta_json).toBe(enc2.meta_json);
    expect(enc3.payload_json).toBe(enc2.payload_json);

    const dec = decryptRowSensitiveWithKeyring(enc2, k);
    expect(dec.meta_json).toBe('{"a":1}');
    expect(dec.payload_json).toBe('{"b":2}');
  });

  it('isStaleEncrypted: true для enc:v1 и для enc:v2 с не-активным id; false для активного / plain', () => {
    const k = createInitialKeyring();
    const ct = encryptWithKeyring('x', k);
    expect(isStaleEncrypted(ct, k)).toBe(false);

    const { keyring: rotated } = rotateAddNewActiveKey(k);
    // Прежний ciphertext был зашифрован старым ключом => теперь stale.
    expect(isStaleEncrypted(ct, rotated)).toBe(true);

    expect(isStaleEncrypted('enc:v1:iv:tag:data', rotated)).toBe(true);
    expect(isStaleEncrypted('plain text', rotated)).toBe(false);
    expect(isStaleEncrypted(undefined as unknown, rotated)).toBe(false);
  });
});
