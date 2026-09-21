/**
 * Детерминированный id строки списка деталей: RFC 4122 v5 (SHA-1) от (лист, ключ строки).
 *
 * Одна функция на сервер и клиент (E2.3): клиент с 21.09 пишет строки таблицы сам, а сервер
 * по-прежнему выводит их из `meta_json` листа, когда в батче строк нет. Если бы id считались
 * по-разному, один и тот же лист породил бы два набора строк. SHA-1 здесь чистый, без
 * `node:crypto`: shared собирается и в renderer. Вектор совпадения с `crypto.createHash('sha1')`
 * держит тест.
 */

const UUID_NS_ENGINE_INVENTORY_LINE = '7e0a5e2c-3b7f-4d38-9a5b-2c1f0b6d8e41';

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i += 1;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** SHA-1 (FIPS 180-4) над байтами; возвращает 20 байт. */
export function sha1Bytes(message: number[]): number[] {
  const ml = message.length;
  const withPad = message.slice();
  withPad.push(0x80);
  while (withPad.length % 64 !== 56) withPad.push(0);
  const bitLen = ml * 8;
  // 64-битная длина big-endian; старшие 32 бита для наших размеров всегда 0, но пишем честно.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  withPad.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  withPad.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = off + i * 4;
      w[i] = ((withPad[j]! << 24) | (withPad[j + 1]! << 16) | (withPad[j + 2]! << 8) | withPad[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 80; i += 1) w[i] = rotl((w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!) >>> 0, 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out: number[] = [];
  for (const h of [h0, h1, h2, h3, h4]) out.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
  return out;
}

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** Повторный вывод и повторный бэкфилл не плодят строк; погашенная и вернувшаяся строка — та же. */
export function engineInventoryLineId(operationId: string, lineKey: string): string {
  const ns = hexBytes(UUID_NS_ENGINE_INVENTORY_LINE.replace(/-/g, ''));
  const h = sha1Bytes([...ns, ...utf8Bytes(`${operationId}\u0000${lineKey}`)]);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
