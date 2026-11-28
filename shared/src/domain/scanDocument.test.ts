import { describe, expect, it } from 'vitest';

import {
  SCAN_DEFAULT_SETTINGS,
  SCAN_FILE_EXTENSION,
  SCAN_IMAGE_FORMAT,
  SCAN_IMAGE_QUALITY,
  SCAN_MODE_CHOICES,
  SCAN_MODE_LABELS,
  SCAN_PROGRESS_STAGES,
  SCAN_RESOLUTION_CHOICES,
  SCAN_SIZE_CHOICES,
  applyScanModeToBgra,
  buildScanFileName,
  buildScanFileStem,
  buildScanProgress,
  describeScanSettings,
  formatScanStamp,
  resolveScanResolution,
  sanitizeScanLabel,
  scanMillimetersToPixels,
  scanModeNotice,
  scanResolutionNotice,
  scanTargetPixels,
} from './scanDocument.js';

// Правила скана (промт КАРМАНА #148): формат JPG, качество 80 %, имя предлагается
// автоматически по одному правилу и правится оператором.
//
// Настройки съёмки (промт КАРМАНА #178): режим, разрешение, размер листа — и
// честная подпись под ними («что получится на самом деле»).

describe('формат скана', () => {
  it('JPG и качество 80 % — зафиксированные правилом значения', () => {
    expect(SCAN_IMAGE_FORMAT).toBe('jpg');
    expect(SCAN_IMAGE_QUALITY).toBe(80);
    expect(SCAN_FILE_EXTENSION).toBe('.jpg');
  });
});

describe('имя скана', () => {
  it('одно правило: карточка + «скан» + штамп времени', () => {
    const at = new Date(2026, 10, 26, 14, 32, 7);
    expect(buildScanFileStem('Двигатель 41/26', at)).toBe('Двигатель 41-26 - скан 26.11.2026 14-32-07');
    expect(buildScanFileName('Двигатель 41/26', at)).toBe('Двигатель 41-26 - скан 26.11.2026 14-32-07.jpg');
  });

  it('в имени нет символов, которые Windows в имя файла не пускает', () => {
    const at = new Date(2026, 10, 26, 9, 5, 3);
    const name = buildScanFileName('Накладная: склад/№ 12 ? *', at);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.endsWith('.jpg')).toBe(true);
  });

  it('две карточки в одну секунду не дают одинаковых имён', () => {
    const at = new Date(2026, 10, 26, 14, 32, 7);
    expect(buildScanFileName('Двигатель 41/26', at)).not.toBe(buildScanFileName('Двигатель 41/27', at));
  });

  it('без названия карточки имя всё равно осмысленное', () => {
    const at = new Date(2026, 10, 26, 14, 32, 7);
    expect(buildScanFileName('', at)).toBe('Скан 26.11.2026 14-32-07.jpg');
    expect(buildScanFileName('   ', at)).toBe('Скан 26.11.2026 14-32-07.jpg');
  });

  it('название карточки обрезается — иначе имя не влезает на диск', () => {
    const long = 'Д'.repeat(200);
    expect(sanitizeScanLabel(long).length).toBeLessThanOrEqual(60);
    const at = new Date(2026, 10, 26, 14, 32, 7);
    expect(buildScanFileName(long, at).length).toBeLessThanOrEqual(100);
  });

  it('штамп времени без двоеточий — их Windows не пускает в имя', () => {
    expect(formatScanStamp(new Date(2026, 0, 5, 8, 9, 4))).toBe('05.01.2026 08-09-04');
  });
});

describe('настройки съёмки (промт КАРМАНА #178)', () => {
  it('оператору предлагаются все три режима и все три размера', () => {
    // Критерий приёмки: «в окне настроек есть выбор режима: цветное, чёрно-белое,
    // серое» и «выбор размера: A4, A3 и максимум».
    expect([...SCAN_MODE_CHOICES]).toEqual(['color', 'grayscale', 'blackwhite']);
    expect([...SCAN_SIZE_CHOICES]).toEqual(['a4', 'a3', 'max']);
    expect([...SCAN_RESOLUTION_CHOICES]).toEqual([150, 300, 'max']);
  });

  it('по умолчанию — цвет, максимум сканера и весь размер листа', () => {
    // Ничего не теряем: кадр не обрезан листом A4 и разрешение не снижено.
    expect(SCAN_DEFAULT_SETTINGS).toEqual({ resolution: 'max', mode: 'color', size: 'max' });
  });

  it('названия режимов — словами оператора, а не буквами драйвера', () => {
    expect(SCAN_MODE_LABELS.color).toBe('Цветное');
    expect(SCAN_MODE_LABELS.grayscale).toBe('Серое');
    expect(SCAN_MODE_LABELS.blackwhite).toBe('Чёрно-белое');
  });
});

