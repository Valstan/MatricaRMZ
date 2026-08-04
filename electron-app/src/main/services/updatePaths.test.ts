import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\Users\\x\\AppData\\Roaming\\@matricarmz\\electron-app' },
}));

import { isPathInsideDir, LEGACY_INSTALL_DIR_NAME } from './updatePaths.js';

const LEGACY = `C:\\Users\\x\\AppData\\Local\\Programs\\${LEGACY_INSTALL_DIR_NAME}`;
const CURRENT = 'C:\\Users\\x\\AppData\\Local\\Programs\\MatricaRMZ';

describe('sweepLegacyInstallDir — защита от сноса собственного образа', () => {
  it('опознаёт запуск ИЗ прежнего каталога (переезд не состоялся → каталог не трогаем)', () => {
    expect(isPathInsideDir(LEGACY, `${LEGACY}\\MatricaRMZ.exe`)).toBe(true);
  });

  it('клиент, запущенный из НОВОГО каталога, прежний считает посторонним', () => {
    expect(isPathInsideDir(LEGACY, `${CURRENT}\\MatricaRMZ.exe`)).toBe(false);
  });

  it('соседние каталоги под тем же родителем не считаются вложенными', () => {
    // Сторож и кэш обновлений — сиблинги установки; префиксное сравнение строк
    // ошибочно сочло бы "…\\MatricaRMZ-Watchdog" вложенным в "…\\MatricaRMZ".
    expect(isPathInsideDir(CURRENT, `${CURRENT}-Watchdog\\matricarmz-watchdog.exe`)).toBe(false);
    expect(isPathInsideDir(CURRENT, `${CURRENT}-Updates\\matrica_rmz_update.exe`)).toBe(false);
  });

  it('сам каталог считается «внутри» себя', () => {
    expect(isPathInsideDir(LEGACY, LEGACY)).toBe(true);
  });
});
