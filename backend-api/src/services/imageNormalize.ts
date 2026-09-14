import sharp from 'sharp';

import { logInfo, logWarn } from '../utils/logger.js';
import { fitWithin, looksLikeJpeg, photoJpegQuality, photoMaxSide, worthReplacing } from './imageNormalizePlan.js';

/**
 * Приведение загружаемого снимка к разумному для печати весу.
 *
 * Зачем. Снимки двигателей приходят с телефонов по 19–24 Мп и 4–6 МБ, а печатаются форматом не
 * больше A4 — то есть хранится вчетверо больше точек, чем вообще попадёт на бумагу. Один такой
 * день (14.09: 350 файлов, 1.5 ГБ) съедал полтора гигабайта на боксе в 10 ГБ.
 *
 * Где это делается и почему здесь. На сервере, в точке приёма `/files/upload`, а не на клиентах:
 *  * файл нормализуется ОДИН раз и одинаково — и в кэш бокса, и на Я.Диск уезжают ровно те же
 *    байты, как и просил владелец; расходиться им негде;
 *  * не нужно ждать обновления парка: старые клиенты получают то же поведение сегодня;
 *  * снимки сюда доходят все — прямой загрузкой мимо сервера идут только файлы больше 10 МБ
 *    (`MAX_LOCAL_BYTES` клиента), а это уже не фотографии, а видео и сканы.
 *
 * Порядок важен: нормализация идёт ДО подсчёта sha256, иначе дедуп и проверка копии на Я.Диске
 * считались бы по байтам, которых нигде нет.
 *
 * Отказ обработки никогда не роняет загрузку: не разобрали снимок — сохраняем как прислали.
 * Потерять фотографию дефектовки из-за кодека нельзя, а лишний вес — переживаемо.
 */

// Бокс — 1536 МБ ОЗУ и НУЛЕВОЙ swap (OpenVZ, свой swap ядро не даёт). По умолчанию libvips
// держит кэш расшифрованных изображений и берёт по потоку на ядро: на снимке в 24 Мп это
// сотни мегабайт сверху. Замер 14.09 во время пакетного прохода — свободными оставалось
// 224 МБ, и при таком запасе OOM-killer выбирает жертву сам, а крупнейший процесс здесь —
// бэкенд, то есть упал бы прод, а не обработка снимка. Поэтому кэш выключен, поток один.
sharp.cache(false);
sharp.concurrency(1);

export type NormalizedImage = {
  bytes: Buffer;
  /** Заменили ли исходные байты. */
  changed: boolean;
  /** Для лога и отчётов одноразового прохода. */
  from: number;
  to: number;
  width?: number;
  height?: number;
  reason?: string;
};

export async function normalizeUploadImage(
  bytes: Buffer,
  opts: { name?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<NormalizedImage> {
  const keep = (reason: string): NormalizedImage => ({ bytes, changed: false, from: bytes.length, to: bytes.length, reason });
  if (!looksLikeJpeg(bytes)) return keep('не JPEG');

  const env = opts.env ?? process.env;
  const maxSide = photoMaxSide(env);
  const quality = photoJpegQuality(env);

  try {
    const image = sharp(bytes, { failOn: 'error' });
    const meta = await image.metadata();
    const width = Number(meta.width ?? 0);
    const height = Number(meta.height ?? 0);
    if (!width || !height) return keep('не прочитались размеры');

    // Поворот из EXIF применяем ЯВНО: метаданные на выходе не сохраняются, и снимок,
    // снятый вертикально, иначе лёг бы на бок.
    const pipeline = sharp(bytes, { failOn: 'error' }).rotate();
    const target = fitWithin(width, height, maxSide);
    if (target) pipeline.resize(target.width, target.height, { fit: 'inside', withoutEnlargement: true });

    const encoded = await pipeline.jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' }).toBuffer();
    if (!worthReplacing(bytes.length, encoded.length)) return keep('выигрыш не стоит перекодировки');

    logInfo('photo normalized', {
      name: opts.name ?? '',
      fromKb: Math.round(bytes.length / 1024),
      toKb: Math.round(encoded.length / 1024),
      from: `${width}x${height}`,
      to: target ? `${target.width}x${target.height}` : `${width}x${height}`,
      quality,
    });
    return {
      bytes: encoded,
      changed: true,
      from: bytes.length,
      to: encoded.length,
      width: target?.width ?? width,
      height: target?.height ?? height,
    };
  } catch (e) {
    // Снимок мог прийти битым или в экзотическом подвиде JPEG — это не повод терять загрузку.
    logWarn('photo normalize failed, keeping original', { name: opts.name ?? '', error: String(e) });
    return keep('ошибка обработки');
  }
}
