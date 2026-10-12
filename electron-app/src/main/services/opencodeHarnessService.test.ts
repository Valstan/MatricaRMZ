import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

// Встроенный харнесс OpenCode: тихая установка/serve/самообновление в userData.
// Сеть, процессы, ФС и electron — моки; настоящий только pure-домен shared.

const fsState = vi.hoisted(() => ({ files: new Map<string, string>() }));
const netState = vi.hoisted(() => ({
  release: 'ok' as 'ok' | 'throw',
  probeLive: false,
  probeVersion: '',
  downloaded: 0,
}));
const procState = vi.hoisted(() => ({
  spawned: [] as Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }>,
  killed: [] as number[],
  execCalls: [] as string[],
  tarWritesExe: true,
}));

const UD = '/ud';
// Сервис строит пути через node:path join — на win32 это бэкслэши; ключи мока ФС
// обязаны совпадать с ними, иначе stat/readFile промахнутся мимо записанного.
const EXE = join(UD, 'opencode', 'opencode.exe');
const DIR = join(UD, 'opencode');
const VERSION_TXT = join(DIR, 'version.txt');
const REG_JSON = join(UD, 'opencode-nodes.json');
const CFG_JSONC = join(DIR, 'config', 'opencode', 'opencode.jsonc');
const DATA_DIR = join(DIR, 'data');
const FIXTURE = 'opencode-binary-bytes';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? UD : `/x-${name}`),
  },
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
  mkdir: async () => undefined,
  rm: async (p: string) => {
    fsState.files.delete(String(p));
  },
  stat: async (p: string) => {
    const v = fsState.files.get(String(p));
    if (v == null) throw new Error('ENOENT');
    return { isFile: () => true, size: Buffer.byteLength(v) };
  },
}));

// createReadStream отдаёт байты фикстуры из мока ФС: настоящий createHash считает
// настоящий SHA256 — digest релиза в моке API обязан совпадать (см. FIXTURE_SHA256).
const FIXTURE_SHA256 = 'a444663db8b6d7b69193f28797363277b571969264a0127d7e7b0c83a085dc00';

vi.mock('node:fs', () => ({
  createReadStream: () => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const stream = {
      on: (ev: string, fn: (arg?: unknown) => void) => {
        handlers[ev] = fn;
        return stream;
      },
    };
    queueMicrotask(() => {
      handlers['data']?.(Buffer.from(FIXTURE));
      handlers['end']?.();
    });
    return stream;
  },
}));

vi.mock('node:os', () => ({
  networkInterfaces: () => ({
    eth: [{ family: 'IPv4', internal: false, address: '10.0.0.9' }],
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  }),
  hostname: () => 'test-pc',
  default: {},
}));

function routeExec(cmd: string, args: string[]): string {
  const base = String(cmd).split(/[\\/]/).pop();
  if (base === 'opencode.exe') {
    if (fsState.files.has(EXE)) return 'opencode v1.19.0';
    throw new Error('not found');
  }
  if (base === 'tar.exe') {
    if (procState.tarWritesExe) fsState.files.set(EXE, FIXTURE);
    return '';
  }
  if (base === 'taskkill.exe') {
    const i = args.indexOf('/PID');
    if (i >= 0) procState.killed.push(Number(args[i + 1]));
    return '';
  }
  if (base === 'netstat.exe') return '';
  if (base === 'netsh.exe') return 'No rules match the specified criteria.';
  return '';
}

// execFile вызывается через promisify — у настоящего execFile есть
// util.promisify.custom (resolve {stdout, stderr} объектом); мок повторяет оба пути.
const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

vi.mock('node:child_process', () => ({
  execFile: Object.assign(
    (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
      procState.execCalls.push(`${String(cmd).split(/[\\/]/).pop()} ${args.join(' ')}`);
      try {
        cb(null, routeExec(cmd, args));
      } catch (e) {
        cb(e as Error, '');
      }
    },
    {
      [PROMISIFY_CUSTOM]: async (cmd: string, args: string[], _opts: unknown) => {
        procState.execCalls.push(`${String(cmd).split(/[\\/]/).pop()} ${args.join(' ')}`);
        return { stdout: routeExec(cmd, args), stderr: '' };
      },
    },
  ),
  spawn: (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    procState.spawned.push({ cmd, args, env: opts?.env });
    netState.probeLive = true;
    return { pid: 4242, unref: () => {} };
  },
}));

