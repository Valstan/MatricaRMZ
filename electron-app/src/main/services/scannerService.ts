import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  SCAN_DEFAULT_SETTINGS,
  SCAN_IMAGE_QUALITY,
  applyScanModeToBgra,
  buildScanFileName,
  buildScanProgress,
  resolveScanResolution,
  scanTargetPixels,
  type ScanActual,
  type ScanCapabilities,
  type ScanMode,
  type ScanProgressEvent,
  type ScanSettings,
  type ScanSize,
} from '@matricarmz/shared';

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
// Промт КАРМАНА #178 (27.11.2026): кадр надо снимать В ЦВЕТЕ и не ниже 300 dpi,
// а перед съёмкой оператор выбирает режим, разрешение и размер в отдельном окне.
//
// ПОЧЕМУ РАНЬШЕ БЫЛО ЧЁРНО-БЕЛОЕ И НИЗКОЕ. Скрипт снимал кадр обычным
// `Transfer()` без параметров: драйвер отдавал то, что считал умолчанием. Значит,
// чинить надо не «включить цвет», а ЗАДАВАТЬ Параметры съёмки (тип данных,
// разрешение, размер области) до снятия кадра. Замер на боевой машине (28.11.2026,
// WIA-устройство HP LaserJet MFP M437-M443): разрешение умеет {75, 100, 150, 200} dpi,
// тип данных — {2 (серое), 3 (цветное)}, Photometric Interpretation — только 0.
//
// Два правила, которые нельзя нарушать:
//   * скан идёт в объект ТЕМ ЖЕ путём, что и файл с диска (папка объекта на диске
//     → запись о файле на сервере → синхронизация);
//   * кадр сохраняется как JPG качества 80 % — правило владельца.
//
// Снятие кадра делает PowerShell (WIA — COM-объект, в Node его нет). Кадр драйвера
// PowerShell переводит в PNG (без потерь), а уже Node переводит PNG в JPG 80 % и
// применяет запрошенный РЕЖИМ (цветное / серое / чёрно-белое). Так режим живёт в
// одном месте — в домене (`applyScanModeToBgra`), и его можно проверить тестом, а не
// «на глаз у МФУ».
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
  | { ok: true; kind: 'jpeg'; path: string; actual?: ScanActual }
  /** Сырой кадр драйвера — конвертируем сами. */
  | { ok: true; kind: 'raw'; path: string; bytes: Buffer; actual?: ScanActual }
  | { ok: false; code: ScanErrorCode; error: string };

export type ScanOutcome =
  | { ok: true; path: string; fileName: string; folder: string; actual?: ScanActual }
  | { ok: false; code: ScanErrorCode; error: string };

/** Сколько ждём ответа сканера. Обычная заминка оператора — минута; три — уже поломка. */
const SCAN_TIMEOUT_MS = 180_000;

/**
 * Кандидаты разрешения — чем больше, тем лучше.
 *
 * Перебором находится МАКСИМУМ сканера: у МФУ РМЗ (WIA-устройство HP LaserJet MFP
 * M437-M443) список {75, 100, 150, 200}, и 300 dpi через WIA не берётся — об этом
 * честно говорит подпись под настройками, а не молчаливый сюрприз на готовом файле.
 *
 * Список один на оба скрипта (разведка и съём) — он уходит им в переменную окружения.
 */
const SCAN_RESOLUTION_CANDIDATES = [1200, 600, 400, 300, 240, 200, 150, 100, 75];

/**
 * Типы данных WIA по режимам — цепочкой, от «настоящего» к запасному.
 *
 * Числа — значения свойства «Data Type» элемента WIA. У разных драйверов набор
 * разный: у боевой машины это {2 (серое), 3 (цветное)}, у других встречается
 * 100/101/102 (WIA_DATA_BITMAP/GRAYSCALE/COLOR). Перебираем по порядку и берём
 * первое, что драйвер принял; если не принял ничего — снимаем в сером и честно
 * говорим об этом в подписи.
 */
const SCAN_DATA_TYPE_CHAIN: Record<ScanMode, readonly number[]> = {
  color: [3, 102, 2],
  grayscale: [2, 101, 3],
  blackwhite: [1, 100, 2, 3],
};

