import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  captureScan,
  discardScan,
  isJpegBytes,
  placeScan,
  resolveScanSettings,
  safeScanFileName,
  type ScanCapabilities,
} from './scannerService.js';
import { objectFilesFolder, objectFolderName } from './fileService.js';

// Канал скана (промт КАРМАНА #148, шаг 2 плана: «тест на получение файла от
// заглушки сканирования»).
//
// Проверяется не сам WIA (это делает боевая машина), а СОГЛАШЕНИЕ между шагами:
//   * заглушка захвата отдаёт файл — он доезжает до объекта;
//   * имя предлагается по правилу и его можно поменять;
//   * кадр ложится в папку объекта под ИМЕНЕМ оператора (а не под своим временным);
//   * отменённый скан не оставляет мусора.
//
// Настройки съёмки (промт КАРМАНА #178): скан идёт С ПАРАМЕТРАМИ (разрешение, режим,
// размер), и подпись под настройками говорит правду о том, что получилось.

/** Минимальный настоящий JPEG-заголовок — тесту важен факт «это JPG», а не картинка. */
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

/**
 * Что умеет боевой сканер (замер 28.11.2026, WIA-устройство HP LaserJet MFP
 * M437-M443): разрешение {75, 100, 150, 200}, режимы {серое, цветное}, стекло A3.
 */
const CAPS: ScanCapabilities = {
  maxResolution: 200,
  supportedResolutions: [75, 100, 150, 200],
  supportedModes: ['grayscale', 'color'],
  bedMm: { width: 297, height: 420 },
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'matrica-scan-test-'));
}

describe('захват скана', () => {
  it('файл от заглушки доезжает до объекта', async () => {
    const shot = await captureScan({
      label: 'Двигатель 41/26',
      capture: async ({ outPath }) => {
        await fsp.writeFile(outPath, JPEG_HEADER);
        return { ok: true as const, kind: 'jpeg' as const, path: outPath };
      },
    });

    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    // Файл на месте и это JPG.
    const bytes = await fsp.readFile(shot.path);
    expect(isJpegBytes(bytes)).toBe(true);
    // Имя предложено по правилу «карточка + скан + время».
    expect(shot.fileName).toMatch(/^Двигатель 41-26 - скан \d{2}\.\d{2}\.\d{4} \d{2}-\d{2}-\d{2}\.jpg$/);
  });

  it('отказ захвата доходит до вызывающего с причиной', async () => {
    const shot = await captureScan({
      label: 'Карточка',
      capture: async () => ({ ok: false as const, code: 'no-device' as const, error: 'Сканер не найден' }),
    });
    expect(shot.ok).toBe(false);
    if (shot.ok) return;
    expect(shot.code).toBe('no-device');
    expect(shot.error).toContain('Сканер не найден');
  });
});

