import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureClientSchemaParity } from './migrate.js';

// Реестр номеров РМЗ (план engine-rmz-numbers-2026-10): server-write / pull-only.
// Таблица новая, поэтому обе половины создают её сами — запись формы (0037) и живой
// путь (parity). Тест держит их вместе: колонка, которой нет в parity, уронит
// sync-аппсерт на «no such column» уже на клиенте оператора.
const here = dirname(fileURLToPath(import.meta.url));

function tableColumns(sqlite: Database.Database, table: string): string[] {
  return (
    sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
}

const REPLICA_COLUMNS = [
  'id',
  'seq',
  'status',
  'created_by',
  'card_deleted_at',
  'card_deleted_by',
  'delete_reason',
  'snapshot_json',
  'created_at',
  'updated_at',
  'last_server_seq',
  'deleted_at',
  'sync_status',
];

describe('erp_engine_numbers replica (0037 + parity)', () => {
  it('запись формы: таблица, колонки и уникальность seq', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(here, '../../../drizzle/0037_engine_rmz_numbers_replica.sql'), 'utf8'));
    expect(tableColumns(sqlite, 'erp_engine_numbers')).toEqual(REPLICA_COLUMNS);
    const insert = sqlite.prepare(
      `INSERT INTO erp_engine_numbers (id, seq, created_at, updated_at) VALUES (?, ?, 1, 1)`,
    );
    insert.run('11111111-1111-4111-8111-111111111111', 451);
    // Один номер — одна карточка: второй раз тот же seq не вставится.
    expect(() => insert.run('22222222-2222-4222-8222-222222222222', 451)).toThrow();
    sqlite.close();
  });

  it('живой путь: parity создаёт таблицу на пустой БД и идемпотентен', () => {
    const sqlite = new Database(':memory:');
    ensureClientSchemaParity(sqlite);
    expect(tableColumns(sqlite, 'erp_engine_numbers')).toEqual(REPLICA_COLUMNS);
    // Повторный прогон не бросает: доводка встречается у всех клиентов на каждом старте.
    expect(() => ensureClientSchemaParity(sqlite)).not.toThrow();
    sqlite.close();
  });
});