/** Какому режиму соответствует значение типа данных драйвера. */
const SCAN_DATA_TYPE_MODES: Record<number, ScanMode> = {
  1: 'blackwhite',
  2: 'grayscale',
  3: 'color',
  100: 'blackwhite',
  101: 'grayscale',
  102: 'color',
};

/** Папка временных сканов: сюда ложится кадр ДО того, как оператор его назовёт. */
function scanTempDir(): string {
  return join(tmpdir(), 'matrica-scan');
}

/**
 * Что умеет сканер.
 *
 * Форма объявлена в домене (`ScanCapabilities`): она — часть контракта между
 * главным процессом и окном скана, и оба слоя должны понимать её одинаково.
 */
export type { ScanCapabilities };

/** Настройки съёмки, разрешённые до конкретных чисел (то, что уходит в драйвер). */
export interface ResolvedScanSettings {
  /** Разрешение, которое берём, dpi. */
  resolution: number;
  /** Режим, который получится на деле. */
  mode: ScanMode;
  /** Размер листа. */
  size: ScanSize;
  /** Размер кадра в пикселях. */
  width: number;
  height: number;
  /** Тип данных драйвера для этого режима. */
  dataType: number;
  /** Разрешения по убыванию: первое — желаемое, дальше — запасные. */
  resChain: number[];
  /** Типы данных по убыванию «качества»: первое — настоящий режим. */
  dtChain: number[];
}

