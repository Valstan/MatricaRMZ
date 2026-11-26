import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => unknown>();
let pickedPaths: string[] = [];
/** Что ушло в буфер обмена (проверяем «скопировать путь»). */
const writtenText: string[] = [];

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: any[]) => unknown) => void handlers.set(ch, fn) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  app: { getPath: (name: string) => join(dir, name) },
  shell: { openPath: async () => '' },
  clipboard: { writeText: (text: string) => writtenText.push(text) },
  dialog: {
    showOpenDialog: async () => ({ canceled: pickedPaths.length === 0, filePaths: pickedPaths }),
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
  },
}));

import { registerFileSearchIpc } from './fileSearch.js';

const here = dirname(fileURLToPath(import.meta.url));

let dir = '';
let sqlite: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrica-file-search-ipc-'));
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE sync_state (key text PRIMARY KEY NOT NULL, value text, updated_at integer NOT NULL)`);
  createEngineSchema(sqlite);
  registerFileSearchIpc(makeCtx('user-1'));
});

/** Минимум схемы двигателей — для канала подсказок по номеру. */
function createEngineSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE entity_types (id text PRIMARY KEY NOT NULL, code text NOT NULL, name text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE entities (id text PRIMARY KEY NOT NULL, type_id text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_defs (id text PRIMARY KEY NOT NULL, entity_type_id text NOT NULL,
      code text NOT NULL, name text NOT NULL, data_type text NOT NULL, is_required integer NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0, meta_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
    CREATE TABLE attribute_values (id text PRIMARY KEY NOT NULL, entity_id text NOT NULL,
      attribute_def_id text NOT NULL, value_json text,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      last_server_seq integer, deleted_at integer, sync_status text NOT NULL DEFAULT 'synced');
  `);
  db.exec(readFileSync(join(here, '../../../../drizzle/0032_erp_engine_cards_replica.sql'), 'utf8'));
  db.exec(readFileSync(join(here, '../../../../drizzle/0037_engine_rmz_numbers_replica.sql'), 'utf8'));
  db.exec(`
    INSERT INTO entity_types (id, code, name, created_at, updated_at) VALUES ('t-engine', 'engine', 'Двигатель', 1, 1);
    INSERT INTO attribute_defs (id, entity_type_id, code, name, data_type, sort_order, created_at, updated_at)
      VALUES ('d-number', 't-engine', 'engine_number', 'Номер двигателя', 'text', 10, 1, 1);
  `);
}

function addEngine(db: Database.Database, id: string, engineNumber: string): void {
  db.exec(`INSERT INTO entities (id, type_id, created_at, updated_at) VALUES ('${id}', 't-engine', 1, 1)`);
  db.prepare(
    `INSERT INTO attribute_values (id, entity_id, attribute_def_id, value_json, created_at, updated_at)
     VALUES (?,?,?,?,1,1)`,
  ).run(`v-${id}`, id, 'd-number', JSON.stringify(engineNumber));
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  sqlite.close();
  handlers.clear();
  pickedPaths = [];
  writtenText.length = 0;
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

describe('режим «Фото двигателя» и подсказки по номеру (промт КАРМАНА #155)', () => {
  it('область folder: находка — папка со всеми фотографиями, отдельного файла нет', async () => {
    const engineDir = join(dir, 'Э06АТ0889_41-26');
    mkdirSync(engineDir);
    writeFileSync(join(engineDir, '1.jpg'), 'x', 'utf8');
    writeFileSync(join(engineDir, '2.jpg'), 'x', 'utf8');
    writeFileSync(join(dir, 'Э06АТ0889_41-26.txt'), 'данные', 'utf8');
    const set = handlers.get('fileSearch:folders:set')!;
    await set({}, { folders: [{ id: 'fsf_1', path: dir, name: 'фото', addedAt: 1 }] });

    const search = handlers.get('fileSearch:searchFolders')!;
    const res = (await search({}, { query: 'Э06АТ0889', scope: 'folder' })) as {
      ok: boolean;
      result: { matches: { name: string; matchedBy: string; imageCount: number }[] };
    };
    expect(res.ok).toBe(true);
    expect(res.result.matches).toHaveLength(1);
    expect(res.result.matches[0]?.matchedBy).toBe('folder');
    expect(res.result.matches[0]?.imageCount).toBe(2);
  });

  it('без области поведение прежнее: файл — отдельная находка', async () => {
    const engineDir = join(dir, 'Э06АТ0889');
    mkdirSync(engineDir);
    writeFileSync(join(engineDir, '1.jpg'), 'x', 'utf8');
    writeFileSync(join(dir, 'Э06АТ0889.txt'), 'данные', 'utf8');
    const set = handlers.get('fileSearch:folders:set')!;
    await set({}, { folders: [{ id: 'fsf_1', path: dir, name: 'фото', addedAt: 1 }] });

    const search = handlers.get('fileSearch:searchFolders')!;
    const res = (await search({}, { query: 'Э06АТ0889' })) as {
      ok: boolean;
      result: { matches: { matchedBy: string }[] };
    };
    expect(res.result.matches.some((m) => m.matchedBy === 'file')).toBe(true);
  });

  it('подсказки по неполному номеру дают полный номер двигателя', async () => {
    addEngine(sqlite, 'e-1', 'Э06АТ0889');

    const suggest = handlers.get('fileSearch:engineNumberSuggestions')!;
    const res = (await suggest({}, { q: '0889' })) as {
      ok: boolean;
      suggestions: { id: string; engineNumber: string }[];
    };
    expect(res.ok).toBe(true);
    expect(res.suggestions.map((s) => s.engineNumber)).toEqual(['Э06АТ0889']);
  });

  it('слово подсказок не даёт', async () => {
    addEngine(sqlite, 'e-1', 'Э06АТ0889');

    const suggest = handlers.get('fileSearch:engineNumberSuggestions')!;
    const res = (await suggest({}, { q: 'акт' })) as { ok: boolean; suggestions: unknown[] };
    expect(res.suggestions).toEqual([]);
  });
});

describe('действия над отмеченными файлами (промт КАРМАНА #158)', () => {
  it('чужие id не проходят ни в одну дверь действий', async () => {
    const doors = [
      'fileSearch:assemblePdf',
      'fileSearch:printWizard',
      'fileSearch:revealFolder',
      'fileSearch:stageForShare',
      'fileSearch:copyPaths',
    ];
    for (const channel of doors) {
      const handler = handlers.get(channel);
      expect(handler, `нет двери ${channel}`).toBeTruthy();
      const r = (await handler!({}, { ids: ['fsimg_чужой'] })) as { ok: boolean; error?: string };
      expect(r.ok, `${channel} принял чужой id`).toBe(false);
      expect(r.error).toContain('Не выбрано');
    }
  });

  it('копии во временную папку не берут файлы, которых main не выдавал', async () => {
    const stage = handlers.get('fileSearch:stageForShare')!;
    const r = (await stage({}, { ids: ['fsimg_чужой'] })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
  });

  it('убрать можно только свою временную папку', async () => {
    const cleanup = handlers.get('fileSearch:cleanupTempFolder')!;
    const outside = (await cleanup({}, { folder: join(dir, 'чужая-папка') })) as { ok: boolean; removed: boolean };
    expect(outside.ok).toBe(true);
    // Папка вне нашего корня — не трогаем (иначе вызов снёс бы оператору что-то не то).
    expect(outside.removed).toBe(false);
  });

  it('PDF из чужих id не собирается', async () => {
    const pdf = handlers.get('fileSearch:assemblePdf')!;
    const r = (await pdf({}, { ids: ['fsimg_чужой'] })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
  });
});