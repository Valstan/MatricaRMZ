import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Гейт печати картинок (промт КАРМАНА #159).
 *
 * Проверяются вещи, которые легко сломать правкой и которые оператору стоят дорого:
 *  1. **Одна реализация печати** — `photosPrint` и `photosPrintLocalPaths` больше
 *     не две копии, а тонкие обёртки над общим шагом `printPhotos`;
 *  2. **Внятный отказ** — нет принтера → «принтер не найден», а не «отправлено на печать»;
 *  3. **Печать не теряется** — если диалог печати Chromium на машине не работает
 *     («Invalid printer settings», проверено на PC79 26.11.2026), печать уходит
 *     в системный мастер печати фотографий, и оператор видит почему.
 */

type PrintResult = {
  ok: boolean;
  error?: string;
  reason?: string;
  via?: string;
  note?: string;
  images?: number;
  skipped?: string[];
};

/** Что вернул `webContents.print()` в последнем вызове. */
let printOutcome: { ok: boolean; reason: string } = { ok: true, reason: '' };
/** Принтеры, которые «видит» машина. */
let systemPrinters: string[] = ['Canon MF3010'];
/** Что сделал системный мастер печати фотографий. */
let wizardCalls: string[][] = [];
let wizardOk = true;

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      getPrintersAsync: async () => systemPrinters.map((name) => ({ name, displayName: name })),
      print: (_opts: unknown, cb: (ok: boolean, reason: string) => void) => cb(printOutcome.ok, printOutcome.reason),
      loadFile: async () => undefined,
    };
    async loadFile(): Promise<void> {}
    destroy(): void {}
  },
}));

vi.mock('./localImagePrint.js', () => ({
  printImagesViaOsWizard: async (paths: string[]) => {
    wizardCalls.push(paths);
    if (!wizardOk) return { ok: false as const, error: 'Системный мастер печати не открылся' };
    return { ok: true as const, opened: paths.length, failed: 0 };
  },
}));

vi.mock('./photoPrintWizard.js', () => ({
  openPhotoPrintWizard: async (paths: string[]) => {
    wizardCalls.push(paths);
    if (!wizardOk) return { ok: false as const, error: 'Мастер печати не открылся' };
    return { ok: true as const };
  },
}));

import { describePrintFailure, printPhotos, splitPrintTargets } from './photoPrint.js';

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

beforeEach(() => {
  printOutcome = { ok: true, reason: '' };
  systemPrinters = ['Canon MF3010'];
  wizardCalls = [];
  wizardOk = true;
});

describe('печать картинок: общий шаг', () => {
  it('картинки печатаются картинками, остальное — списком', () => {
    const { images, skipped } = splitPrintTargets(['D:\\a\\1.jpg', 'D:\\a\\2.png', 'D:\\a\\doc.pdf', '  ']);
    expect(images).toEqual(['D:\\a\\1.jpg', 'D:\\a\\2.png']);
    expect(skipped).toEqual(['doc.pdf']);
  });

  it('отказ Chromium разбирается на три разные причины', () => {
    expect(describePrintFailure('Print job canceled').kind).toBe('cancelled');
    expect(describePrintFailure('Invalid printer settings').kind).toBe('dialog-unavailable');
    expect(describePrintFailure('Print job failed').kind).toBe('failed');
  });

  it('нет принтера — оператору называют причину, а не рапортуют об успехе', async () => {
    systemPrinters = [];
    const res = (await printPhotos(['D:\\a\\1.jpg'])) as PrintResult;
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-printers');
    expect(res.error).toContain('Принтер не найден');
    expect(wizardCalls).toEqual([]);
  });

  it('диалог печати сработал — печать идёт через него', async () => {
    const res = (await printPhotos(['D:\\a\\1.jpg'])) as PrintResult;
    expect(res.ok).toBe(true);
    expect(res.via).toBe('dialog');
    expect(wizardCalls).toEqual([]);
  });

  it('диалог печати не работает на машине — печать уходит в системный мастер, и видна причина', async () => {
    printOutcome = { ok: false, reason: 'Invalid printer settings' };
    const res = (await printPhotos(['D:\\a\\1.jpg'])) as PrintResult;
    expect(res.ok).toBe(true);
    expect(res.via).toBe('os-wizard');
    expect(res.note).toContain('Invalid printer settings');
    expect(wizardCalls).toEqual([['D:\\a\\1.jpg']]);
  });

  it('оператор отменил печать — это не поломка и не мастер', async () => {
    printOutcome = { ok: false, reason: 'Print job canceled' };
    const res = (await printPhotos(['D:\\a\\1.jpg'])) as PrintResult;
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('cancelled');
    expect(wizardCalls).toEqual([]);
  });

  it('режим мастера идёт в системный мастер печати фотографий', async () => {
    const res = (await printPhotos(['D:\\a\\1.jpg'], { mode: 'os' })) as PrintResult;
    expect(res.ok).toBe(true);
    expect(res.via).toBe('os-wizard');
    expect(wizardCalls).toEqual([['D:\\a\\1.jpg']]);
  });

  it('нечего печатать — понятный отказ', async () => {
    const res = (await printPhotos([])) as PrintResult;
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-files');
  });
});

describe('печать картинок: одна реализация, а не две копии', () => {
  const fileService = src('./fileService.ts');

  it('обе печати — тонкие обёртки над общим шагом printPhotos', () => {
    expect(fileService).toContain("from './photoPrint.js'");
    // В fileService.ts не осталось своей печати: окно и `webContents.print` — в модуле.
    expect(fileService).not.toContain('webContents.print(');
    const photosPrint = fileService.split('export async function photosPrint(')[1] ?? '';
    const localPaths = fileService.split('export async function photosPrintLocalPaths(')[1] ?? '';
    expect(photosPrint).toContain('printPhotos(');
    expect(localPaths).toContain('printPhotos(');
  });

  it('модуль печати — единственное место, где печатают картинки', () => {
    const module = src('./photoPrint.ts');
    expect(module).toContain('webContents.print(');
    expect(module).toContain('readSystemPrinters');
  });
});