describe('скан ложится в папку объекта под именем оператора', () => {
  it('имя оператора важнее технического имени скана', async () => {
    const dir = tempRoot();
    const shot = await captureScan({
      label: 'Двигатель 41/26',
      capture: async ({ outPath }) => {
        await fsp.writeFile(outPath, JPEG_HEADER);
        return { ok: true as const, kind: 'jpeg' as const, path: outPath };
      },
    });
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;

    const placed = await placeScan({
      path: shot.path,
      fileName: 'Товарная накладная 123.jpg',
      label: 'Двигатель 41/26',
      downloadDir: dir,
    });

    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.fileName).toBe('Товарная накладная 123.jpg');
    // Лежит в папке объекта — той же, куда кладёт файл с диска. Название папки
    // сохраняется целиком: «Двигатель 41/26» и «Двигатель 12/26» не должны
    // делить одну папку «26».
    expect(placed.folder).toContain(join('Объекты', 'Двигатель 41-26'));
    const bytes = await fsp.readFile(placed.path);
    expect(isJpegBytes(bytes)).toBe(true);
    // Временного файла не осталось — в папке объекта нет мусорного дубля.
    await expect(fsp.access(shot.path)).rejects.toBeTruthy();
  });

  it('тот же файл под тем же именем перезаписывается, а не дублируется', async () => {
    const dir = tempRoot();
    const first = await captureScan({
      label: 'Карточка',
      capture: async ({ outPath }) => {
        await fsp.writeFile(outPath, JPEG_HEADER);
        return { ok: true as const, kind: 'jpeg' as const, path: outPath };
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const placed = await placeScan({ path: first.path, fileName: 'Договор.jpg', label: 'Карточка', downloadDir: dir });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    const second = await captureScan({
      label: 'Карточка',
      capture: async ({ outPath }) => {
        await fsp.writeFile(outPath, JPEG_HEADER);
        return { ok: true as const, kind: 'jpeg' as const, path: outPath };
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const placed2 = await placeScan({ path: second.path, fileName: 'Договор.jpg', label: 'Карточка', downloadDir: dir });
    expect(placed2.ok).toBe(true);
    if (!placed2.ok) return;

    const files = await fsp.readdir(placed2.folder);
    expect(files.filter((f) => f === 'Договор.jpg')).toHaveLength(1);
  });

  it('отменённый скан убирается, а не остаётся в папке объекта', async () => {
    const shot = await captureScan({
      label: 'Карточка',
      capture: async ({ outPath }) => {
        await fsp.writeFile(outPath, JPEG_HEADER);
        return { ok: true as const, kind: 'jpeg' as const, path: outPath };
      },
    });
    expect(shot.ok).toBe(true);
    if (!shot.ok) return;

    const dropped = await discardScan({ path: shot.path });
    expect(dropped.ok).toBe(true);
    await expect(fsp.access(shot.path)).rejects.toBeTruthy();
  });
});

describe('имя файла на диске', () => {
  it('путь из имени убирается — иначе файл уехал бы в другую папку', () => {
    expect(safeScanFileName('C:\\temp\\evil.jpg')).toBe('evil.jpg');
    expect(safeScanFileName('../../секрет.jpg')).toBe('секрет.jpg');
  });

  it('запрещённые символы заменяются, а не ломают имя', () => {
    expect(safeScanFileName('накладная: 12*?.jpg')).not.toMatch(/[:*?<>|]/);
  });

  it('пустое имя не даёт файл без расширения', () => {
    expect(safeScanFileName('   ')).toBe('scan.jpg');
  });
});

describe('папка объекта — своя у каждого объекта', () => {
  it('название сохраняется целиком: слеш не отрезает хвост', () => {
    // Раньше здесь работало имя ФАЙЛА (слеш отбрасывал всё до него), и папки
    // «41/26» и «12/26» схлопывались в одну «26» — файлы разных двигателей
    // лежали бы рядом, и скан попал бы не туда.
    expect(objectFolderName('Двигатель 41/26')).toBe('Двигатель 41-26');
    expect(objectFolderName('Двигатель 12/26')).toBe('Двигатель 12-26');
    expect(objectFolderName('Двигатель 41/26')).not.toBe(objectFolderName('Двигатель 12/26'));
  });

  it('скан и кнопка «Папка файлов» ведут в одну и ту же папку', () => {
    const dir = 'D:\\Загрузки\\MatricaRMZ_Files';
    expect(objectFilesFolder(dir, 'Двигатель 41/26')).toBe(objectFilesFolder(dir, 'Двигатель 41/26'));
    expect(objectFilesFolder(dir, 'Двигатель 41/26')).toContain(join('Объекты', 'Двигатель 41-26'));
  });

  it('без названия карточки папка всё равно называемая', () => {
    expect(objectFolderName('   ')).toBe('Карточка');
  });
});

describe('настройки съёмки (промт КАРМАНА #178)', () => {
  it('по умолчанию — цвет и максимум сканера', () => {
    const resolved = resolveScanSettings({ settings: { resolution: 'max', mode: 'color', size: 'max' }, capabilities: CAPS });
    expect(resolved.mode).toBe('color');
    expect(resolved.resolution).toBe(200);
    // «Во всю доступную величину» — это всё стекло A3, а не лист A4.
    expect(resolved.width).toBe(2338);
    expect(resolved.height).toBe(3307);
  });

  it('запрошенные 300 dpi, которых сканер не умеет, опускаются до его максимума', () => {
    const resolved = resolveScanSettings({ settings: { resolution: 300, mode: 'color', size: 'a4' }, capabilities: CAPS });
    expect(resolved.resolution).toBe(200);
    // Запасная цепочка: если драйвер откажется и от 200 — снимок всё равно состоится.
    expect(resolved.resChain[0]).toBe(200);
    expect(resolved.resChain).toContain(150);
  });

  it('150 dpi берутся, когда сканер их умеет', () => {
    const resolved = resolveScanSettings({ settings: { resolution: 150, mode: 'color', size: 'a4' }, capabilities: CAPS });
    expect(resolved.resolution).toBe(150);
    expect(resolved.resChain[0]).toBe(150);
  });

  it('размер A4 и A3 считаются по листу', () => {
    const a4 = resolveScanSettings({ settings: { resolution: 150, mode: 'color', size: 'a4' }, capabilities: CAPS });
    expect(a4.width).toBe(1240);
    expect(a4.height).toBe(1753);
    const a3 = resolveScanSettings({ settings: { resolution: 150, mode: 'color', size: 'a3' }, capabilities: CAPS });
    expect(a3.width).toBe(1753);
    expect(a3.height).toBe(2480);
  });

  it('цветной режим выбирает цветной тип данных драйвера', () => {
    const resolved = resolveScanSettings({ settings: { resolution: 'max', mode: 'color', size: 'a4' }, capabilities: CAPS });
    expect(resolved.mode).toBe('color');
    expect(resolved.dtChain[0]).toBe(3);
  });

  it('серый режим выбирает серый тип данных драйвера', () => {
    const resolved = resolveScanSettings({ settings: { resolution: 'max', mode: 'grayscale', size: 'a4' }, capabilities: CAPS });
    expect(resolved.mode).toBe('grayscale');
    expect(resolved.dtChain[0]).toBe(2);
  });

  it('чёрно-белое просит у драйвера настоящий чёрно-белый, а если нет — серый (порог делаем сами)', () => {
    const resolved = resolveScanSettings({ settings: { resolution: 'max', mode: 'blackwhite', size: 'a4' }, capabilities: CAPS });
    expect(resolved.mode).toBe('blackwhite');
    // Драйвер умеет только серое и цветное — значит кадр придёт серым, а два тона
    // делаем у себя. Настоящий чёрно-белое в цепочке остаётся запасным.
    expect(resolved.dtChain[0]).toBe(2);
    expect(resolved.dtChain).toContain(1);
  });

  it('сканер без цветного режима — деградация честная: снимаем серым', () => {
    const grayOnly: ScanCapabilities = { ...CAPS, supportedModes: ['grayscale'] };
    const resolved = resolveScanSettings({ settings: { resolution: 'max', mode: 'color', size: 'a4' }, capabilities: grayOnly });
    expect(resolved.mode).toBe('grayscale');
    expect(resolved.dtChain[0]).toBe(2);
  });
});

describe('съём идёт с параметрами, а полоса прогресса идёт по этапам', () => {
  it('захват получает разрешение, режим и размер, и полоса доходит до конца', async () => {
    const seen: { resolution: number; mode: string; width: number; height: number }[] = [];
    const stages: string[] = [];

    const shot = await captureScan({
      label: 'Двигатель 41/26',
      settings: { resolution: 300, mode: 'color', size: 'a4' },
      capabilities: CAPS,
      onProgress: (event) => stages.push(event.stage),
      capture: async ({ outPath, settings, onProgress }) => {
        seen.push({ resolution: settings.resolution, mode: settings.mode, width: settings.width, height: settings.height });
        onProgress?.({ stage: 'searching', label: 'Ищем сканер…', done: 0, total: 3 });
        onProgress?.({ stage: 'capturing', label: 'Снимаем кадр…', done: 1, total: 3 });
        onProgress?.({ stage: 'saving', label: 'Сохраняем файл…', done: 2, total: 3 });
        await fsp.writeFile(outPath, JPEG_HEADER);
        return {
          ok: true as const,
          kind: 'jpeg' as const,
          path: outPath,
          actual: {
            resolution: settings.resolution,
            mode: settings.mode,
            width: settings.width,
            height: settings.height,
            size: settings.size,
          },
        };
      },
    });

    expect(shot.ok).toBe(true);
    if (!shot.ok) return;
    // Параметры дошли до захвата: 300 dpi сканер не умеет — взяли 200.
    expect(seen[0]?.resolution).toBe(200);
    expect(seen[0]?.mode).toBe('color');
    expect(seen[0]?.width).toBe(1653);
    expect(seen[0]?.height).toBe(2338);
    // Полоса прошла все три этапа.
    expect(stages).toEqual(['searching', 'capturing', 'saving']);
    // Фактическое разрешение оператору известно.
    expect(shot.actual?.resolution).toBe(200);
    expect(shot.actual?.width).toBe(1653);
  });
});