/** Общие куски PowerShell-скриптов: поиск свойства и мягкая установка значения. */
const PS_HELPERS = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Emit($text) { [Console]::Out.WriteLine($text) }
function B64($text) { return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$text)) }
function FindProp($coll, $id) {
  foreach ($p in $coll) { if ([int]$p.PropertyID -eq $id) { return $p } }
  return $null
}
function TrySet($prop, $value) {
  if ($null -eq $prop) { return $false }
  try { $prop.Value = $value; return $true } catch { return $false }
}
function Chain($raw) {
  $out = @()
  foreach ($part in ([string]$raw -split ',')) {
    $n = 0
    if ([int]::TryParse($part.Trim(), [ref]$n)) { $out += $n }
  }
  return $out
}
`;

/**
 * Скрипт разведки: что умеет сканер.
 *
 * Отдаёт: какие разрешения принимает драйвер, какие типы данных, и размер стекла.
 * Размер стекла берём из области съёмки ПЕРЕД перебором разрешений: перебор меняет
 * разрешение, а с ним и область, и стекло «поехало» бы.
 */
const WIA_CAPS_SCRIPT = `
$ErrorActionPreference = 'Stop'
${PS_HELPERS}
try {
  $dm = New-Object -ComObject WIA.DeviceManager
  $dev = $null
  foreach ($di in $dm.DeviceInfos) {
    if ($di.Type -eq 1) { $dev = $di.Connect(); break }
  }
  if ($null -eq $dev) { Emit 'SCAN_NO_DEVICE'; exit 2 }
  $item = $dev.Items.Item(1)
  $xres = FindProp $item.Properties 6147
  $yres = FindProp $item.Properties 6148
  $xe = FindProp $item.Properties 6151
  $ye = FindProp $item.Properties 6152
  $dt = FindProp $item.Properties 4103

  $bedW = 0.0
  $bedH = 0.0
  if ($null -ne $xres -and $null -ne $xe) {
    $d0 = [double]$xres.Value
    if ($d0 -gt 0) {
      $bedW = [math]::Round(([double]$xe.Value / $d0) * 25.4, 1)
      $bedH = [math]::Round(([double]$ye.Value / $d0) * 25.4, 1)
    }
  }

  $res = @()
  foreach ($t in (Chain $env:MATRICA_SCAN_RES_CANDIDATES)) {
    if (TrySet $xres $t) { if (TrySet $yres $t) { $res += $t } }
  }
  $dts = @()
  foreach ($t in @(1,2,3,100,101,102)) { if (TrySet $dt $t) { $dts += $t } }

  $caps = @{ resolutions = $res; dataTypes = $dts; bedWidthMm = $bedW; bedHeightMm = $bedH } | ConvertTo-Json -Compress
  Emit ('SCAN_CAPS|' + (B64 $caps))
  exit 0
} catch {
  Emit ('SCAN_ERROR|' + (B64 ([string]$_.Exception.Message)))
  exit 1
}
`;

/**
 * Скрипт съёма.
 *
 * Шаги: найти устройство-сканер (Type=1) → задать разрешение, размер области и тип
 * данных → снять кадр → сохранить его как PNG (без потерь). JPG из PNG делает уже
 * Node — там же применяется режим (цветное / серое / чёрно-белое).
 *
 * Каждый шаг объявляет себя маркером `SCAN_STAGE|…` — по ним идёт честная полоса
 * прогресса в окне (ищем сканер → снимаем → сохраняем). Процентов выдумывать нечем:
 * WIA отдаёт кадр целиком.
 */
const WIA_CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
${PS_HELPERS}
$out = $env:MATRICA_SCAN_OUT
$rawBase = $env:MATRICA_SCAN_RAW_BASE
$resChain = Chain $env:MATRICA_SCAN_RES_CHAIN
$dtChain = Chain $env:MATRICA_SCAN_DT_CHAIN
$targetW = [int]$env:MATRICA_SCAN_WIDTH
$targetH = [int]$env:MATRICA_SCAN_HEIGHT
try {
  Emit 'SCAN_STAGE|searching'
  $dm = New-Object -ComObject WIA.DeviceManager
  $dev = $null
  foreach ($di in $dm.DeviceInfos) {
    if ($di.Type -eq 1) { $dev = $di.Connect(); break }
  }
  if ($null -eq $dev) { Emit 'SCAN_NO_DEVICE'; exit 2 }
  $item = $dev.Items.Item(1)
  $xres = FindProp $item.Properties 6147
  $yres = FindProp $item.Properties 6148
  $xe = FindProp $item.Properties 6151
  $ye = FindProp $item.Properties 6152
  $dt = FindProp $item.Properties 4103

  $dpi = 0
  foreach ($t in $resChain) {
    if (TrySet $xres $t) { if (TrySet $yres $t) { $dpi = [int]$xres.Value; break } }
  }
  if ($dpi -le 0) { Emit ('SCAN_ERROR|' + (B64 'Драйвер не принял ни одного разрешения.')); exit 1 }

  if ($targetW -gt 0) { TrySet $xe $targetW | Out-Null }
  if ($targetH -gt 0) { TrySet $ye $targetH | Out-Null }

  $dataType = 0
  foreach ($t in $dtChain) { if (TrySet $dt $t) { $dataType = $t; break } }
  if ($dataType -eq 0) { Emit ('SCAN_ERROR|' + (B64 'Драйвер не принял ни одного режима съёмки.')); exit 1 }

  Emit 'SCAN_STAGE|capturing'
  $img = $null
  $lastErr = ''
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try { $img = $item.Transfer(); break } catch { $lastErr = [string]$_.Exception.Message; Start-Sleep -Milliseconds 900 }
  }
  if ($null -eq $img) { Emit ('SCAN_ERROR|' + (B64 $lastErr)); exit 1 }

  Emit 'SCAN_STAGE|saving'
  $ext = $img.FileExtension
  if (-not $ext) { $ext = 'bmp' }
  $raw = $rawBase + '.' + $ext
  $img.SaveFile($raw)
  try {
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile($raw)
    try {
      $src.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      $info = @{ dpi = $dpi; dataType = $dataType; width = $src.Width; height = $src.Height } | ConvertTo-Json -Compress
    } finally {
      $src.Dispose()
    }
    Emit ('SCAN_INFO|' + (B64 $info))
    Emit 'SCAN_OK'
    exit 0
  } catch {
    Emit ('SCAN_RAW|' + (B64 $raw))
    exit 0
  }
} catch {
  Emit ('SCAN_ERROR|' + (B64 ([string]$_.Exception.Message)))
  exit 1
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

/** Расшифровать сообщение драйвера: PowerShell отдал его в base64, чтобы не поехала кодировка. */
function decodeDriverMessage(b64: string): string {
  try {
    return Buffer.from(b64, 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
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
 * Разрешить настройки оператора в конкретные числа.
 *
 * Сканер умеет не всё, что может выбрать оператор: 300 dpi он может не брать, а
 * цветного режима у него может не быть вовсе. Здесь решается, ЧТО на самом деле
 * получится, — и это потом показывается оператору под настройками.
 */
export function resolveScanSettings(args: {
  settings: ScanSettings;
  capabilities: ScanCapabilities | null;
}): ResolvedScanSettings {
  const settings = args.settings ?? SCAN_DEFAULT_SETTINGS;
  const caps = args.capabilities;
  const supported = caps?.supportedResolutions ?? [];

  // Разрешение: «максимум сканера» — это максимум; конкретное число берём ближайшее
  // поддерживаемое, что не выше запрошенного.
  let resolution: number;
  if (settings.resolution === 'max') {
    resolution = caps?.maxResolution ?? 300;
  } else {
    resolution = supported.length > 0 ? resolveScanResolution(settings.resolution, supported) : settings.resolution;
  }
  if (!Number.isFinite(resolution) || resolution <= 0) resolution = 300;

  // Цепочка для скрипта: сначала выбранное разрешение, потом ниже — если драйвер
  // вдруг его не примет, съёмка всё равно состоится, просто с меньшим dpi.
  // Последним идёт общий список кандидатов: драйвер между разведкой и съёмкой
  // мог ответить иначе, и тогда не остаться бы ни одного принятого значения.
  const resChain = [
    resolution,
    ...supported.filter((r) => r < resolution).sort((a, b) => b - a),
    ...SCAN_RESOLUTION_CANDIDATES.filter((c) => c < resolution && !supported.includes(c)).sort((a, b) => b - a),
  ];

  // Режим: ищем по цепочке тот тип данных, который драйвер умеет.
  // Серое и чёрно-белое получить можно всегда (серое драйвер отдаёт или мы
  // убираем цвет сами, чёрно-белое — порог по яркости). А вот цвет без цветного
  // типа данных драйвера не выдумать: снимаем серым и честно говорим об этом.
  const chain = SCAN_DATA_TYPE_CHAIN[settings.mode] ?? SCAN_DATA_TYPE_CHAIN.color;
  const supportedTypes = caps?.supportedModes;
  let mode: ScanMode = settings.mode;
  let dataType = chain[0] ?? 3;
  if (supportedTypes && supportedTypes.length > 0) {
    const wanted = chain.filter((t) => supportedTypes.includes(SCAN_DATA_TYPE_MODES[t] ?? 'color'));
    dataType = wanted[0] ?? 2;
    if (settings.mode === 'color' && SCAN_DATA_TYPE_MODES[dataType] !== 'color') mode = 'grayscale';
  }

  // Размер кадра: по листу или по всему стеклу сканера.
  const bedMm = caps?.bedMm ?? { width: 210, height: 297 };
  const target = scanTargetPixels({ size: settings.size, dpi: resolution, bedMm });

  return {
    resolution,
    mode,
    size: settings.size,
    width: target.width,
    height: target.height,
    dataType,
    resChain,
    // Цепочка типов данных начинается с ТОГО, что получился: скрипт пробует сначала
    // его, а дальше — запасные (настоящий чёрно-белое, если драйвер его умеет).
    dtChain: [dataType, ...chain.filter((t) => t !== dataType)],
  };
}

/**
 * PNG драйвера → JPG качества 80 % в запрошенном режиме.
 *
 * Режим применяется здесь, а не в PowerShell: правило «серое отличается от
 * чёрно-белого» живёт в домене и проверяется тестом, а не глазами у МФУ.
 */
async function pngToJpegWithMode(
  pngPath: string,
  outPath: string,
  mode: ScanMode,
): Promise<{ width: number; height: number } | null> {
  const { nativeImage } = await import('electron');
  const bytes = await fsp.readFile(pngPath);
  const img = nativeImage.createFromBuffer(bytes);
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  if (!size.width || !size.height) return null;

  const bgra = img.toBitmap();
  const pixels = new Uint8Array(bgra.buffer, bgra.byteOffset, bgra.byteLength);
  const painted = applyScanModeToBgra(pixels, size.width, size.height, mode);
  const converted = nativeImage.createFromBuffer(Buffer.from(painted), { width: size.width, height: size.height });
  if (!converted || converted.isEmpty()) return null;

  await fsp.writeFile(outPath, converted.toJPEG(SCAN_IMAGE_QUALITY));
  return { width: size.width, height: size.height };
}

/**
 * Кадр драйвера → JPG качества 80 % средствами Electron.
 *
 * Запасной путь к GDI+ в PowerShell: если System.Drawing на машине недоступно,
 * растр всё равно можно перекодировать здесь. PNG и JPEG Electron читает сам;
 * BMP — нет, и такой кадр честно уходит ошибкой, а не «пустым» вложением.
 */
async function rawToJpeg(bytes: Buffer, mode: ScanMode): Promise<Buffer | null> {
  const { nativeImage } = await import('electron');
  const img = nativeImage.createFromBuffer(bytes);
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  if (!size.width || !size.height) return null;
  const bgra = img.toBitmap();
  const pixels = new Uint8Array(bgra.buffer, bgra.byteOffset, bgra.byteLength);
  const painted = applyScanModeToBgra(pixels, size.width, size.height, mode);
  const converted = nativeImage.createFromBuffer(Buffer.from(painted), { width: size.width, height: size.height });
  if (!converted || converted.isEmpty()) return null;
  return converted.toJPEG(SCAN_IMAGE_QUALITY);
}

/** Что разобрали из маркеров PowerShell. */
interface WiaMarkers {
  caps?: ScanCapabilities;
  info?: { dpi: number; dataType: number; width: number; height: number };
  /** Сырой кадр драйвера: GDI+ на машине не сработал, разбираем сами. */
  rawPath?: string;
  error?: string;
  noDevice?: boolean;
}

/** Разобрать накопленный stdout скрипта: маркеры WIA. */
function parseMarkers(stdout: string): WiaMarkers {
  const out: WiaMarkers = {};
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === 'SCAN_NO_DEVICE') {
      out.noDevice = true;
    } else if (trimmed.startsWith('SCAN_ERROR|')) {
      out.error = decodeDriverMessage(trimmed.slice('SCAN_ERROR|'.length));
    } else if (trimmed.startsWith('SCAN_RAW|')) {
      out.rawPath = decodeDriverMessage(trimmed.slice('SCAN_RAW|'.length));
    } else if (trimmed.startsWith('SCAN_INFO|')) {
      try {
        const json = decodeDriverMessage(trimmed.slice('SCAN_INFO|'.length));
        const parsed = JSON.parse(json) as { dpi?: number; dataType?: number; width?: number; height?: number };
        out.info = {
          dpi: Number(parsed.dpi) || 0,
          dataType: Number(parsed.dataType) || 0,
          width: Number(parsed.width) || 0,
          height: Number(parsed.height) || 0,
        };
      } catch {
        // Маркер битый — разбирать нечего, capture вернёт честный отказ.
      }
    } else if (trimmed.startsWith('SCAN_CAPS|')) {
      try {
        const json = decodeDriverMessage(trimmed.slice('SCAN_CAPS|'.length));
        const parsed = JSON.parse(json) as {
          resolutions?: number[];
          dataTypes?: number[];
          bedWidthMm?: number;
          bedHeightMm?: number;
        };
        const resolutions = (parsed.resolutions ?? []).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
        const dataTypes = (parsed.dataTypes ?? []).filter((v) => Number.isFinite(v));
        out.caps = {
          maxResolution: resolutions[resolutions.length - 1] ?? 0,
          supportedResolutions: resolutions,
          supportedModes: dataTypes.map((t) => SCAN_DATA_TYPE_MODES[t]).filter((m): m is ScanMode => Boolean(m)),
          bedMm: { width: Number(parsed.bedWidthMm) || 0, height: Number(parsed.bedHeightMm) || 0 },
        };
      } catch {
        // Маркер битый — разбирать нечего, разведка вернёт честный отказ.
      }
    }
  }
  return out;
}

/** Запустить PowerShell-скрипт и отдать накопленный stdout. */
async function runPowerShell(args: {
  script: string;
  env: Record<string, string>;
  onStage?: (stage: string) => void;
}): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodePowerShell(args.script)],
    { windowsHide: true, env: { ...process.env, ...args.env } },
  );

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    const text = String(chunk);
    stdout += text;
    // Полоса прогресса: этапы объявляются по мере того, как скрипт до них дошёл.
    if (args.onStage) {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('SCAN_STAGE|')) args.onStage(trimmed.slice('SCAN_STAGE|'.length));
      }
    }
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

  return { stdout, stderr, timedOut: exited.timedOut };
}

/**
 * Спросить у сканера, что он умеет.
 *
 * Зовётся при открытии окна скана: окно показывает оператору настоящие числа
 * («максимум сканера: 200 dpi»), а не обещания.
 */
export async function probeScanCapabilities(): Promise<
  { ok: true; capabilities: ScanCapabilities } | { ok: false; code: ScanErrorCode; error: string }
> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      code: 'unsupported',
      error: 'Сканирование доступно только на компьютере с Windows: там работает драйвер WIA.',
    };
  }

  const { stdout, stderr, timedOut } = await runPowerShell({
    script: WIA_CAPS_SCRIPT,
    env: { MATRICA_SCAN_RES_CANDIDATES: SCAN_RESOLUTION_CANDIDATES.join(',') },
  });
  if (timedOut) {
    return { ok: false, code: 'failed', error: 'Сканер не ответил за 3 минуты.' };
  }

  const markers = parseMarkers(stdout);
  if (markers.noDevice) {
    return {
      ok: false,
      code: 'no-device',
      error:
        'Сканер не найден: в системе нет устройства-сканера. Подключите сканер (или включите его и МФУ) и повторите — программа сама его увидит.',
    };
  }
  if (!markers.caps) {
    const detail = markers.error || stderr.trim().slice(0, 400);
    return {
      ok: false,
      code: 'failed',
      error: detail ? `Сканер не ответил: ${detail}` : 'Сканер не ответил. Проверьте подключение сканера и повторите.',
    };
  }
  return { ok: true, capabilities: markers.caps };
}

/**
 * Снять кадр со сканера и положить готовый JPG по адресу `outPath`.
 *
 * Шаг захвата отделён от остального оркестрирования: тест подставляет заглушку
 * и проверяет, что файл доезжает до объекта.
 */
export async function captureViaWia(args: {
  outPath: string;
  settings: ResolvedScanSettings;
  onProgress?: (event: ScanProgressEvent) => void;
}): Promise<ScanCaptureResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      code: 'unsupported',
      error: 'Сканирование доступно только на компьютере с Windows: там работает драйвер WIA.',
    };
  }

  const rawBase = join(scanTempDir(), `raw-${Date.now()}-${randomBytes(4).toString('hex')}`);
  const pngPath = `${rawBase}.png`;
  try {
    mkdirSync(dirname(rawBase), { recursive: true });
  } catch {
    // Не смогли создать папку для сырого кадра — сканер всё равно попробует.
  }

  const { stdout, stderr, timedOut } = await runPowerShell({
    script: WIA_CAPTURE_SCRIPT,
    env: {
      MATRICA_SCAN_OUT: pngPath,
      MATRICA_SCAN_RAW_BASE: rawBase,
      MATRICA_SCAN_RES_CANDIDATES: SCAN_RESOLUTION_CANDIDATES.join(','),
      MATRICA_SCAN_RES_CHAIN: args.settings.resChain.join(','),
      MATRICA_SCAN_DT_CHAIN: args.settings.dtChain.join(','),
      MATRICA_SCAN_WIDTH: String(args.settings.width),
      MATRICA_SCAN_HEIGHT: String(args.settings.height),
    },
    onStage: (stage) => {
      if (stage === 'searching' || stage === 'capturing' || stage === 'saving') {
        args.onProgress?.(buildScanProgress(stage));
      }
    },
  });

  if (timedOut) {
    return {
      ok: false,
      code: 'failed',
      error: 'Сканер не ответил за 3 минуты. Проверьте, что документ вложен и сканер не занят другой задачей.',
    };
  }

  const markers = parseMarkers(stdout);
  if (markers.noDevice) {
    return {
      ok: false,
      code: 'no-device',
      error:
        'Сканер не найден: в системе нет устройства-сканера. Подключите сканер (или включите его и МФУ) и повторите — программа сама его увидит.',
    };
  }

  if (markers.error) {
    const detail = markers.error;
    return {
      ok: false,
      code: 'failed',
      error: `Сканер не смог снять документ${detail ? `: ${detail}` : '.'}`,
    };
  }

  if (!markers.rawPath && !markers.info) {
    // Скрипт не отдал ни кадра, ни причины — говорим, что он ответил.
    const detail = stderr.trim().replace(/<Objs[\s\S]*$/, '').trim().slice(0, 300);
    return {
      ok: false,
      code: 'failed',
      error: detail
        ? `Сканер не ответил: ${detail}`
        : 'Сканер не ответил. Проверьте подключение сканера и повторите.',
    };
  }

  let frame: { width: number; height: number } | null = null;
  if (markers.rawPath) {
    // GDI+ на машине не сработал: разбираем кадр сами. BMP Electron не читает —
    // такой кадр честно уходит ошибкой, а не «пустым» вложением.
    const bytes = await fsp.readFile(markers.rawPath).catch(() => null);
    if (!bytes || bytes.length === 0) {
      return { ok: false, code: 'failed', error: 'Сканер не отдал снимок.' };
    }
    const jpeg = await rawToJpeg(bytes, args.settings.mode).catch(() => null);
    if (!jpeg) {
      return {
        ok: false,
        code: 'failed',
        error:
          'Снимок получен, но перевести его в JPG не удалось. Сохраните документ сканером в файл и приложите с диска.',
      };
    }
    await fsp.writeFile(args.outPath, jpeg);
    const { nativeImage } = await import('electron');
    const size = nativeImage.createFromBuffer(jpeg).getSize();
    frame = { width: size.width, height: size.height };
  } else {
    frame = await pngToJpegWithMode(pngPath, args.outPath, args.settings.mode).catch(() => null);
  }
  if (!frame) {
    return { ok: false, code: 'failed', error: 'Снимок получен, но перевести его в JPG не удалось.' };
  }

  const bytes = await fsp.readFile(args.outPath).catch(() => null);
  if (!bytes || !isJpegBytes(bytes)) {
    return { ok: false, code: 'failed', error: 'Сканер вернул файл, но это не JPG — приёмка снимка не удалась.' };
  }

  // Режим по факту: драйвер мог отдать серое вместо цветного — тогда и подпись
  // под настройками обязана говорить «серое», а не обещать цвет.
  const actualDataType = markers.info?.dataType ?? 0;
  const actualMode: ScanMode =
    args.settings.mode === 'color' && actualDataType > 0 && SCAN_DATA_TYPE_MODES[actualDataType] !== 'color'
      ? 'grayscale'
      : args.settings.mode;

  const actual: ScanActual = {
    resolution: markers.info?.dpi || args.settings.resolution,
    mode: actualMode,
    width: frame.width,
    height: frame.height,
    size: args.settings.size,
  };
  return { ok: true, kind: 'jpeg', path: args.outPath, actual };
}

/**
 * Снять документ и положить кадр во ВРЕМЕННУЮ папку.
 *
 * Имя предлагается автоматически (карточка + «скан» + штамп времени), но в
 * папку объекта файл ещё не попадает: сначала оператор его назовёт.
 */
export async function captureScan(args: {
  label: string;
  /** Настройки оператора (промт КАРМАНА #178). */
  settings?: ScanSettings;
  /** Что умеет сканер — нужно, чтобы выбрать разрешение и режим по правде. */
  capabilities?: ScanCapabilities | null;
  /** Полоса прогресса: «ищем сканер → снимаем → сохраняем». */
  onProgress?: (event: ScanProgressEvent) => void;
  /** Подмена шага захвата — для тестов (заглушка сканирования). */
  capture?: (a: {
    outPath: string;
    settings: ResolvedScanSettings;
    onProgress?: (event: ScanProgressEvent) => void;
  }) => Promise<ScanCaptureResult>;
}): Promise<ScanOutcome> {
  const capture = args.capture ?? captureViaWia;
  const settings = args.settings ?? SCAN_DEFAULT_SETTINGS;
  const resolved = resolveScanSettings({ settings, capabilities: args.capabilities ?? null });

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
  const captured = await capture({
    outPath,
    settings: resolved,
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
  }).catch((e) => ({
    ok: false as const,
    code: 'failed' as const,
    error: String(e),
  }));
  if (!captured.ok) return captured;

  return {
    ok: true,
    path: captured.path,
    fileName,
    folder: tempDir,
    ...(captured.actual ? { actual: captured.actual } : {}),
  };
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
