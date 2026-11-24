import { describe, expect, it } from 'vitest';

import {
  MAX_OS_PRINT_FILES,
  osPrintWizardAvailable,
  printImageViaOsWizard,
  printImagesViaOsWizard,
} from './localImagePrint.js';

const isWin = process.platform === 'win32';

describe('системный мастер печати фотографий (промт КАРМАНА #102)', () => {
  it('доступность мастера совпадает с ОС: Windows — да, иначе нет', () => {
    expect(osPrintWizardAvailable()).toBe(isWin);
  });

  it('на не-Windows канал честно отказывает, а не молчит', async () => {
    if (isWin) {
      // На Windows проверяем отдельно: пустой список — понятная ошибка.
      const empty = await printImagesViaOsWizard([]);
      expect(empty.ok).toBe(false);
      return;
    }
    const res = await printImagesViaOsWizard(['/tmp/фото.jpg']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('только на Windows');
  });

  it('пустой список картинок — понятная ошибка', async () => {
    const res = await printImagesViaOsWizard([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Не выбрано');
  });

  it('пустой путь не запускает ничего', async () => {
    await expect(printImageViaOsWizard('   ')).resolves.toBe(false);
  });

  it('потолок на число файлов за один вызов', () => {
    expect(MAX_OS_PRINT_FILES).toBeGreaterThan(0);
    expect(MAX_OS_PRINT_FILES).toBeLessThanOrEqual(100);
  });
});
