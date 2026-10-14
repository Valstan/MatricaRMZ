import { describe, expect, it, vi } from 'vitest';

// Локальный узел ведёт сам клиент (план opencode-native): чистые помощники —
// выбор ассета релиза, слияние узла в реестр, per-user каталог. Сеть и spawn
// здесь не трогаем (интеграция — смоук на стенде).

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
}));

const { localNodeName, mergeLocalNodeUrl, opencodeDataDir, opencodeInstallDir, pickReleaseAsset, serveSpawnEnv, watchBackoffMs, OPENCODE_WATCH_MS } = await import(
  './opencodeServeManager.js'
);

const RELEASE = [
  {
    tag_name: 'v1.19.0',
    assets: [
      { name: 'opencode-linux-x64.zip', browser_download_url: 'https://x/linux.zip', size: 1, digest: 'sha256:aa' },
      {
        name: 'opencode-windows-x64.zip',
        browser_download_url: 'https://x/win.zip',
        size: 59300000,
        digest: 'sha256:BBCC',
      },
    ],
  },
];

describe('pickReleaseAsset', () => {
  it('берёт windows-ассет первого подходящего релиза, SHA256 из digest', () => {
    expect(pickReleaseAsset(RELEASE)).toEqual({
      tag: 'v1.19.0',
      version: '1.19.0',
      name: 'opencode-windows-x64.zip',
      url: 'https://x/win.zip',
      size: 59300000,
      sha256: 'bbcc',
    });
  });

  it('без нужного ассета и digest — отказ, а не установка вслепую', () => {
    expect(() => pickReleaseAsset([{ tag_name: 'v9', assets: [] }])).toThrow();
    expect(() => pickReleaseAsset([{ tag_name: 'v9', assets: [{ name: 'opencode-windows-x64.zip' }] }])).toThrow();
  });
});

describe('mergeLocalNodeUrl', () => {
  it('свой узел вливается с заменой по url, чужие целы', () => {
    const merged = mergeLocalNodeUrl(
      [
        { name: 'peer', url: 'http://192.168.1.5:3080/' },
        { name: 'old-self', url: 'http://127.0.0.1:3080/' },
      ],
      { name: 'PC79', url: 'http://127.0.0.1:3080/' },
    );
    expect(merged).toEqual([
      { name: 'peer', url: 'http://192.168.1.5:3080/' },
      { name: 'PC79', url: 'http://127.0.0.1:3080/' },
    ]);
  });
});

describe('per-user paths', () => {
  it('имя узла — имя машины, каталог — без админа', () => {
    expect(localNodeName().length).toBeGreaterThan(0);
    const dir = opencodeInstallDir();
    if (process.platform === 'win32') {
      // Per-user, не машино-широко: установщик без UAC в PROGRAMDATA не пишет.
      expect(dir).toContain('MatricaRMZ-OpenCode');
      expect(dir.toLowerCase().startsWith(String(process.env.PROGRAMDATA ?? ':\\').toLowerCase())).toBe(false);
    } else {
      // Вне Windows ассета нет — только userData-заглушка, узел unsupported.
      expect(dir).toContain('opencode-node');
    }
  });
});

describe('D10 слайс 1: изоляция данных', () => {
  it('данные узла — подкаталог установки (win32) или userData (иначе)', async () => {
    const { join } = await import('node:path');
    expect(opencodeDataDir('C:\\n\\MatricaRMZ-OpenCode', { platform: 'win32' })).toBe(
      join('C:\\n\\MatricaRMZ-OpenCode', 'data'),
    );
    expect(opencodeDataDir('C:\\n\\MatricaRMZ-OpenCode', { platform: 'linux', userData: '/u' })).toBe(
      join('/u', 'opencode-node-data'),
    );
  });

  it('spawn несёт изолированный XDG_DATA_HOME, остальное env — как было', async () => {
    const env = serveSpawnEnv('D:\\node-data', { PATH: '/x', HOME: '/h' });
    expect(env.XDG_DATA_HOME).toBe('D:\\node-data');
    expect(env.PATH).toBe('/x');
    expect(env.HOME).toBe('/h');
  });
});

describe('D10 слайс 1: бэкофф вотчера', () => {
  it('интервал вотчера — 15 с', () => {
    expect(OPENCODE_WATCH_MS).toBe(15_000);
  });

  it('первый повтор быстро, дальше реже, потолок 5 мин', () => {
    expect(watchBackoffMs(1)).toBe(30_000);
    expect(watchBackoffMs(2)).toBe(60_000);
    expect(watchBackoffMs(3)).toBe(120_000);
    expect(watchBackoffMs(4)).toBe(240_000);
    expect(watchBackoffMs(5)).toBe(300_000);
    expect(watchBackoffMs(99)).toBe(300_000);
    expect(watchBackoffMs(0)).toBe(15_000);
  });
});
