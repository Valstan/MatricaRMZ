import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { SCAN_IMAGE_QUALITY, buildScanFileName } from '@matricarmz/shared';

import { objectFilesFolder } from './fileService.js';

// Сканирование документов в карточку объекта (промт КАРМАНА #148).
//
// Способ захвата — WIA (Windows Image Acquisition): штатный слой драйверов Windows,
// поэтому сканер виден программе без настроек и без привязки к модели: у МФУ и
// у отдельного сканера один и тот же путь «драйвер → WIA → кадр». Своей работы с
// моделями здесь нет и не планируется: производителей много, а протокол у них
// один и общий — WIA.
//
// Проверено на боевой машине (PC79, 26.11.2026): `WIA.DeviceManager` отдаёт
// устройство Type=1 (в том числе МФУ HP LaserJet MFP), а `ImageFile.Transfer()`
// снимает кадр (формат BMP). Отдельного TWAIN-драйвера в системе может не быть
// — WIA работает и без него, потому что это штатный слой Windows, а не протокол
// конкретного производителя.
//
// Два правила, которые нельзя нарушать:
//   * скан идёт в объект ТЕМ ЖЕ путём, что и файл с диска (папка объекта на диске
//     → запись о файле на сервере → синхронизация);
//   * кадр сохраняется как JPG качества 80 % — правило владельца.
//
// Снятие кадра делает PowerShell (WIA — COM-объект, в Node его нет), конвертацию
// в JPG — тоже он: System.Drawing (GDI+) умеет читать всё, что отдаёт драйвер
// (BMP, PNG, JPEG, TIFF), и кодирует JPEG с заданным качеством. Скрипт уходит
// через -EncodedCommand, поэтому ни кавычки, ни кодировка консоли в нём не важны.
//
// Две фазы, а не одна:
//   1) `captureScan` — кадр снят и лежит во ВРЕМЕННОЙ папке; оператор ещё не
//      назвал файл;
//   2) `placeScan` — оператор назвал файл, и только теперь кадр переезжает в папку
//      объекта под ИМЕНЕМ оператора.
// Если бы кадр сразу лёг в папку объекта, а потом оператор переименовал бы его в
// карточке, в папке остался бы мусорный дубль (файл с прежним именем + файл под
// новым) — оператор увидел бы «одну и ту же бумагу дважды».

/** Почему скан не получился — по коду renderer формулирует причину, а не сырой текст. */
export type ScanErrorCode = 'no-device' | 'cancelled' | 'failed' | 'unsupported';

/** Что вернул шаг захвата. */
export type ScanCaptureResult =
  /** Готовый JPG уже в нужном месте. */
  | { ok: true; kind: 'jpeg'; path: string }
  /** Сырой кадр драйвера — конвертируем сами. */
  | { ok: true; kind: 'raw'; path: string; bytes: Buffer }
  | { ok: false; code: ScanErrorCode; error: string };

export type ScanOutcome =
  | { ok: true; path: string; fileName: string; folder: string }
  | { ok: false; code: ScanErrorCode; error: string };

/** Сколько ждём ответа сканера. Обычная заминка оператора — минута; три — уже поломка. */
const SCAN_TIMEOUT_MS = 180_000;

/** Папка временных сканов: сюда ложится кадр ДО того, как оператор его назовёт. */
function scanTempDir(): string {
  return join(tmpdir(), 'matrica-scan');
}

/**
 * Скрипт захвата кадра (ASCII-only: вывод идёт в stdout, а кодировка консоли
 * может быть любой — поэтому тексты ошибок держим латиницей, а русские формулировки
 * собирает уже Node).
 *
 * Шаги: найти устройство-сканер (Type=1) → снять кадр → сохранить «как есть» →
 * перекодировать в JPG с качеством из MATRICA_SCAN_QUALITY.
 */
const WIA_CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$out = $env:MATRICA_SCAN_OUT
$rawBase = $env:MATRICA_SCAN_RAW_BASE
$quality = [int]$env:MATRICA_SCAN_QUALITY

function Emit($text) { [Console]::Out.WriteLine($text) }

$raw = ''
try {
  $dm = New-Object -ComObject WIA.DeviceManager
  $dev = $null
  foreach ($di in $dm.DeviceInfos) {
    if ($di.Type -eq 1) { $dev = $di.Connect(); break }
  }
  if ($null -eq $dev) { Emit 'SCAN_NO_DEVICE'; exit 2 }
  $item = $dev.Items.Item(1)
  $img = $item.Transfer()
  $ext = $img.FileExtension
  if (-not $ext) { $ext = 'bmp' }
  $raw = $rawBase + '.' + $ext
  $img.SaveFile($raw)
} catch {
  $m = [string]$_.Exception.Message
  $m = $m -replace '[^\\x20-\\x7E]', ' '
  Emit ('SCAN_ERROR|' + $m)
  exit 1
}

