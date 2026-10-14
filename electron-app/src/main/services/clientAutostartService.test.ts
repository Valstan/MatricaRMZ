import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { writeShortcutLink: vi.fn(() => true) },
  app: { getPath: () => '' },
}));

import {
  CLIENT_AUTOSTART_ARGS,
  CLIENT_AUTOSTART_SHORTCUT_NAME,
  clientAutostartShortcutPath,
  ensureClientAutostart,
  isMinimizedLaunch,
  resolveStartupDir,
} from './clientAutostartService.js';

describe('clientAutostartService (C9)', () => {
  it('каталог автозагрузки — Startup профиля, override — для dev/стенда', () => {
    expect(resolveStartupDir('C:\\Users\\op\\AppData\\Roaming', {})).toBe(
      'C:\\Users\\op\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
    );
    expect(resolveStartupDir('C:\\x', { MATRICA_AUTOSTART_DIR: 'D:\\stage-startup' })).toBe('D:\\stage-startup');
  });

  it('имя ярлыка и флаг свёрнутого запуска', () => {
    expect(CLIENT_AUTOSTART_SHORTCUT_NAME).toBe('MatricaRMZ.lnk');
    expect(CLIENT_AUTOSTART_ARGS).toBe('--minimized');
    expect(clientAutostartShortcutPath('D:\\stage-startup')).toBe('D:\\stage-startup\\MatricaRMZ.lnk');
  });

  it('свёрнутый запуск — по флагу ярлыка или env', () => {
    expect(isMinimizedLaunch(['exe', '--minimized'], {})).toBe(true);
    expect(isMinimizedLaunch(['exe'], { MATRICA_START_MINIMIZED: '1' })).toBe(true);
    expect(isMinimizedLaunch(['exe'], {})).toBe(false);
    expect(isMinimizedLaunch(['exe'], { MATRICA_START_MINIMIZED: '0' })).toBe(false);
  });

  it('чинит запись create-операцией с целью и флагом', () => {
    const write = vi.fn(() => true);
    const log = vi.fn();
    const ok = ensureClientAutostart({
      platform: 'win32',
      isPackaged: true,
      execPath: 'C:\\Prog\\MatricaRMZ\\MatricaRMZ.exe',
      startupDir: 'D:\\stage-startup',
      writeShortcutLink: write,
      log,
    });
    expect(ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      'D:\\stage-startup\\MatricaRMZ.lnk',
      'create',
      expect.objectContaining({
        target: 'C:\\Prog\\MatricaRMZ\\MatricaRMZ.exe',
        args: '--minimized',
      }),
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('dev с override пишет в подменённый каталог (смоук стенда), без него — no-op', () => {
    const write = vi.fn(() => true);
    const ok = ensureClientAutostart({
      platform: 'win32',
      isPackaged: false,
      execPath: 'C:\\Prog\\MatricaRMZ\\MatricaRMZ.exe',
      startupDir: 'D:\\stage-startup',
      writeShortcutLink: write,
      env: { MATRICA_AUTOSTART_DIR: 'D:\\stage-startup' },
    });
    expect(ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('вне win32/упаковки — no-op, отказ — false с записью в лог, не бросок', () => {
    expect(
      ensureClientAutostart({ platform: 'linux', isPackaged: true, execPath: 'x', startupDir: 'y', env: {} }),
    ).toBe(false);
    expect(
      ensureClientAutostart({ platform: 'win32', isPackaged: false, execPath: 'x', startupDir: 'y', env: {} }),
    ).toBe(false);
    const log = vi.fn();
    expect(
      ensureClientAutostart({
        platform: 'win32',
        isPackaged: true,
        execPath: 'x',
        startupDir: 'y',
        writeShortcutLink: () => {
          throw new Error(' boom ');
        },
        log,
      }),
    ).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    const log2 = vi.fn();
    expect(
      ensureClientAutostart({
        platform: 'win32',
        isPackaged: true,
        execPath: 'x',
        startupDir: 'y',
        writeShortcutLink: () => false,
        log: log2,
      }),
    ).toBe(false);
    expect(log2).toHaveBeenCalledTimes(1);
  });
});
