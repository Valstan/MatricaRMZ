import { createCipheriv, createDecipheriv, createPublicKey, createPrivateKey, constants, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

// Envelope for off-site backup artifacts: the server holds ONLY the public key, so a
// stolen Yandex.Disk token (or the disk account itself) yields ciphertext and nothing
// else. Decryption needs the private key, which never lives on the server.
//
// Layout:
//   0..7    magic "MRMZBK" + version byte + reserved byte
//   8..9    uint16 BE — length of the RSA-wrapped key blob
//   10..    RSA-OAEP(SHA-256) of (32-byte AES key || 12-byte IV)
//   then    AES-256-GCM ciphertext
//   last 16 GCM auth tag
const MAGIC = Buffer.from('MRMZBK', 'ascii');
const VERSION = 1;
const HEADER_FIXED_LEN = MAGIC.length + 2 + 2; // magic + version + reserved + uint16 length
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export type BackupCryptoHeader = { version: number; wrappedKeyLength: number; headerLength: number };

function buildHeader(wrappedKey: Buffer): Buffer {
  const head = Buffer.alloc(HEADER_FIXED_LEN);
  MAGIC.copy(head, 0);
  head.writeUInt8(VERSION, MAGIC.length);
  head.writeUInt8(0, MAGIC.length + 1);
  head.writeUInt16BE(wrappedKey.length, MAGIC.length + 2);
  return head;
}

export function parseBackupHeader(buf: Buffer): BackupCryptoHeader {
  if (buf.length < HEADER_FIXED_LEN) throw new Error('Файл слишком короткий — это не зашифрованный бэкап MatricaRMZ');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Неверная сигнатура файла — это не зашифрованный бэкап MatricaRMZ');
  const version = buf.readUInt8(MAGIC.length);
  if (version !== VERSION) throw new Error(`Неподдерживаемая версия конверта: ${version}`);
  const wrappedKeyLength = buf.readUInt16BE(MAGIC.length + 2);
  if (wrappedKeyLength <= 0) throw new Error('Повреждён заголовок: пустой ключевой блок');
  return { version, wrappedKeyLength, headerLength: HEADER_FIXED_LEN + wrappedKeyLength };
}

/**
 * A PEM public key straight from env is awkward (newlines), so base64-of-PEM is accepted too.
 */
export function normalizeKeyMaterial(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('Ключевой материал пуст');
  if (value.includes('-----BEGIN')) return value.replaceAll('\\n', '\n');
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!decoded.includes('-----BEGIN')) throw new Error('Ключевой материал не похож ни на PEM, ни на base64 от PEM');
  return decoded;
}

export async function encryptFileHybrid(args: { inPath: string; outPath: string; publicKeyPem: string }): Promise<void> {
  const publicKey = createPublicKey(normalizeKeyMaterial(args.publicKeyPem));
  const key = randomBytes(KEY_LEN);
  const iv = randomBytes(IV_LEN);
  const wrappedKey = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.concat([key, iv]),
  );

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(args.outPath);
  out.write(buildHeader(wrappedKey));
  out.write(wrappedKey);

  // The GCM tag is only available once the cipher has flushed, so the stream stays open
  // until the pipeline settles and the tag is appended as the final 16 bytes.
  await pipeline(createReadStream(args.inPath), cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => {
    out.end(cipher.getAuthTag(), (e?: Error | null) => (e ? reject(e) : resolve()));
  });
}

export async function decryptFileHybrid(args: {
  inPath: string;
  outPath: string;
  privateKeyPem: string;
  passphrase?: string;
}): Promise<void> {
  const privateKey = createPrivateKey({
    key: normalizeKeyMaterial(args.privateKeyPem),
    ...(args.passphrase ? { passphrase: args.passphrase } : {}),
  });

  // Backup artifacts are tens of megabytes; reading whole is simpler than a streaming
  // split and stays well inside the memory the nightly job already uses for the dump.
  const buf = await readFile(args.inPath);
  const header = parseBackupHeader(buf);
  const wrappedKey = buf.subarray(HEADER_FIXED_LEN, header.headerLength);
  const body = buf.subarray(header.headerLength);
  if (body.length < TAG_LEN) throw new Error('Повреждён файл: нет метки целостности');

  const unwrapped = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrappedKey);
  if (unwrapped.length !== KEY_LEN + IV_LEN) throw new Error('Повреждён ключевой блок конверта');

  const decipher = createDecipheriv('aes-256-gcm', unwrapped.subarray(0, KEY_LEN), unwrapped.subarray(KEY_LEN));
  decipher.setAuthTag(body.subarray(body.length - TAG_LEN));

  const out = createWriteStream(args.outPath);
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    // A wrong key or a tampered file surfaces here, on final() — that is the check that
    // makes "we restored from this backup" a fact rather than a hope.
    try {
      out.write(decipher.update(body.subarray(0, body.length - TAG_LEN)));
      out.end(decipher.final(), () => resolve());
    } catch (e) {
      out.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
