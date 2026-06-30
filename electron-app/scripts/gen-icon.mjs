/**
 * Generate the Windows/Linux app icon from the in-app РМЗ logo.
 *
 * Zero external deps — uses only Node builtins (zlib inflate/deflate/crc32).
 * Source `src/renderer/src/assets/logo_rmz.png` (194x250 RGBA) is padded onto a
 * square canvas filled with its own grey background (no resampling of the source →
 * crisp), then emitted as:
 *   build/icon.png  — 256x256 (electron-builder Linux/source icon)
 *   build/icon.ico  — multi-size ICO (256/64/48/32/16) packing PNG payloads
 *
 * Run after the logo changes:  pnpm -F @matricarmz/electron-app gen-icon
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src', 'renderer', 'src', 'assets', 'logo_rmz.png');
const OUT_DIR = join(ROOT, 'build');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Decode an 8-bit RGBA, non-interlaced PNG (color type 6) into {width,height,rgba}.
function decodePng(buf) {
  if (!buf.slice(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('expected 8-bit RGBA non-interlaced PNG');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const rgba = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[p + x];
      const a = x >= bpp ? rgba[y * stride + x - bpp] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? rgba[(y - 1) * stride + x - bpp] : 0;
      let val;
      if (filter === 0) val = cur;
      else if (filter === 1) val = cur + a;
      else if (filter === 2) val = cur + b;
      else if (filter === 3) val = cur + ((a + b) >> 1);
      else if (filter === 4) val = cur + paeth(a, b, c);
      else throw new Error('bad filter ' + filter);
      rgba[y * stride + x] = val & 0xff;
    }
    p += stride;
  }
  return { width, height, rgba };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

// Encode an 8-bit RGBA image (filter 0 per scanline) into a PNG buffer.
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Alpha-aware (premultiplied) area-average downscale of a square RGBA image.
// Premultiplying avoids dark halos around the emblem where transparent pixels
// (rgb = 0) would otherwise drag the averaged colour toward black.
function resizeSquare(src, srcSize, dstSize) {
  if (dstSize === srcSize) return src;
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const ratio = srcSize / dstSize;
  for (let dy = 0; dy < dstSize; dy += 1) {
    const sy0 = Math.floor(dy * ratio);
    const sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * ratio));
    for (let dx = 0; dx < dstSize; dx += 1) {
      const sx0 = Math.floor(dx * ratio);
      const sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * ratio));
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let aSum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const i = (sy * srcSize + sx) * 4;
          const a = src[i + 3];
          pr += src[i] * a;
          pg += src[i + 1] * a;
          pb += src[i + 2] * a;
          aSum += a;
          n += 1;
        }
      }
      const o = (dy * dstSize + dx) * 4;
      dst[o + 3] = Math.round(aSum / n);
      if (aSum > 0) {
        dst[o] = Math.round(pr / aSum);
        dst[o + 1] = Math.round(pg / aSum);
        dst[o + 2] = Math.round(pb / aSum);
      }
    }
  }
  return dst;
}

// Encode a square RGBA image as a 32-bit BGRA BMP/DIB icon image (BITMAPINFOHEADER
// + bottom-up XOR pixels + a zeroed 1-bpp AND mask). This is the most widely
// compatible form for the small icon sizes; 256 stays PNG to keep the file small.
function encodeBmpDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND combined)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcRow = y * size * 4;
    const dstRow = (size - 1 - y) * size * 4; // bottom-up
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4; // 1bpp, 4-byte aligned
  const mask = Buffer.alloc(maskRowBytes * size); // zeroed → alpha channel drives transparency
  return Buffer.concat([header, xor, mask]);
}

function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const d = dir.subarray(16 * i);
    d[0] = e.size >= 256 ? 0 : e.size; // width (0 == 256)
    d[1] = e.size >= 256 ? 0 : e.size; // height
    d[2] = 0; // palette
    d[3] = 0; // reserved
    d.writeUInt16LE(1, 4); // planes
    d.writeUInt16LE(32, 6); // bpp
    d.writeUInt32LE(e.data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

function main() {
  const logo = decodePng(readFileSync(SRC));
  const S = 256;
  // Transparent square canvas (matches the logo's own transparent background) with
  // the emblem copied in at native size, centred. Straight copy: compositing over a
  // fully-transparent destination is just the source pixel, so the logo's own
  // antialiased edges are preserved untouched.
  const canvas = Buffer.alloc(S * S * 4);
  const xOff = Math.round((S - logo.width) / 2);
  const yOff = Math.round((S - logo.height) / 2);
  for (let y = 0; y < logo.height; y += 1) {
    for (let x = 0; x < logo.width; x += 1) {
      const si = (y * logo.width + x) * 4;
      const di = ((y + yOff) * S + (x + xOff)) * 4;
      if (di < 0 || di + 3 >= canvas.length) continue;
      canvas[di] = logo.rgba[si];
      canvas[di + 1] = logo.rgba[si + 1];
      canvas[di + 2] = logo.rgba[si + 2];
      canvas[di + 3] = logo.rgba[si + 3];
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const png256 = encodePng(S, S, canvas);
  writeFileSync(join(OUT_DIR, 'icon.png'), png256);

  const sizes = [256, 64, 48, 32, 24, 16];
  const entries = sizes.map((size) => {
    const px = size === S ? canvas : resizeSquare(canvas, S, size);
    // 256 stays PNG (compact, required form); smaller sizes use BMP/DIB (max compat).
    const data = size >= 256 ? encodePng(size, size, px) : encodeBmpDib(size, px);
    return { size, data };
  });
  writeFileSync(join(OUT_DIR, 'icon.ico'), buildIco(entries));

  console.log(`icon.png  ${png256.length} bytes (256x256)`);
  console.log(`icon.ico  sizes ${sizes.join('/')} (256=PNG, rest=BMP) -> ${join(OUT_DIR, 'icon.ico')}`);
}

main();