vi.mock('./netFetch.js', () => ({
  fetchWithRetry: async (url: string) => {
    if (url.includes('api.github.com')) {
      if (netState.release === 'throw') throw new Error('offline');
      return {
        json: async () => ({
          tag_name: 'v1.19.0',
          assets: [{ name: 'opencode-windows-x64.zip', browser_download_url: 'https://x/opencode.zip', size: Buffer.byteLength(FIXTURE), digest: `sha256:${FIXTURE_SHA256}` }],
        }),
      };
    }
    if (url.includes('/global/health')) {
      if (!netState.probeLive) throw new Error('refused');
      return { json: async () => ({ healthy: true, version: '1.19.0' }) };
    }
    throw new Error(`unexpected url ${url}`);
  },
  downloadWithResume: async (_url: string, outPath: string) => {
    netState.downloaded += 1;
    fsState.files.set(String(outPath), FIXTURE);
    return { ok: true as const, filePath: outPath };
  },
}));

const svc = await import('./opencodeHarnessService.js');

beforeEach(() => {
  fsState.files.clear();
  netState.release = 'ok';
  netState.probeLive = false;
  netState.probeVersion = '';
  netState.downloaded = 0;
  procState.spawned = [];
  procState.killed = [];
  procState.execCalls = [];
  procState.tarWritesExe = true;
  // В моке процессы не рождаются: process.kill всегда «находит» pid живым,
  // иначе stopServeByPidFile свернул бы раньше taskkill.
  vi.spyOn(process, 'kill').mockImplementation(() => true as never);
  return () => vi.restoreAllMocks();
});

describe('opencodeHarnessService', () => {
  it('с нуля: качает, ставит, поднимает serve, пишет реестр', async () => {
    await svc.ensureOpencodeHarness();
    expect(netState.downloaded).toBe(1);
    expect(fsState.files.get(VERSION_TXT)).toBe('v1.19.0');
    expect(fsState.files.has(CFG_JSONC)).toBe(true);
    expect(procState.spawned).toHaveLength(1);
    expect(procState.spawned[0]?.args).toEqual(['serve', '--port', '3080', '--hostname', '0.0.0.0']);
    expect(procState.spawned[0]?.env?.XDG_DATA_HOME).toBe(DATA_DIR);
    const reg = JSON.parse(fsState.files.get(REG_JSON) ?? '{}') as { nodes?: Array<{ name: string; url: string }> };
    expect(reg.nodes).toEqual([{ name: 'test-pc', url: 'http://10.0.0.9:3080/' }]);
    const st = await svc.opencodeHarnessStatus();
    expect(st.installed).toBe(true);
    expect(st.installedVersion).toBe('1.19.0');
    expect(st.running).toBe(true);
  });

  it('актуальная версия: не качает, живой serve не трогает', async () => {
    fsState.files.set(EXE, FIXTURE);
    fsState.files.set(VERSION_TXT, 'v1.19.0');
    netState.probeLive = true;
    await svc.ensureOpencodeHarness();
    expect(netState.downloaded).toBe(0);
    expect(procState.spawned).toHaveLength(0);
  });

  it('без сети: молча пропускает, не бросает', async () => {
    netState.release = 'throw';
    await expect(svc.ensureOpencodeHarness()).resolves.toBeUndefined();
    const st = await svc.opencodeHarnessStatus();
    expect(st.installed).toBe(false);
  });

  it('stop гасит serve по pid-файлу', async () => {
    fsState.files.set(EXE, FIXTURE);
    await svc.ensureOpencodeHarness();
    expect(procState.spawned).toHaveLength(1);
    netState.probeLive = false;
    const r = await svc.opencodeHarnessStop();
    expect(r.stopped).toBe(true);
    expect(procState.killed).toContain(4242);
  });

  it('статус показывает отсутствие правила брандмауэра', async () => {
    const st = await svc.opencodeHarnessStatus();
    expect(st.firewallRulePresent).toBe(false);
    expect(st.exePath).toBe(EXE);
  });
});
