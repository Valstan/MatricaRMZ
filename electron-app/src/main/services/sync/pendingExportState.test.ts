import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readPendingExportState, markExportFileKept, readKeptExportFiles, resetPendingExportCache, unmarkExportFileKept } from './pendingExportState.js';

let dir = '';

function writeExport(name: string, body: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(body), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrica-pending-export-'));
  resetPendingExportCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetPendingExportCache();
});

describe('выгрузки, которые реплей не смог вернуть, не чистятся', () => {
  it('отметка «непригоден» записывается и снимается', async () => {
    expect(await readKeptExportFiles(dir)).toEqual([]);
    await markExportFileKept(dir, 'pending-export-a.json');
    await markExportFileKept(dir, 'pending-export-b.json');
    expect(await readKeptExportFiles(dir)).toEqual(['pending-export-a.json', 'pending-export-b.json']);
    await unmarkExportFileKept(dir, 'pending-export-a.json');
    expect(await readKeptExportFiles(dir)).toEqual(['pending-export-b.json']);
  });

  it('повторная отметка не дублирует файл', async () => {
    await markExportFileKept(dir, 'pending-export-a.json');
    await markExportFileKept(dir, 'pending-export-a.json');
    expect(await readKeptExportFiles(dir)).toEqual(['pending-export-a.json']);
  });

  it('в список не попадает чужое имя', async () => {
    await markExportFileKept(dir, 'какой-то файл.txt');
    expect(await readKeptExportFiles(dir)).toEqual([]);
  });
});

describe('остатки выгрузок на машине', () => {
  it('пустая папка — пустая сводка (неотправленных данных вне базы нет)', async () => {
    const state = await readPendingExportState(dir);
    expect(state.files).toEqual([]);
    expect(state.rows).toBe(0);
    expect(state.byTable).toEqual([]);
  });

  it('несуществующая папка не роняет чтение', async () => {
    const state = await readPendingExportState(join(dir, 'нет-такой'));
    expect(state.files).toEqual([]);
  });

  it('считает строки и раскладывает их по таблицам', async () => {
    writeExport('pending-export-2026-11-23T10-00-00-000Z.json', {
      version: 1,
      exportedAt: 1_700_000_000_000,
      reason: 'schema_mismatch',
      packs: [
        { table: 'entities', rows: [{ id: 'a' }, { id: 'b' }] },
        { table: 'attribute_values', rows: [{ id: 'c' }] },
      ],
    });
    const state = await readPendingExportState(dir);
    expect(state.files).toHaveLength(1);
    expect(state.rows).toBe(3);
    expect(state.byTable).toEqual([
      { table: 'entities', n: 2 },
      { table: 'attribute_values', n: 1 },
    ]);
    expect(state.reason).toBe('schema_mismatch');
    expect(state.oldestExportedAt).toBe(1_700_000_000_000);
  });

  it('причина едет в сам файл — по остатку видно, что вызвало пересборку базы', async () => {
    writeExport('pending-export-2026-11-23T10-00-00-000Z.json', {
      version: 1,
      exportedAt: 1_700_000_000_000,
      reason: 'full_pull',
      packs: [{ table: 'entities', rows: [{ id: 'a' }] }],
    });
    const state = await readPendingExportState(dir);
    expect(state.reason).toBe('full_pull');
    expect(state.files[0]?.reason).toBe('full_pull');
  });

  it('чужие файлы в папке не считаются выгрузками', async () => {
    writeFileSync(join(dir, 'matricarmz.sqlite'), 'binary', 'utf8');
    writeFileSync(join(dir, 'pending-export-note.txt'), 'не выгрузка', 'utf8');
    const state = await readPendingExportState(dir);
    expect(state.files).toEqual([]);
  });

  it('нечитаемый файл не прячется: он остаётся в списке (данные могут быть внутри)', async () => {
    writeFileSync(join(dir, 'pending-export-2026-11-23T10-00-00-000Z.json'), '{ битый json', 'utf8');
    const state = await readPendingExportState(dir);
    expect(state.files).toHaveLength(1);
    expect(state.rows).toBe(0);
  });

  it('несколько файлов суммируются, а причина берётся у самой свежей', async () => {
    writeExport('pending-export-2026-11-23T10-00-00-000Z.json', {
      exportedAt: 1_700_000_000_000,
      reason: 'schema_mismatch',
      packs: [{ table: 'entities', rows: [{ id: 'a' }] }],
    });
    writeExport('pending-export-2026-11-23T12-00-00-000Z.json', {
      exportedAt: 1_700_007_200_000,
      reason: 'full_pull',
      packs: [{ table: 'entities', rows: [{ id: 'b' }, { id: 'c' }] }],
    });
    const state = await readPendingExportState(dir);
    expect(state.files).toHaveLength(2);
    expect(state.rows).toBe(3);
    expect(state.byTable).toEqual([{ table: 'entities', n: 3 }]);
    expect(state.oldestExportedAt).toBe(1_700_000_000_000);
    expect(state.reason).toBe('full_pull');
  });
});
