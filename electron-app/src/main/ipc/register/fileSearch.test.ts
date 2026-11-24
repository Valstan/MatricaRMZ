import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => unknown>();
let pickedPaths: string[] = [];

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: any[]) => unknown) => void handlers.set(ch, fn) },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => ({ canceled: pickedPaths.length === 0, filePaths: pickedPaths }),
  },
}));

import { registerFileSearchIpc } from './fileSearch.js';

let dir = '';
let sqlite: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrica-file-search-ipc-'));
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE sync_state (key text PRIMARY KEY NOT NULL, value text, updated_at integer NOT NULL)`);
  registerFileSearchIpc(makeCtx('user-1'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  sqlite.close();
  handlers.clear();
  pickedPaths = [];
});

function makeCtx(actor: string) {
  const db = drizzle(sqlite);
  return {
    sysDb: db,
    dataDb: () => db,
    mode: () => ({ mode: 'live' }) as const,
    mgr: { getApiBaseUrl: () => 'http://test' },
    logToFile: () => undefined,
    currentActor: async () => actor,
    currentViewer: async () => ({ login: actor, role: 'admin' }),
    currentPermissions: async () => ({ 'engines.view': true, 'engines.edit': true }),
  } as any;
}

describe('fileSearch:sources', () => {
  it('список источников сохраняется по пользователю и переживает перезапуск', async () => {
    const filePath = join(dir, 'акты.txt');
    writeFileSync(filePath, 'строка\n', 'utf8');
    const sources = [
      { id: 'fs_1', path: filePath, name: 'акты.txt', kind: 'text' as const, addedAt: 1, size: 6, modifiedAt: 1 },
    ];
    const set = handlers.get('fileSearch:sources:set')!;
    expect(await set({}, { sources })).toEqual({ ok: true });

    const get = handlers.get('fileSearch:sources:get')!;
    const mine = (await get({})) as { ok: boolean; sources: { path: string }[] };
    expect(mine.sources.map((s) => s.path)).toEqual([filePath]);

    // Другой пользователь на этой машине видит свой пустой список.
    registerFileSearchIpc(makeCtx('user-2'));
    const other = (await handlers.get('fileSearch:sources:get')!({})) as { ok: boolean; sources: unknown[] };
    expect(other.sources).toEqual([]);
  });
});

describe('fileSearch:pick', () => {
  it('поддерживаемый файл становится источником, неподдерживаемый — в skipped', async () => {
    const good = join(dir, 'акты.txt');
    const bad = join(dir, 'акты.pdf');
    writeFileSync(good, 'строка\n', 'utf8');
    writeFileSync(bad, 'x', 'utf8');
    pickedPaths = [good, bad];

    const pick = handlers.get('fileSearch:pick')!;
    const r = (await pick({})) as { ok: boolean; sources: { path: string; kind: string }[]; skipped: string[] };
    expect(r.ok).toBe(true);
    expect(r.sources).toHaveLength(1);
    const first = r.sources[0];
    if (!first) throw new Error('ожидался один источник');
    expect(first.kind).toBe('text');
    expect(first.path).toBe(good);
    expect(r.skipped[0]).toContain(bad);
  });
});

describe('fileSearch:search', () => {
  it('ищет по источникам и отдаёт результат', async () => {
    const filePath = join(dir, 'акты.txt');
    writeFileSync(filePath, 'приёмка двигателя 41/26\n', 'utf8');
    const search = handlers.get('fileSearch:search')!;
    const r = (await search({}, {
      sources: [{ id: 'fs_1', path: filePath, name: 'акты.txt', kind: 'text' as const, addedAt: 1, size: 1, modifiedAt: 1 }],
      query: '41/26',
    })) as { ok: boolean; result: { matches: unknown[]; unreadable: unknown[] } };
    expect(r.ok).toBe(true);
    expect(r.result.matches).toHaveLength(1);
    expect(r.result.unreadable).toEqual([]);
  });
});

describe('папки: хранение, поиск по названию, печать (промт КАРМАНА #88)', () => {
  it('папки сохраняются по пользователю и переживают перезапуск', async () => {
    const folders = [{ id: 'fsf_1', path: join(dir, 'Э06АТ0889'), name: 'Э06АТ0889', addedAt: 1 }];
    const set = handlers.get('fileSearch:folders:set')!;
    expect(await set({}, { folders })).toEqual({ ok: true });

    const get = handlers.get('fileSearch:folders:get')!;
    const mine = (await get({})) as { ok: boolean; folders: { path: string }[] };
    expect(mine.folders.map((f) => f.path)).toEqual([join(dir, 'Э06АТ0889')]);

    // Другой пользователь на этой машине видит свой пустой список.
    registerFileSearchIpc(makeCtx('user-2'));
    const other = (await handlers.get('fileSearch:folders:get')!({})) as { ok: boolean; folders: unknown[] };
    expect(other.folders).toEqual([]);
  });

  it('поиск идёт по сохранённым папкам, а не по тому, что прислал renderer', async () => {
    const engineDir = join(dir, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeFileSync(join(engineDir, '1.jpg'), 'x', 'utf8');
    const set = handlers.get('fileSearch:folders:set')!;
    await set({}, { folders: [{ id: 'fsf_1', path: engineDir, name: 'Э06АТ0889', addedAt: 1 }] });

    const search = handlers.get('fileSearch:searchFolders')!;
    const r = (await search({}, { query: 'Э06АТ0889' })) as {
      ok: boolean;
      result: { matches: { name: string; matchedBy: string }[] };
    };
    expect(r.ok).toBe(true);
    expect(r.result.matches.some((m) => m.name === 'Э06АТ0889' && m.matchedBy === 'folder')).toBe(true);
  });

  it('картинка выдаётся по id, а путь на диск в renderer не уходит', async () => {
    const engineDir = join(dir, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeFileSync(join(engineDir, '1.jpg'), 'x', 'utf8');
    const set = handlers.get('fileSearch:folders:set')!;
    await set({}, { folders: [{ id: 'fsf_1', path: engineDir, name: 'Э06АТ0889', addedAt: 1 }] });

    const search = handlers.get('fileSearch:searchFolders')!;
    const res = (await search({}, { query: 'Э06АТ0889' })) as {
      ok: boolean;
      result: { images: { id: string }[] };
    };
    const image = res.result.images[0];
    expect(image?.id).toBeTruthy();
    // В ответе нет пути на диск — renderer знает только id.
    expect(JSON.stringify(res)).not.toContain(engineDir);
  });

  it('чужой id не печатается: печать идёт только по выданным main', async () => {
    const print = handlers.get('fileSearch:printImages')!;
    const r = (await print({}, { ids: ['fsimg_чужой'] })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Не выбрано');
  });

  it('превью неизвестного id честно отказывает', async () => {
    const preview = handlers.get('fileSearch:imagePreview')!;
    const r = (await preview({}, { id: 'fsimg_чужой' })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('не найдена');
  });
});
