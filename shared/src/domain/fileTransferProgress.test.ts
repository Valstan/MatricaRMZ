import { describe, expect, it } from 'vitest';

import {
  fileTransferPercent,
  fileTransferPhaseLabel,
  formatFileSize,
  isFileTransferActive,
} from './fileTransferProgress.js';

describe('прогресс передачи файла', () => {
  it('процент считается только когда объём известен', () => {
    expect(fileTransferPercent({ bytesDone: 50, bytesTotal: 200 })).toBe(25);
    expect(fileTransferPercent({ bytesDone: 200, bytesTotal: 200 })).toBe(100);
    // объём неизвестен → процент НЕ выдумываем (показываем «крутилку»)
    expect(fileTransferPercent({ bytesDone: 50, bytesTotal: null })).toBeNull();
    expect(fileTransferPercent({ bytesDone: 0, bytesTotal: 0 })).toBeNull();
  });

  it('процент не вылезает за 100 и не уходит в минус', () => {
    expect(fileTransferPercent({ bytesDone: 999, bytesTotal: 200 })).toBe(100);
    expect(fileTransferPercent({ bytesDone: -5, bytesTotal: 200 })).toBe(0);
  });

  it('идёт передача — показываем полосу, закончилась — не показываем', () => {
    expect(isFileTransferActive({ phase: 'preparing' })).toBe(true);
    expect(isFileTransferActive({ phase: 'transferring' })).toBe(true);
    expect(isFileTransferActive({ phase: 'finalizing' })).toBe(true);
    expect(isFileTransferActive({ phase: 'done' })).toBe(false);
    expect(isFileTransferActive({ phase: 'error' })).toBe(false);
  });

  it('размер файла — по-человечески', () => {
    expect(formatFileSize(512)).toBe('512 Б');
    expect(formatFileSize(2048)).toBe('2,0 КБ');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5,0 МБ');
    expect(formatFileSize(null)).toBe('—');
  });

  it('подпись фазы различает отправку и скачивание', () => {
    expect(fileTransferPhaseLabel({ phase: 'transferring', direction: 'upload' })).toBe('Отправляем…');
    expect(fileTransferPhaseLabel({ phase: 'transferring', direction: 'download' })).toBe('Скачиваем…');
    expect(fileTransferPhaseLabel({ phase: 'done', direction: 'upload' })).toBe('Готово');
  });
});
