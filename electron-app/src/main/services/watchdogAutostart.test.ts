import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  writeShortcutLink: vi.fn(() => true),
  netFetch: vi.fn(async () => ({ ok: true })),
  execFileCalls: [] as string[][],
  execFileFails: new Set<string>(),
  files: new Map<string, number>(),
  isPackaged: true,
  paths: {
    appData: 'C:\\Users\\op\\AppData\\Roaming',
    userData: 'C:\\Users\\op\\AppData\\Roaming\\@matricarmz\\electron-app',
    exe: 'C:\\Users\\op\\AppData\\Local\\Programs\\MatricaRMZ\\MatricaRMZ.exe',
    desktop: 'C:\\Users\\op\\Desktop',
  } as Record<string, string>,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return hoisted.isPackaged;
    },
    getPath: (key: string) => hoisted.paths[key] ?? '',
  },
  shell: { writeShortcutLink: hoisted.writeShortcutLink },
  net: { fetch: hoisted.netFetch },
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
  ) => {
    hoisted.execFileCalls.push([file, ...args]);
    const taskName = args[args.indexOf('/TN') + 1] ?? '';
    const verb = args[0] ?? '';
    if (hoisted.execFileFails.has(`${verb} ${taskName}`)) {
      cb(new Error('ERROR: Access is denied.'), { stdout: '', stderr: '' });
      return;
    }
    cb(null, { stdout: '', stderr: '' });
  },
}));

vi.mock('node:fs/promises', () => ({
  stat: async (p: string) => {
    const size = hoisted.files.get(String(p));
    if (size === undefined) throw new Error('ENOENT');
    return { isFile: () => true, size };
  },
  copyFile: async (from: string, to: string) => {
    hoisted.files.set(String(to), hoisted.files.get(String(from)) ?? 1);
  },
  mkdir: async () => {},
  writeFile: async () => {},
}));

vi.mock('./updatePaths.js', () => ({ getUpdatesRootDir: () => 'C:\\updates' }));

import {
  ensureWatchdogInstalled,
  reportWatchdogAutostartIfBroken,
  watchdogLogonShortcutPath,
} from './watchdogHandshakeService.js';

