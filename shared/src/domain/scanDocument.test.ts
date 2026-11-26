import { describe, expect, it } from 'vitest';

import {
  SCAN_FILE_EXTENSION,
  SCAN_IMAGE_FORMAT,
  SCAN_IMAGE_QUALITY,
  buildScanFileName,
  buildScanFileStem,
  formatScanStamp,
  sanitizeScanLabel,
} from './scanDocument.js';

// Правила скана (промт КАРМАНА #148): формат JPG, качество 80 %, имя предлагается
// автоматически по одному правилу и правится оператором.

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
