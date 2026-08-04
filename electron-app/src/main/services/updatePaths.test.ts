import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => join('C:', 'Users', 'x', 'AppData', 'Roaming', '@matricarmz', 'electron-app') },
}));

import { isPathInsideDir, LEGACY_INSTALL_DIR_NAME } from './updatePaths.js';

// Пути собираются join'ом, а не литералами с «\»: тесты гоняются и на Linux-раннере,
// где обратный слэш — обычный символ имени, и литеральный Windows-путь схлопывается
// в один сегмент (первая версия теста именно так и покраснела на CI, будучи зелёной локально).
const PROGRAMS = join('C:', 'Users', 'x', 'AppData', 'Local', 'Programs');
const LEGACY = join(PROGRAMS, LEGACY_INSTALL_DIR_NAME);
const CURRENT = join(PROGRAMS, 'MatricaRMZ');

describe('sweepLegacyInstallDir — защита от сноса собственного образа', () => {
  it('опознаёт запуск ИЗ прежнего каталога (переезд не состоялся → каталог не трогаем)', () => {
    expect(isPathInsideDir(LEGACY, join(LEGACY, 'MatricaRMZ.exe'))).toBe(true);
  });

  it('клиент, запущенный из НОВОГО каталога, прежний считает посторонним', () => {
    expect(isPathInsideDir(LEGACY, join(CURRENT, 'MatricaRMZ.exe'))).toBe(false);
  });

  it('соседние каталоги под тем же родителем не считаются вложенными', () => {
    // Сторож и кэш обновлений — сиблинги установки; префиксное сравнение строк
    // ошибочно сочло бы «…\MatricaRMZ-Watchdog» вложенным в «…\MatricaRMZ».
    expect(isPathInsideDir(CURRENT, join(PROGRAMS, 'MatricaRMZ-Watchdog', 'matricarmz-watchdog.exe'))).toBe(false);
    expect(isPathInsideDir(CURRENT, join(PROGRAMS, 'MatricaRMZ-Updates', 'matrica_rmz_update.exe'))).toBe(false);
  });

  it('сам каталог считается «внутри» себя', () => {
    expect(isPathInsideDir(LEGACY, LEGACY)).toBe(true);
  });
});
