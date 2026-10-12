import { beforeEach, describe, expect, it, vi } from 'vitest';

// Реестр узлов opencode serve: чтение/запись локального userData-файла,
// проба через fetchWithRetry. Файловая система, electron и сеть — моки.

const fsState = vi.hoisted(() => ({ files: new Map<string, string>() }));
const netState = vi.hoisted(() => ({ failUrls: new Set<string>() }));

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
  net: {},
}));

vi.mock('node:fs/promises', () => ({
  readFile: async (p: string) => {
    const v = fsState.files.get(String(p));
    if (v == null) throw new Error('ENOENT');
    return v;
  },
  writeFile: async (p: string, content: string) => {
    fsState.files.set(String(p), String(content));
  },
}));

vi.mock('./netFetch.js', () => ({
  fetchWithRetry: async (url: string) => {
    if (netState.failUrls.has(String(url))) throw new Error('timeout');
    return { status: 404 };
  },
}));

const { opencodeNodesList, opencodeNodesSave, probeOpencodeNode, probeOpencodeNodes } = await import(
  './opencodeNodesStore.js'
);

beforeEach(() => {
  fsState.files.clear();
  netState.failUrls.clear();
});

describe('opencodeNodesStore', () => {
  it('пусто без файла', async () => {
    await expect(opencodeNodesList()).resolves.toEqual([]);
  });

  it('round-trip с нормализацией', async () => {
    const saved = await opencodeNodesSave([
      { name: 'pc79', url: '10.0.0.5' },
      { name: 'битый', url: '' },
    ]);
    expect(saved).toHaveLength(1);
    await expect(opencodeNodesList()).resolves.toEqual(saved);
  });

  it('битый JSON читается как пусто', async () => {
    fsState.files.set('/userData/opencode-nodes.json', '{oops');
    await expect(opencodeNodesList()).resolves.toEqual([]);
  });

  it('проба: ответ — live, сеть — dead', async () => {
    const live = await probeOpencodeNode('http://a:3080/');
    expect(live.live).toBe(true);
    expect(live.httpStatus).toBe(404);
    expect(live.error).toBeNull();
    netState.failUrls.add('http://b:3080/');
    const dead = await probeOpencodeNode('http://b:3080/');
    expect(dead.live).toBe(false);
    expect(dead.httpStatus).toBeNull();
    expect(dead.error).toBe('timeout');
  });

  it('probeOpencodeNodes идёт по реестру', async () => {
    await opencodeNodesSave([{ name: 'a', url: 'http://a:3080/' }]);
    const probes = await probeOpencodeNodes();
    expect(probes).toHaveLength(1);
    expect(probes[0]?.live).toBe(true);
  });
});
