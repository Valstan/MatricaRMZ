/**
 * Решения о сжатии снимка — чистой логикой, отдельно от самой обработки.
 *
 * Фотографии двигателя (трещины, недочёты, комплектность перед сборкой) печатаются на цветном
 * принтере форматом **не больше A4**, и именно печать задаёт потолок качества: больше того,
 * что физически попадёт на бумагу, хранить незачем.
 *
 * Откуда 3500 точек. Длинная сторона A4 — 297 мм, то есть 11.69 дюйма; при 300 dpi (типографский
 * стандарт, выше которого глаз на бумаге разницы не видит) это 3508 точек. Замер прода 14.09:
 * снимки приходят медианно 19.9 Мп (5152×3864), до 24 Мп — то есть вчетверо больше, чем можно
 * напечатать. Уменьшение до 3500 по длинной стороне печать не ухудшает вовсе, а вес срезает в разы.
 *
 * Качество 85 — общепринятая граница, за которой JPEG-артефакты становятся заметны на плавных
 * переходах. Ниже неё уходить нельзя: тонкая трещина на литье — это как раз малоконтрастная
 * деталь, которую пережатие съедает первой.
 */

/** Длинная сторона A4 при 300 dpi. Больше на бумагу всё равно не попадёт. */
export const DEFAULT_MAX_SIDE = 3500;
/** Порог заметности артефактов JPEG; ниже — рискуем деталями дефектовки. */
export const DEFAULT_JPEG_QUALITY = 85;
/**
 * Пересжимать ради пары процентов не стоит: каждая перекодировка JPEG теряет немного деталей,
 * и обмен «−3 % веса за −1 поколение качества» невыгоден.
 */
export const MIN_GAIN_RATIO = 0.9;

export function photoMaxSide(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MATRICA_PHOTO_MAX_SIDE);
  return Number.isFinite(raw) && raw >= 800 ? Math.trunc(raw) : DEFAULT_MAX_SIDE;
}

export function photoJpegQuality(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MATRICA_PHOTO_JPEG_QUALITY);
  return Number.isFinite(raw) && raw >= 50 && raw <= 100 ? Math.trunc(raw) : DEFAULT_JPEG_QUALITY;
}

/**
 * JPEG опознаём ПО БАЙТАМ, а не по имени и не по заявленному mime: и то и другое приходит от
 * клиента, а сжимать надо ровно то, что действительно является снимком. Чужой файл с расширением
 * `.jpg` не должен попасть в перекодировщик.
 */
export function looksLikeJpeg(bytes: Buffer): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Во сколько уменьшать. `null` — снимок уже не больше потолка, менять размер не нужно
 * (перекодировать при этом всё равно может быть полезно: телефоны пишут с запасом качества).
 * Увеличивать не умеем никогда: из четырёх мегапикселей восьми не получится.
 */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const longest = Math.max(width, height);
  if (longest <= maxSide) return null;
  const k = maxSide / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/**
 * Брать ли результат перекодировки. Оригинал остаётся, если выигрыш мал: это и защита от
 * бессмысленной потери поколения, и от случая, когда снимок уже сжат сильнее нашего.
 */
export function worthReplacing(originalBytes: number, encodedBytes: number): boolean {
  if (encodedBytes <= 0) return false;
  return encodedBytes <= originalBytes * MIN_GAIN_RATIO;
}
