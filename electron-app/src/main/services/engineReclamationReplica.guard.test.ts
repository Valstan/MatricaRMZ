import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { erpEngineReclamations } from '../database/schema.js';

// Реплика рекламаций живёт в двух местах: безусловный путь миграции десктопа
// (electron-app/src/main/database/migrate.ts) и его async-порт для Android
// (android-app/src/db/migrate.ts). Сторож паритета схем (drizzleChain.test.ts)
// сравнивает sqlite_master буквально — значит и текст CREATE TABLE должен совпадать.

const ELECTRON_MIGRATE = fileURLToPath(new URL('../database/migrate.ts', import.meta.url));
const ANDROID_MIGRATE = fileURLToPath(new URL('../../../../android-app/src/db/migrate.ts', import.meta.url));

function createBlock(source: string, table: string): string {
  const start = source.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) return '';
  const end = source.indexOf(';', start);
  return source.slice(start, end + 1);
}

describe('реплика рекламаций двигателя', () => {
  const electron = readFileSync(ELECTRON_MIGRATE, 'utf8');
  const android = readFileSync(ANDROID_MIGRATE, 'utf8');

  it('electron и android создают таблицу одинаково (текст CREATE — буквально)', () => {
    const e = createBlock(electron, 'erp_engine_reclamations');
    const a = createBlock(android, 'erp_engine_reclamations');
    expect(e, 'в electron нет CREATE TABLE erp_engine_reclamations').not.toBe('');
    expect(a, 'в android нет CREATE TABLE erp_engine_reclamations').not.toBe('');
    expect(a).toBe(e);
  });

  it('в реплике есть индекс по двигателю', () => {
    expect(electron).toContain('erp_engine_reclamations_engine_idx');
    expect(android).toContain('erp_engine_reclamations_engine_idx');
  });

  it('drizzle-схема клиента экспортирует таблицу', () => {
    expect(getTableName(erpEngineReclamations)).toBe('erp_engine_reclamations');
  });

  it('реплика рекламаций — server-write: клиент в таблицу не пишет', () => {
    // Очередь заездов ведёт серверная дверь; клиент только читает реплику (pull-only).
    const ownership = readFileSync(
      join(fileURLToPath(new URL('../../../../shared/src/domain/ledgerAuthz.ts', import.meta.url))),
      'utf8',
    );
    expect(ownership).toContain("[SyncTableName.ErpEngineReclamations]: { owner: 'server'");
  });

  it('таблица есть в картах pull (иначе строки не приедут и не попадут в снапшот)', () => {
    const pgMap = readFileSync(
      join(fileURLToPath(new URL('../../../../backend-api/src/services/sync/pgSyncTables.ts', import.meta.url))),
      'utf8',
    );
    const pull = readFileSync(
      join(fileURLToPath(new URL('../../../../backend-api/src/services/sync/pullChangesSince.ts', import.meta.url))),
      'utf8',
    );
    const apply = readFileSync(
      join(fileURLToPath(new URL('../../../../backend-api/src/services/sync/applyPushBatch.ts', import.meta.url))),
      'utf8',
    );
    expect(pgMap).toContain('ErpEngineReclamations');
    expect(pull).toContain('ErpEngineReclamations');
    expect(apply).toContain('SyncTableName.ErpEngineReclamations');
  });
});
