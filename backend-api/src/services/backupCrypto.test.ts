import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decryptFileHybrid, encryptFileHybrid, normalizeKeyMaterial, parseBackupHeader } from './backupCrypto.js';

const pair = generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-crypto-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('backupCrypto', () => {
  it('round-trips a payload larger than a single stream chunk', async () => {
    const plain = join(dir, 'plain.bin');
    const enc = join(dir, 'plain.bin.enc');
    const back = join(dir, 'plain.roundtrip.bin');
    const payload = randomBytes(3 * 1024 * 1024);
    writeFileSync(plain, payload);

    await encryptFileHybrid({ inPath: plain, outPath: enc, publicKeyPem: pair.publicKey });
    await decryptFileHybrid({ inPath: enc, outPath: back, privateKeyPem: pair.privateKey });

    expect(readFileSync(back).equals(payload)).toBe(true);
  });

  it('does not leave the plaintext recognizable in the ciphertext', async () => {
    const plain = join(dir, 'marker.txt');
    const enc = join(dir, 'marker.txt.enc');
    writeFileSync(plain, 'PGDMP secret payroll data');

    await encryptFileHybrid({ inPath: plain, outPath: enc, publicKeyPem: pair.publicKey });

    const cipher = readFileSync(enc);
    expect(cipher.includes(Buffer.from('secret payroll data'))).toBe(false);
    expect(parseBackupHeader(cipher).version).toBe(1);
  });

  it('rejects a foreign private key', async () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const plain = join(dir, 'foreign.txt');
    const enc = join(dir, 'foreign.txt.enc');
    writeFileSync(plain, 'payload');

    await encryptFileHybrid({ inPath: plain, outPath: enc, publicKeyPem: pair.publicKey });

    await expect(
      decryptFileHybrid({ inPath: enc, outPath: join(dir, 'foreign.out'), privateKeyPem: other.privateKey }),
    ).rejects.toThrow();
  });

  it('rejects a tampered ciphertext', async () => {
    const plain = join(dir, 'tamper.txt');
    const enc = join(dir, 'tamper.txt.enc');
    writeFileSync(plain, 'a'.repeat(4096));

    await encryptFileHybrid({ inPath: plain, outPath: enc, publicKeyPem: pair.publicKey });

    const cipher = readFileSync(enc);
    const at = cipher.length - 32;
    cipher.writeUInt8(cipher.readUInt8(at) ^ 0xff, at);
    writeFileSync(enc, cipher);

    await expect(
      decryptFileHybrid({ inPath: enc, outPath: join(dir, 'tamper.out'), privateKeyPem: pair.privateKey }),
    ).rejects.toThrow();
  });

  it('accepts a key supplied as base64 of PEM', () => {
    const b64 = Buffer.from(pair.publicKey, 'utf8').toString('base64');
    expect(normalizeKeyMaterial(b64)).toContain('-----BEGIN PUBLIC KEY-----');
  });

  it('refuses a file that is not a backup envelope', () => {
    expect(() => parseBackupHeader(Buffer.from('PGDMP not an envelope at all'))).toThrow(/сигнатура/);
  });
});
