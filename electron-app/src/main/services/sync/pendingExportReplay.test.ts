import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0', getName: () => 'MatricaRMZ' },
  ipcMain: { handle: () => {} },
}));

import { createBetterSqlite3Executor } from '../../database/sqlExecutor.js';
import { setSyncHost, resetSyncHost } from '../syncHost.js';
import { setSyncSqlExecutor } from '../syncService.js';
import { replayPendingExports } from '../syncService.js';

// Экспорт неотправленных строк (pending-export-*.json) и его реплей обратно в базу.
//
// Контекст (инцидент 24.11.2026): после пересборки локальной БД неотправленные строки
// оператора лежат только в файле экспорта. Реплей возвращает их в базу — но только если
// цикл синка дошёл до конца: pull с ошибкой выпрыгивал из прогона раньше реплея, и
// данные оператора оставались в файле навсегда (см. pendingExportReplay.guard.test.ts).

let dir = '';
let sqlite: Database.Database | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matricarmz-snapshot-'));
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE settings (key text PRIMARY KEY, value text);
    CREATE TABLE entities (
      id text PRIMARY KEY NOT NULL,
      type_id text,
      updated_at integer NOT NULL,
      deleted_at integer,
      sync_status text
    );
  `);
  setSyncSqlExecutor(createBetterSqlite3Executor(sqlite));
  setSyncHost({
    userDataPath: () => dir,
    appendLog: () => {},
    logSync: () => {},
  } as never);
});

afterEach(() => {
  setSyncSqlExecutor(null);
  resetSyncHost();
  sqlite?.close();
  sqlite = null;
});

function writeExport(rows: Array<Record<string, unknown>>, file = 'pending-export-2026-11-24T10-00-00-000.json') {
  writeFileSync(
    join(dir, file),
    JSON.stringify({
      version: 1,
      exportedAt: 1_700_000_000_000,
      appVersion: '3.145.0',
      reason: 'schema_mismatch',
      packs: [{ table: 'entities', rows }],
    }),
    'utf8',
  );
}

describe('реплей неотправленных строк из файла экспорта', () => {
  it('возвращает строку оператора в базу со статусом pending', async () => {
    writeExport([{ id: 'ent-1', type_id: 'type-1', updated_at: 1000 }]);

    await replayPendingExports({} as never);

    const row = sqlite!.prepare(`SELECT id, sync_status FROM entities WHERE id = ?`).get('ent-1') as
      | { id: string; sync_status: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row?.sync_status).toBe('pending');
  });

  it('не воскрешает строку, которая на сервере уже новее (LWW)', async () => {
    sqlite!.exec(`INSERT INTO entities (id, type_id, updated_at, sync_status) VALUES ('ent-1','type-1',5000,'synced')`);
    writeExport([{ id: 'ent-1', type_id: 'type-1', updated_at: 1000 }]);

    await replayPendingExports({} as never);

    const row = sqlite!.prepare(`SELECT sync_status, updated_at FROM entities WHERE id = ?`).get('ent-1') as {
      sync_status: string;
      updated_at: number;
    };
    expect(row.sync_status).toBe('synced');
    expect(row.updated_at).toBe(5000);
  });
});