// Пути строим тем же `join`, что и сервис: CI гоняет тесты на Linux, где разделитель
// «/», и захардкоженный windows-путь не совпал бы с ключом мока — тест был бы зелёным
// на Windows и красным в CI (ровно это и случилось на первом прогоне).
const LOCAL_APP_DATA = 'C:\\Users\\op\\AppData\\Local';
const WATCHDOG_EXE = join(LOCAL_APP_DATA, 'Programs', 'MatricaRMZ-Watchdog', 'matricarmz-watchdog.exe');
const originalPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('ensureWatchdogInstalled — автозапуск сторожа при входе', () => {
  beforeEach(() => {
    setPlatform('win32');
    process.env.LOCALAPPDATA = LOCAL_APP_DATA;
    process.env.SystemRoot = 'C:\\Windows';
    hoisted.writeShortcutLink.mockClear();
    hoisted.writeShortcutLink.mockReturnValue(true);
    hoisted.netFetch.mockClear();
    hoisted.execFileCalls.length = 0;
    hoisted.execFileFails.clear();
    hoisted.files.clear();
    hoisted.files.set(WATCHDOG_EXE, 5_351_424);
    hoisted.isPackaged = true;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('создаёт ярлык автозапуска, когда его нет', async () => {
    await ensureWatchdogInstalled();

    expect(hoisted.writeShortcutLink).toHaveBeenCalledTimes(1);
    const [path, operation, options] = hoisted.writeShortcutLink.mock.calls[0] as unknown as [
      string,
      string,
      { target: string },
    ];
    expect(path).toBe(watchdogLogonShortcutPath());
    expect(path).toBe(
      join(hoisted.paths.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'MatricaRMZ Watchdog.lnk'),
    );
    expect(operation).toBe('create');
    expect(options.target).toBe(WATCHDOG_EXE);
  });

  it('не трогает ярлык, который уже на месте', async () => {
    hoisted.files.set(watchdogLogonShortcutPath(), 1024);

    await ensureWatchdogInstalled();

    expect(hoisted.writeShortcutLink).not.toHaveBeenCalled();
  });

  // Регресс rmz4val 2026-08: schtasks.exe не умеет создавать logon-задачу для текущего
  // пользователя без прав администратора — и `/SC ONLOGON`, и `/SC ONLOGON /RU <user>`
  // отвечают «Отказано в доступе», тогда как `/SC MINUTE` тем же вызовом проходит.
  // Задача «Watchdog Logon» не существовала ни на одной машине парка, а heal пытался
  // создать её при каждом старте клиента.
  it('больше не просит schtasks о logon-задаче', async () => {
    await ensureWatchdogInstalled();

    const taskNames = hoisted.execFileCalls
      .map((call) => call[call.indexOf('/TN') + 1] ?? '')
      .filter(Boolean);
    expect(taskNames).not.toContain('MatricaRMZ\\Watchdog Logon');
    expect(taskNames).toContain('MatricaRMZ\\Watchdog Periodic');
  });

  it('чинит периодическую задачу, когда её нет', async () => {
    hoisted.execFileFails.add('/Query MatricaRMZ\\Watchdog Periodic');

    await ensureWatchdogInstalled();

    const created = hoisted.execFileCalls.filter((call) => call.includes('/Create'));
    expect(created).toHaveLength(1);
    expect(created[0]).toContain('MatricaRMZ\\Watchdog Periodic');
    expect(created[0]).toContain('/MO');
  });

  it('сообщает наружу, что автозапуск восстановлен', async () => {
    const result = await ensureWatchdogInstalled();

    expect(result.logonShortcutRestored).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('сообщает наружу неудачу создания ярлыка', async () => {
    hoisted.writeShortcutLink.mockReturnValue(false);

    const result = await ensureWatchdogInstalled();

    expect(result.logonShortcutRestored).toBe(false);
    expect(result.failures).toContain('logon-shortcut');
  });

  it('досылает неудачу автозапуска в критические события — один раз', async () => {
    hoisted.writeShortcutLink.mockReturnValue(false);
    await ensureWatchdogInstalled();

    await reportWatchdogAutostartIfBroken({
      clientId: 'RMZ4VAL-1',
      apiBaseUrl: 'https://server/',
      version: '3.13.0',
    });
    await reportWatchdogAutostartIfBroken({
      clientId: 'RMZ4VAL-1',
      apiBaseUrl: 'https://server/',
      version: '3.13.0',
    });

    expect(hoisted.netFetch).toHaveBeenCalledTimes(1);
    const [url, init] = hoisted.netFetch.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://server/client/watchdog/report');
    const body = JSON.parse(init.body) as { kind: string; detail: string; clientId: string };
    expect(body.kind).toBe('autostart_broken');
    expect(body.clientId).toBe('RMZ4VAL-1');
    expect(body.detail).toContain('logon-shortcut');
  });

  it('молчит, когда чинить было нечего', async () => {
    await ensureWatchdogInstalled();

    await reportWatchdogAutostartIfBroken({
      clientId: 'RMZ4VAL-1',
      apiBaseUrl: 'https://server',
      version: '3.13.0',
    });

    expect(hoisted.netFetch).not.toHaveBeenCalled();
  });

  it('чинит планировщик, даже если бинарь сторожа не восстановился', async () => {
    hoisted.files.clear();

    const result = await ensureWatchdogInstalled();

    expect(result.failures).toContain('watchdog-exe');
    expect(hoisted.execFileCalls.length).toBe(0);
    expect(hoisted.writeShortcutLink).not.toHaveBeenCalled();
  });
});
