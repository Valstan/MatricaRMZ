import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

// Envelope for the nightly SQLite snapshot — the artifact the client downloads to browse a
// backup by date. Unlike the pg_dump, this one the SERVER must be able to read back, so the
// key is symmetric and lives in prod env. That still removes the plaintext from Yandex.Disk:
// a stolen YANDEX_DISK_TOKEN alone now buys ciphertext. It does not defend against the server
// itself being compromised, and is not meant to.
//
// Framed rather than one big GCM blob on purpose. The file is ~150 MB and is served through a
// decrypting proxy: a single tag would only verify after the last byte, so the proxy would
// have to either buffer 150 MB on a small VPS or stream unverified bytes and hand the client a
// silently corrupt database. Per-frame tags let the proxy verify as it goes.
//
// Layout:
//   magic "MRMZSNAP" (8) | version (1) | reserved (1) | frameSize uint32 BE (4)
//   then frames: cipherLen uint32 BE (4) | flags uint8 (1) | iv (12) | ciphertext | tag (16)
//
// Each frame is authenticated with AAD = frameIndex (8 BE) || flags (1). The index binds a
// frame to its position, so frames cannot be reordered or replayed; the final-frame flag makes
// truncation detectable — a stream that ends without a final frame is an error, not a short
// file. Both live in the AAD, so flipping either breaks the tag.

const MAGIC = Buffer.from('MRMZSNAP', 'ascii');
const VERSION = 1;
const HEADER_LEN = MAGIC.length + 2 + 4;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
export const DEFAULT_FRAME_SIZE = 4 * 1024 * 1024;

export function parseSnapshotKey(raw: string): Buffer {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('Ключ шифрования снимка пуст');
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_LEN) {
    throw new Error(`Ключ шифрования снимка должен быть 32 байта в base64 (получено ${key.length})`);
  }
  return key;
}

export function generateSnapshotKey(): string {
  return randomBytes(KEY_LEN).toString('base64');
}

/**
 * Ключ снимка из окружения. Как и у дампа — без открытого фолбэка: не настроен ключ,
 * значит снимок наружу не уходит вовсе.
 */
export function readSnapshotKeyFromEnv(): Buffer {
  const raw = (process.env.BACKUP_SNAPSHOT_KEY ?? '').trim();
  if (!raw) {
    throw new Error(
      'Не задан BACKUP_SNAPSHOT_KEY — ключ шифрования ночного снимка. ' +
        'Незашифрованный снимок базы за пределы контура не отправляется.',
    );
  }
  return parseSnapshotKey(raw);
}

const FLAG_FINAL = 1;

function frameAad(index: number, flags: number): Buffer {
  const aad = Buffer.alloc(9);
  aad.writeBigUInt64BE(BigInt(index), 0);
  aad.writeUInt8(flags, 8);
  return aad;
}

export function createSnapshotEncryptStream(key: Buffer, frameSize = DEFAULT_FRAME_SIZE): Transform {
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let index = 0;
  let headerWritten = false;

  function sealFrame(plain: Buffer, isFinal: boolean): Buffer {
    const flags = isFinal ? FLAG_FINAL : 0;
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
    cipher.setAAD(frameAad(index, flags));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const head = Buffer.alloc(5);
    head.writeUInt32BE(body.length, 0);
    head.writeUInt8(flags, 4);
    index += 1;
    return Buffer.concat([head, iv, body, cipher.getAuthTag()]);
  }

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        if (!headerWritten) {
          const header = Buffer.alloc(HEADER_LEN);
          MAGIC.copy(header, 0);
          header.writeUInt8(VERSION, MAGIC.length);
          header.writeUInt8(0, MAGIC.length + 1);
          header.writeUInt32BE(frameSize, MAGIC.length + 2);
          this.push(header);
          headerWritten = true;
        }
        pending.push(chunk);
        pendingLen += chunk.length;
        while (pendingLen >= frameSize) {
          const all = Buffer.concat(pending, pendingLen);
          this.push(sealFrame(all.subarray(0, frameSize), false));
          const rest = all.subarray(frameSize);
          pending = rest.length ? [rest] : [];
          pendingLen = rest.length;
        }
        cb();
      } catch (e) {
        cb(e instanceof Error ? e : new Error(String(e)));
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!headerWritten) {
          const header = Buffer.alloc(HEADER_LEN);
          MAGIC.copy(header, 0);
          header.writeUInt8(VERSION, MAGIC.length);
          header.writeUInt8(0, MAGIC.length + 1);
          header.writeUInt32BE(frameSize, MAGIC.length + 2);
          this.push(header);
          headerWritten = true;
        }
        // Даже пустой файл получает финальный кадр: иначе «пусто» и «оборвалось» неразличимы.
        this.push(sealFrame(Buffer.concat(pending, pendingLen), true));
        cb();
      } catch (e) {
        cb(e instanceof Error ? e : new Error(String(e)));
      }
    },
  });
}

export function createSnapshotDecryptStream(key: Buffer): Transform {
  let buf = Buffer.alloc(0);
  let headerRead = false;
  let index = 0;
  let sawFinal = false;

  function openFrame(flags: number, iv: Buffer, body: Buffer, tag: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
    decipher.setAAD(frameAad(index, flags));
    decipher.setAuthTag(tag);
    let out: Buffer;
    try {
      out = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new Error(`Снимок повреждён или ключ не тот: кадр ${index} не проходит проверку целостности`);
    }
    if ((flags & FLAG_FINAL) !== 0) sawFinal = true;
    index += 1;
    return out;
  }

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        buf = Buffer.concat([buf, chunk]);
        if (!headerRead) {
          if (buf.length < HEADER_LEN) return cb();
          if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Это не зашифрованный снимок MatricaRMZ');
          const version = buf.readUInt8(MAGIC.length);
          if (version !== VERSION) throw new Error(`Неподдерживаемая версия снимка: ${version}`);
          buf = buf.subarray(HEADER_LEN);
          headerRead = true;
        }
        for (;;) {
          if (buf.length < 5) break;
          const cipherLen = buf.readUInt32BE(0);
          const flags = buf.readUInt8(4);
          const total = 5 + IV_LEN + cipherLen + TAG_LEN;
          if (buf.length < total) break;
          if (sawFinal) throw new Error('Снимок повреждён: данные после финального кадра');
          const iv = buf.subarray(5, 5 + IV_LEN);
          const body = buf.subarray(5 + IV_LEN, 5 + IV_LEN + cipherLen);
          const tag = buf.subarray(5 + IV_LEN + cipherLen, total);
          this.push(openFrame(flags, iv, body, tag));
          buf = buf.subarray(total);
        }
        cb();
      } catch (e) {
        cb(e instanceof Error ? e : new Error(String(e)));
      }
    },
    flush(cb: TransformCallback) {
      if (!headerRead) return cb(new Error('Снимок пуст или обрезан до заголовка'));
      if (buf.length > 0) return cb(new Error('Снимок обрезан: последний кадр неполон'));
      if (!sawFinal) return cb(new Error('Снимок обрезан: финальный кадр отсутствует'));
      cb();
    },
  });
}

/** Сравнение подписей ссылки — постоянного времени, чтобы токен нельзя было подобрать побайтно. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
