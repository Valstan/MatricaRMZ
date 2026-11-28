// Сканирование документов в карточку объекта (промт КАРМАНА #148).
//
// Здесь — ПРАВИЛА скана, общие для слоёв: main знает, как снять кадр и во что его
// превратить, renderer знает, как назвать файл и что показать оператору. Правило
// имени живёт здесь, потому что имя сканера должно совпадать с тем, что оператор
// увидит в поле правки, — иначе «автоимя» и «предложенное имя» разъезжаются.
//
// Три правила зафиксированы владельцем (зачитка 25.11.2026):
//   * формат скана — JPG;
//   * качество JPG — 80 %;
//   * имя предлагается автоматически, но правится оператором.
//
// Промт КАРМАНА #178 (зачитка владельца 27.11.2026) добавил ПЕРЕД съёмкой настройки:
// цвет, разрешение, размер листа. Правила настроек — тоже здесь: окно с настройками
// (renderer) и съёмка (main) должны говорить об одном и том же, иначе подпись под
// настройками разойдётся с тем, что на деле снял сканер.

/** Формат скана по умолчанию: JPG. */
export const SCAN_IMAGE_FORMAT = 'jpg';

/** Качество JPG по умолчанию: 80 %. */
export const SCAN_IMAGE_QUALITY = 80;

/** Расширение файла скана (с точкой). */
export const SCAN_FILE_EXTENSION = `.${SCAN_IMAGE_FORMAT}`;

/**
 * Режим съёмки: цветное, серое или чёрно-белое.
 *
 * Серое и чёрно-белое — разные вещи: серое сохраняет оттенок (полутон), чёрно-белое
 * оставляет два тона. Владелец проверяет именно это («серый отличается от
 * чёрно-белого»), поэтому режимов три, а не два.
 */
export type ScanMode = 'color' | 'grayscale' | 'blackwhite';

/** Размер листа: A4, A3 или «во всю доступную величину». */
export type ScanSize = 'a4' | 'a3' | 'max';

/** Разрешение: конкретное число dpi либо «максимум сканера». */
export type ScanResolutionChoice = 150 | 300 | 'max';

/** Настройки съёмки, которые оператор выбирает в окне скана. */
export interface ScanSettings {
  /** Разрешение кадра. */
  resolution: ScanResolutionChoice;
  /** Режим кадра. */
  mode: ScanMode;
  /** Размер листа. */
  size: ScanSize;
}

/**
 * Настройки по умолчанию.
 *
 * Цвет — по требованию владельца (#178). Разрешение и размер — «максимум сканера»:
 * это единственный выбор, который ничего не теряет (кадр не обрезан листом A4,
 * разрешение не снижено). Владелец может убавить и то и другое одним щелчком.
 */
export const SCAN_DEFAULT_SETTINGS: ScanSettings = {
  resolution: 'max',
  mode: 'color',
  size: 'max',
};

/** Разрешения, которые оператор выбирает в окне (плюс «максимум сканера»). */
export const SCAN_RESOLUTION_CHOICES: readonly ScanResolutionChoice[] = [150, 300, 'max'];

/** Режимы, которые оператор выбирает в окне. */
export const SCAN_MODE_CHOICES: readonly ScanMode[] = ['color', 'grayscale', 'blackwhite'];

/** Размеры листа, которые оператор выбирает в окне. */
export const SCAN_SIZE_CHOICES: readonly ScanSize[] = ['a4', 'a3', 'max'];

/** Названия режимов — словами оператора. */
export const SCAN_MODE_LABELS: Record<ScanMode, string> = {
  color: 'Цветное',
  grayscale: 'Серое',
  blackwhite: 'Чёрно-белое',
};

/** Названия размеров — словами оператора. */
export const SCAN_SIZE_LABELS: Record<ScanSize, string> = {
  a4: 'A4',
  a3: 'A3',
  max: 'Во всю доступную величину',
};

/**
 * Размер листа в миллиметрах (ISO 216).
 *
 * A3 — не «запас на всякий случай»: у МФУ РМЗ стекло именно A3, и режим «во всю
 * доступную величину» должен снимать ровно его, а не гадать по бумаге.
 */
export const SCAN_SHEET_MM: Record<'a4' | 'a3', { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
};

/**
 * Символы, которые Windows не пускает в имя файла.
 *
 * Имя карточки приходит от карточки объекта («Двигатель 41/26»), а слеши в нём
 * есть — значит, имя надо почистить ДО того, как оно станет файлом на диске.
 */
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/g;

/** Сколько символов оставляем от названия карточки. */
const LABEL_MAX_LEN = 60;

/**
 * Почистить название карточки для имени файла: запрещённые символы — в дефис,
 * пробелы — одинарные, хвост обрезаем.
 *
 * Обрезка нужна: имя файла на диске ограничено, а «Двигатель …» может быть
 * длинным, и вместе со штампом времени оно перестало бы влезать.
 */