describe('разрешение: сканер может не уметь запрошенное', () => {
  it('берётся наибольшее поддерживаемое, что не выше запроса', () => {
    // Замер на боевой машине (28.11.2026): WIA-устройство HP LaserJet MFP
    // M437-M443 умеет {75, 100, 150, 200} dpi — 300 через WIA не берётся.
    expect(resolveScanResolution(300, [75, 100, 150, 200])).toBe(200);
    expect(resolveScanResolution(150, [75, 100, 150, 200])).toBe(150);
    expect(resolveScanResolution(600, [75, 100, 150, 200])).toBe(200);
  });

  it('если поддерживаемых меньше запроса нет — берётся наименьшее из доступных', () => {
    expect(resolveScanResolution(150, [300, 600])).toBe(300);
  });

  it('когда список пуст, разрешение остаётся запрошенным', () => {
    expect(resolveScanResolution(300, [])).toBe(300);
  });

  it('подпись говорит словами, что сканер не умеет запрошенное', () => {
    expect(scanResolutionNotice(300, 300)).toBe('');
    expect(scanResolutionNotice(300, 200)).toContain('200 dpi');
    expect(scanResolutionNotice(300, 200)).toContain('не умеет 300 dpi');
  });

  it('режим, которого сканер не умеет, тоже говорится словами', () => {
    expect(scanModeNotice('color', 'color')).toBe('');
    expect(scanModeNotice('color', 'grayscale')).toContain('Серое');
  });
});

describe('размер листа в пикселях', () => {
  it('миллиметры переводятся в пиксели при заданном разрешении', () => {
    expect(scanMillimetersToPixels(210, 300)).toBe(2480);
    expect(scanMillimetersToPixels(297, 300)).toBe(3507);
    expect(scanMillimetersToPixels(297, 200)).toBe(2338);
  });

  it('A4 и A3 считаются по листу, а «во всю величину» — по стеклу сканера', () => {
    const bedMm = { width: 297, height: 420 };
    expect(scanTargetPixels({ size: 'a4', dpi: 200, bedMm })).toEqual({ width: 1653, height: 2338 });
    expect(scanTargetPixels({ size: 'a3', dpi: 200, bedMm })).toEqual({ width: 2338, height: 3307 });
    expect(scanTargetPixels({ size: 'max', dpi: 200, bedMm })).toEqual({ width: 2338, height: 3307 });
  });

  it('размер кадра никогда не нулевой — иначе драйверу нечего снимать', () => {
    expect(scanMillimetersToPixels(210, 0)).toBe(0);
    expect(scanTargetPixels({ size: 'a4', dpi: 200, bedMm: { width: 297, height: 420 } }).width).toBeGreaterThan(0);
  });
});

describe('режим кадра: серый отличается от чёрно-белого', () => {
  /** Пиксель цвета: R=200, G=100, B=50. */
  const colorPixel = [50, 100, 200, 255];

  function render(mode: 'color' | 'grayscale' | 'blackwhite'): number[] {
    const buf = new Uint8Array(colorPixel);
    const out = applyScanModeToBgra(buf, 1, 1, mode);
    return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0, out[3] ?? 0];
  }

  it('цветное сохраняет каналы как есть', () => {
    expect(render('color')).toEqual(colorPixel);
  });

  it('серое делает каналы одинаковыми, но тон сохраняет', () => {
    const gray = render('grayscale');
    expect(gray[0]).toBe(gray[1]);
    expect(gray[1]).toBe(gray[2]);
    // Полутон: не белый и не чёрный — оттенок остался.
    expect(gray[0]).toBeGreaterThan(0);
    expect(gray[0]).toBeLessThan(255);
  });

  it('чёрно-белое оставляет два тона: белый или чёрный', () => {
    const bw = render('blackwhite');
    expect([0, 255]).toContain(bw[0]);
    expect(bw[0]).toBe(bw[1]);
    expect(bw[1]).toBe(bw[2]);
  });

  it('серый и чёрно-белое дают РАЗНЫЕ картинки — их можно перепутать', () => {
    expect(render('grayscale')).not.toEqual(render('blackwhite'));
  });
});

describe('подпись под настройками', () => {
  it('в одной строке: режим, разрешение, размер и кадр в пикселях', () => {
    const text = describeScanSettings({
      mode: 'color',
      resolution: 300,
      size: 'a4',
      framePixels: { width: 2480, height: 3507 },
    });
    expect(text).toContain('Цветное');
    expect(text).toContain('300 dpi');
    expect(text).toContain('A4');
    expect(text).toContain('2480×3507');
  });
});

describe('полоса прогресса съёма', () => {
  it('три этапа: ищем сканер → снимаем → сохраняем', () => {
    expect([...SCAN_PROGRESS_STAGES]).toEqual(['searching', 'capturing', 'saving']);
  });

  it('полоса идёт по этапам и доходит до конца', () => {
    const first = buildScanProgress('searching');
    const second = buildScanProgress('capturing');
    const last = buildScanProgress('saving');
    expect(first.done).toBe(0);
    expect(second.done).toBe(1);
    expect(last.done).toBe(2);
    expect(last.total).toBe(3);
    // Этапы названы словами оператора.
    expect(first.label).toContain('Ищем сканер');
    expect(second.label).toContain('Снимаем');
    expect(last.label).toContain('Сохраняем');
  });
});