try {
  Add-Type -AssemblyName System.Drawing
  $src = [System.Drawing.Image]::FromFile($raw)
  try {
    $codec = $null
    foreach ($c in [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()) {
      if ($c.MimeType -eq 'image/jpeg') { $codec = $c; break }
    }
    if ($null -eq $codec) { throw 'no jpeg codec' }
    $enc = [System.Drawing.Imaging.EncoderParameters]::new(1)
    $enc.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, $quality)
    $src.Save($out, $codec, $enc)
  } finally {
    $src.Dispose()
  }
  Emit 'SCAN_OK'
  exit 0
} catch {
  Emit ('SCAN_RAW|' + $raw)
  exit 0
}
`;

/** Собрать команду PowerShell для `-EncodedCommand`: кодировка UTF-16LE, как ждёт PS. */
function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Магические байты JPEG — проверяем, что на диске действительно JPG, а не пустота. */
export function isJpegBytes(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/**
 * Имя файла на диске: без путей и без символов, которые Windows не пускает.
 *
 * То же правило, что у загрузки файла (`safeFilename` в fileService): оператор
 * мог набрать в поле имени что угодно, а на диск это кладёт уже main.
 */
export function safeScanFileName(name: string): string {
  const base = basename(String(name || '').replaceAll('\\', '/'));
  const cleaned = base.replaceAll(/[^a-zA-Z0-9а-яА-ЯёЁ._ -]+/g, '_').slice(0, 180).trim();
  return cleaned || 'scan.jpg';
}

/**
 * Кадр драйвера → JPG качества 80 % средствами Electron.
 *
 * Запасной путь к GDI+ в PowerShell: если System.Drawing на машине недоступно,
 * растр всё равно можно перекодировать здесь. PNG и JPEG Electron читает сам;
 * BMP — нет, и такой кадр честно уходит ошибкой, а не «пустым» вложением.
 */
async function rawToJpeg(bytes: Buffer): Promise<Buffer | null> {
  const { nativeImage } = await import('electron');
  const img = nativeImage.createFromBuffer(bytes);
  if (!img || img.isEmpty()) return null;
  return img.toJPEG(SCAN_IMAGE_QUALITY);
}

/**
 * Снять кадр со сканера и положить готовый JPG по адресу `outPath`.
 *
 * Шаг захвата отделён от остального оркестрирования: тест подставляет заглушку
 * и проверяет, что файл доезжает до объекта (промт #148, шаг 2 плана).
 */
export async function captureViaWia(args: { outPath: string }): Promise<ScanCaptureResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      code: 'unsupported',
      error: 'Сканирование доступно только на компьютере с Windows: там работает драйвер WIA.',
    };
  }

  const rawBase = join(scanTempDir(), `raw-${Date.now()}-${randomBytes(4).toString('hex')}`);
  try {
    mkdirSync(dirname(rawBase), { recursive: true });
  } catch {
    // Не смогли создать папку для сырого кадра — сканер всё равно попробует.
  }

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodePowerShell(WIA_CAPTURE_SCRIPT)],
    {
      windowsHide: true,
      env: {
        ...process.env,
        MATRICA_SCAN_OUT: args.outPath,
        MATRICA_SCAN_RAW_BASE: rawBase,
        MATRICA_SCAN_QUALITY: String(SCAN_IMAGE_QUALITY),
      },
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const exited = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Процесс уже умер — ничего чинить не надо.
      }
      resolve({ code: null, timedOut: true });
    }, SCAN_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });

  if (exited.timedOut) {
    return {
      ok: false,
      code: 'failed',
      error: 'Сканер не ответил за 3 минуты. Проверьте, что документ вложен и сканер не занят другой задачей.',
    };
  }

  const marker = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('SCAN_'));

  if (marker === 'SCAN_OK') {
    const bytes = await fsp.readFile(args.outPath).catch(() => null);
    if (!bytes || !isJpegBytes(bytes)) {
      return { ok: false, code: 'failed', error: 'Сканер вернул файл, но это не JPG — приёмка снимка не удалась.' };
    }
    return { ok: true, kind: 'jpeg', path: args.outPath };
  }

  if (marker === 'SCAN_NO_DEVICE') {
    return {
      ok: false,
      code: 'no-device',
      error:
        'Сканер не найден: в системе нет устройства-сканера. Подключите сканер (или включите его и МФУ) и повторите — программа сама его увидит.',
    };
  }

  if (marker?.startsWith('SCAN_RAW|')) {
    const rawPath = marker.slice('SCAN_RAW|'.length).trim();
    const bytes = await fsp.readFile(rawPath).catch(() => null);
    if (!bytes || bytes.length === 0) {
      return { ok: false, code: 'failed', error: 'Сканер не отдал снимок.' };
    }
    const jpeg = await rawToJpeg(bytes).catch(() => null);
    if (!jpeg) {
      return {
        ok: false,
        code: 'failed',
        error: 'Снимок получен, но перевести его в JPG не удалось. Сохраните документ сканером в файл и приложите с диска.',
      };
    }
    await fsp.writeFile(args.outPath, jpeg);
    return { ok: true, kind: 'jpeg', path: args.outPath };
  }

  if (marker?.startsWith('SCAN_ERROR|')) {
    const detail = marker.slice('SCAN_ERROR|'.length).trim();
    return {
      ok: false,
      code: 'failed',
      error: `Сканер не смог снять документ${detail ? `: ${detail}` : '.'}`,
    };
  }

  const detail = stderr.trim().slice(0, 400);
  return {
    ok: false,
    code: 'failed',
    error: detail
      ? `Сканер не ответил: ${detail}`
      : 'Сканер не ответил. Проверьте подключение сканера и повторите.',
  };
}

/**
 * Снять документ и положить кадр во ВРЕМЕННУЮ папку.
 *
 * Имя предлагается автоматически (карточка + «скан» + штамп времени), но в
 * папку объекта файл ещё не попадает: сначала оператор его назовёт.
 */
export async function captureScan(args: {
  label: string;
  /** Подмена шага захвата — для тестов (заглушка сканирования). */
  capture?: (a: { outPath: string }) => Promise<ScanCaptureResult>;
}): Promise<ScanOutcome> {
  const capture = args.capture ?? captureViaWia;
  const fileName = buildScanFileName(args.label, new Date());
  const tempDir = scanTempDir();

  try {
    mkdirSync(tempDir, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      code: 'failed',
      error: `Не удалось подготовить временную папку для скана: ${String(e)}`,
    };
  }

  const outPath = join(tempDir, `${randomBytes(6).toString('hex')}-${fileName}`);
  const captured = await capture({ outPath }).catch((e) => ({
    ok: false as const,
    code: 'failed' as const,
    error: String(e),
  }));
  if (!captured.ok) return captured;

  return { ok: true, path: captured.path, fileName, folder: tempDir };
}

/**
 * Положить снятый кадр в папку файлов объекта — под ИМЕНЕМ, которое дал оператор.
 *
 * Файл ложится в папку объекта на диске (`<папка загрузок>/Объекты/<карточка>`) —
 * туда же, куда попадают остальные вложения карточки. Дальше он уходит на сервер
 * обычной загрузкой, поэтому скан ничем не отличается от файла, взятого с диска.
 */
export async function placeScan(args: {
  /** Путь временного файла, который вернул `captureScan`. */
  path: string;
  /** Имя, которое оператор подтвердил в карточке. */
  fileName: string;
  label: string;
  downloadDir: string;
}): Promise<ScanOutcome> {
  const fileName = safeScanFileName(args.fileName);
  const folder = objectFilesFolder(args.downloadDir, args.label);

  try {
    mkdirSync(folder, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      code: 'failed',
      error: `Не удалось подготовить папку файлов объекта: ${String(e)}`,
    };
  }

  const outPath = join(folder, fileName);
  try {
    // Если файл с таким именем уже есть (тот же скан положил дважды) — заменяем:
    // иначе в папке объекта лежали бы два одинаковых документа под одним именем.
    await fsp.rm(outPath, { force: true });
    await fsp.rename(args.path, outPath);
  } catch (e) {
    // Перенос может не сработать (файл на другой файловой системе) — тогда копируем.
    try {
      await fsp.copyFile(args.path, outPath);
      await fsp.rm(args.path, { force: true });
    } catch (e2) {
      return {
        ok: false,
        code: 'failed',
        error: `Не удалось положить скан в папку объекта: ${String(e2 ?? e)}`,
      };
    }
  }

  return { ok: true, path: outPath, fileName, folder };
}

/**
 * Убрать временный скан, который оператор не стал прикладывать.
 *
 * Молчание здесь было бы мусором: отменённый скан лежал бы во временной папке
 * до её очистки системой.
 */
export async function discardScan(args: { path: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await fsp.rm(args.path, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