export function sanitizeScanLabel(raw: string): string {
  return String(raw ?? '')
    .replace(FORBIDDEN_NAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX_LEN)
    .replace(/[.\s]+$/, '')
    .trim();
}

/**
 * Штамп времени в имени скана: `26.11.2026 14-32-07`.
 *
 * Без двоеточий — они не пускаются в имя файла. По локальному времени машины:
 * оператор называет документ тогда, когда принёс его в цех, а не по времени
 * сервера, который может стоять в другом часовом поясе.
 */
export function formatScanStamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = p(at.getDate());
  const month = p(at.getMonth() + 1);
  const year = at.getFullYear();
  const hour = p(at.getHours());
  const minute = p(at.getMinutes());
  const second = p(at.getSeconds());
  return `${day}.${month}.${year} ${hour}-${minute}-${second}`;
}

/**
 * Имя файла скана БЕЗ расширения: «Двигатель 41-26 - скан 26.11.2026 14-32-07».
 *
 * Правило одно и очевидное: название карточки + «скан» + штамп времени.
 * Штамп — потому что два скана одного документа в одну минуту совпасть не могут
 * (в секундах — не могут вовсе), а «лист 1 / лист 2» требовало бы считать уже
 * приложенные сканы и ломаться на дублях.
 */
export function buildScanFileStem(label: string, at: Date): string {
  const clean = sanitizeScanLabel(label);
  const stamp = formatScanStamp(at);
  return clean ? `${clean} - скан ${stamp}` : `Скан ${stamp}`;
}

/** Полное имя файла скана: «Двигатель 41-26 - скан 26.11.2026 14-32-07.jpg». */
export function buildScanFileName(label: string, at: Date): string {
  return `${buildScanFileStem(label, at)}${SCAN_FILE_EXTENSION}`;
}

/**
 * Миллиметры → пиксели при заданном разрешении.
 *
 * Округление вниз: драйвер отвергает размер, который хоть на пиксель больше
 * стекла («The parameter is incorrect»), поэтому лучше недобрать пиксель, чем
 * потерять съёмку.
 */
export function scanMillimetersToPixels(mm: number, dpi: number): number {
  if (!Number.isFinite(mm) || !Number.isFinite(dpi) || dpi <= 0) return 0;
  return Math.max(1, Math.floor((mm / 25.4) * dpi));
}

/**
 * Размер кадра в пикселях: по листу (A4/A3) или по всему стеклу сканера.
 *
 * `bedMm` — размер стекла в миллиметрах; его знает только main (он спрашивает
 * у драйвера), поэтому параметр обязателен для режима «во всю величину».
 */
export function scanTargetPixels(args: {
  size: ScanSize;
  dpi: number;
  bedMm: { width: number; height: number };
}): { width: number; height: number } {
  const sheet = args.size === 'max' ? args.bedMm : SCAN_SHEET_MM[args.size];
  return {
    width: scanMillimetersToPixels(sheet.width, args.dpi),
    height: scanMillimetersToPixels(sheet.height, args.dpi),
  };
}

/**
 * Фактическое разрешение: сканер может не уметь запрошенное.
 *
 * Правило: берём наибольшее поддерживаемое, что не больше запроса; если такого
 * нет — наименьшее поддерживаемое (сканер один, а выбора нет). Молча выдавать
 * чужое разрешение нельзя: подпись под настройками обязана говорить правду.
 */
export function resolveScanResolution(requested: number, supported: readonly number[]): number {
  const list = supported.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (list.length === 0) return Math.max(1, Math.round(requested));
  const notGreater = list.filter((v) => v <= requested);
  const best = notGreater[notGreater.length - 1];
  if (best !== undefined) return best;
  const smallest = list[0];
  return smallest ?? Math.max(1, Math.round(requested));
}

/**
 * Что на деле получилось — по этому подписывается окно и по этому же
 * оператор потом видит свойства скана.
 */
export interface ScanActual {
  /** Фактическое разрешение кадра, dpi. */
  resolution: number;
  /** Фактический режим: драйвер мог не уметь запрошенный. */
  mode: ScanMode;
  /** Размер кадра в пикселях. */
  width: number;
  height: number;
  /** Размер листа по факту. */
  size: ScanSize;
}

/**
 * Подпись под настройками: «Цветное · 200 dpi · A4 · 1653×2338».
 *
 * Одна строка — оператор читает её одним взглядом и понимает, что именно
 * получится: режим, разрешение, размер листа и кадр в пикселях.
 */
export function describeScanSettings(args: {
  mode: ScanMode;
  resolution: number;
  size: ScanSize;
  framePixels?: { width: number; height: number };
}): string {
  const parts = [SCAN_MODE_LABELS[args.mode], `${args.resolution} dpi`, SCAN_SIZE_LABELS[args.size]];
  if (args.framePixels) {
    parts.push(`${args.framePixels.width}×${args.framePixels.height} px`);
  }
  return parts.join(' · ');
}

