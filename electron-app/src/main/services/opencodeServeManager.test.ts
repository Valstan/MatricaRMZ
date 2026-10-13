import { describe, expect, it, vi } from 'vitest';

// Локальный узел ведёт сам клиент (план opencode-native): чистые помощники —
// выбор ассета релиза, слияние узла в реестр, per-user каталог. Сеть и spawn
// здесь не трогаем (интеграция — смоук на стенде).

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
}));

const { localNodeName, mergeLocalNodeUrl, opencodeInstallDir, pickReleaseAsset } = await import(
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
    expect(dir).toContain('MatricaRMZ-OpenCode');
    // Per-user, не машино-широко: установщик без UAC в PROGRAMDATA не пишет.
    expect(dir.toLowerCase().startsWith(String(process.env.PROGRAMDATA ?? ':\\').toLowerCase())).toBe(false);
  });
});
