import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { normalizeUploadImage } from './imageNormalize.js';
import { DEFAULT_MAX_SIDE, fitWithin, looksLikeJpeg, photoJpegQuality, photoMaxSide, worthReplacing } from './imageNormalizePlan.js';

/**
 * Снимок дефектовки — единственный свидетель трещины, и перекодировка его портит необратимо.
 * Поэтому проверяется не только «стало меньше», но и все случаи, когда трогать НЕЛЬЗЯ.
 */

/** Шумный снимок: ровная заливка ужалась бы в ничто, и тест ничего бы не измерил. */
async function photo(width: number, height: number, quality = 95): Promise<Buffer> {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < px.length; i += 1) px[i] = (i * 2654435761) % 251;
  return sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality }).toBuffer();
}

describe('аппетит к памяти ограничен', () => {
  it('кэш libvips выключен, а поток один', () => {
    // На боксе 1536 МБ и нулевой swap: при пустом запасе OOM-killer выбирает жертву сам,
    // и крупнейший процесс здесь — бэкенд. То есть упал бы прод, а не обработка снимка.
    expect(sharp.cache()).toMatchObject({ memory: expect.objectContaining({ max: 0 }) });
    expect(sharp.concurrency()).toBe(1);
  });
});

describe('план сжатия', () => {
  it('JPEG опознаётся по байтам, а не по имени', async () => {
    expect(looksLikeJpeg(await photo(32, 32))).toBe(true);
    expect(looksLikeJpeg(Buffer.from('%PDF-1.7 и вовсе не картинка'))).toBe(false);
    expect(looksLikeJpeg(Buffer.alloc(0))).toBe(false);
  });

  it('уменьшает только то, что больше печатного потолка, и никогда не растягивает', () => {
    // 5152×3864 — самый частый размер на проде.
    expect(fitWithin(5152, 3864, DEFAULT_MAX_SIDE)).toEqual({ width: 3500, height: 2625 });
    // Вертикальный снимок считается по СВОЕЙ длинной стороне.
    expect(fitWithin(3864, 5152, DEFAULT_MAX_SIDE)).toEqual({ width: 2625, height: 3500 });
    // Уже меньше потолка — не трогаем.
    expect(fitWithin(2944, 2944, DEFAULT_MAX_SIDE)).toBeNull();
    expect(fitWithin(800, 600, DEFAULT_MAX_SIDE)).toBeNull();
  });

  it('не пересжимает ради пары процентов', () => {
    expect(worthReplacing(1000, 500)).toBe(true);
    expect(worthReplacing(1000, 900)).toBe(true);
    expect(worthReplacing(1000, 950)).toBe(false);
    expect(worthReplacing(1000, 1200)).toBe(false);
  });

  it('настройки читаются из окружения, мусор игнорируется', () => {
    expect(photoMaxSide({ MATRICA_PHOTO_MAX_SIDE: '2400' } as NodeJS.ProcessEnv)).toBe(2400);
    expect(photoMaxSide({ MATRICA_PHOTO_MAX_SIDE: '10' } as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_SIDE);
    expect(photoMaxSide({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_SIDE);
    expect(photoJpegQuality({ MATRICA_PHOTO_JPEG_QUALITY: '90' } as NodeJS.ProcessEnv)).toBe(90);
    expect(photoJpegQuality({ MATRICA_PHOTO_JPEG_QUALITY: '5' } as NodeJS.ProcessEnv)).toBe(85);
  });
});

describe('normalizeUploadImage', () => {
  it('снимок с телефона ужимается и остаётся в пределах A4 при 300 dpi', async () => {
    const src = await photo(5152, 3864);
    const out = await normalizeUploadImage(src, { name: 'картер.jpg' });
    expect(out.changed).toBe(true);
    expect(out.to).toBeLessThan(out.from);
    const meta = await sharp(out.bytes).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(DEFAULT_MAX_SIDE);
    // Пропорции не поехали: искажённый снимок дефектовки хуже тяжёлого.
    expect((meta.width ?? 0) / (meta.height ?? 1)).toBeCloseTo(5152 / 3864, 2);
  });

  it('маленький снимок не растягивается', async () => {
    const src = await photo(900, 700);
    const out = await normalizeUploadImage(src);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(900);
    expect(meta.height).toBe(700);
  });

  it('уже сжатый снимок остаётся как есть — второго поколения потерь не будет', async () => {
    const src = await photo(1200, 900, 60);
    const out = await normalizeUploadImage(src);
    expect(out.changed).toBe(false);
    expect(out.bytes).toBe(src);
  });

  it('не картинку не трогает вовсе', async () => {
    const pdf = Buffer.from('%PDF-1.7\nсканы актов сюда не относятся');
    const out = await normalizeUploadImage(pdf, { name: 'акт.pdf' });
    expect(out.changed).toBe(false);
    expect(out.bytes).toBe(pdf);
  });

  it('битый JPEG не роняет загрузку — сохраняется как прислали', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 7)]);
    const out = await normalizeUploadImage(broken, { name: 'битый.jpg' });
    expect(out.changed).toBe(false);
    expect(out.bytes).toBe(broken);
  });

  it('потолок и качество слушаются окружения', async () => {
    const src = await photo(4000, 3000);
    const out = await normalizeUploadImage(src, { env: { MATRICA_PHOTO_MAX_SIDE: '1200' } as NodeJS.ProcessEnv });
    const meta = await sharp(out.bytes).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1200);
  });
});