/**
 * Почему фактическое разрешение отличается от запрошенного — словами оператора.
 *
 * Пустая строка означает «разрешение как просили» — тогда подпись ничего лишнего
 * не говорит.
 */
export function scanResolutionNotice(requested: number, actual: number): string {
  if (!Number.isFinite(requested) || requested <= 0 || requested === actual) return '';
  return `Сканер не умеет ${requested} dpi — кадр снят в ${actual} dpi.`;
}

/**
 * Почему фактический режим отличается от запрошенного — словами оператора.
 */
export function scanModeNotice(requested: ScanMode, actual: ScanMode): string {
  if (requested === actual) return '';
  return `Сканер не умеет режим «${SCAN_MODE_LABELS[requested]}» — кадр снят в режиме «${SCAN_MODE_LABELS[actual]}».`;
}

/**
 * Что означает режим для кадра — правило, а не украшение.
 *
 * «Серое» и «чёрно-белое» — это разные картинки: серое хранит полутон, чёрно-белое
 * оставляет два тона. Владелец проверяет именно разницу между ними, поэтому режимы
 * нельзя схлопывать в один.
 *
 * Работаем с буфером BGRA — так его отдаёт Electron (`nativeImage.toBitmap()`).
 * Яркость считаем по формуле Rec.601: так делает GDI+ и так же считает оператор,
 * когда говорит «светлее/темнее».
 */
export function applyScanModeToBgra(
  bgra: Uint8Array,
  width: number,
  height: number,
  mode: ScanMode,
): Uint8Array {
  const pixels = width * height;
  if (!Number.isFinite(pixels) || pixels <= 0) return bgra;
  const needed = pixels * 4;
  if (bgra.length < needed) return bgra;
  if (mode === 'color') return bgra;

  const out = new Uint8Array(needed);
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    const b = bgra[o] ?? 0;
    const g = bgra[o + 1] ?? 0;
    const r = bgra[o + 2] ?? 0;
    const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const value = mode === 'grayscale' ? luma : luma >= 128 ? 255 : 0;
    out[o] = value;
    out[o + 1] = value;
    out[o + 2] = value;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * Что умеет сканер.
 *
 * Спрашивается у драйвера при открытии окна скана, чтобы окно показывало
 * оператору настоящие числа («максимум сканера: 200 dpi»), а не обещание.
 */
export interface ScanCapabilities {
  /** Максимальное разрешение, которое умеет сканер, dpi. */
  maxResolution: number;
  /** Все разрешения, которые умеет сканер (по возрастанию). */
  supportedResolutions: number[];
  /** Режимы, которые сканер умеет отдавать сам. */
  supportedModes: ScanMode[];
  /** Размер стекла сканера, мм. */
  bedMm: { width: number; height: number };
}

/**
 * Этапы съёма — честная полоса прогресса.
 *
 * WIA отдаёт кадр целиком: честного процента готовности не существует, выдумывать
 * его нельзя (оператор потом не отличит «почти готово» от «зависло»). Поэтому полоса
 * идёт по этапам, а подпись называет текущий этап словами.
 */
export type ScanProgressStage = 'searching' | 'capturing' | 'saving';

/** Событие прогресса съёма: что сейчас делает программа. */
export interface ScanProgressEvent {
  /** Текущий этап. */
  stage: ScanProgressStage;
  /** Что делаем — словами оператора. */
  label: string;
  /** Сколько этапов пройдено (0…total). */
  done: number;
  /** Сколько этапов всего. */
  total: number;
}

/** Всего этапов съёма: ищем сканер → снимаем кадр → сохраняем файл. */
export const SCAN_PROGRESS_STAGES: readonly ScanProgressStage[] = ['searching', 'capturing', 'saving'];

/** Названия этапов — словами оператора. */
export const SCAN_PROGRESS_STAGE_LABELS: Record<ScanProgressStage, string> = {
  searching: 'Ищем сканер…',
  capturing: 'Снимаем кадр…',
  saving: 'Сохраняем файл…',
};

/**
 * Собрать событие прогресса по номеру этапа.
 *
 * `done` — сколько этапов УЖЕ закончилось: на этапе «снимаем» это 1, потому что
 * «ищем сканер» уже позади. Полоса доходит до конца ровно на последнем этапе.
 */
export function buildScanProgress(stage: ScanProgressStage): ScanProgressEvent {
  const index = SCAN_PROGRESS_STAGES.indexOf(stage);
  return {
    stage,
    label: SCAN_PROGRESS_STAGE_LABELS[stage],
    done: index < 0 ? 0 : index,
    total: SCAN_PROGRESS_STAGES.length,
  };
}
