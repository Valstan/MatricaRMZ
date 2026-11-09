import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { erpProductionProgramRows, erpProductionPrograms } from '../database/schema.js';

// Реплика ПП живёт в двух местах: безусловный путь миграции десктопа
// (electron-app/src/main/database/migrate.ts) и его async-порт для Android
// (android-app/src/db/migrate.ts). Сторож паритета схем сравнивает sqlite_master
// буквально — значит и текст CREATE TABLE должен совпадать, иначе «свежая БД»
// на планшете и на десктопе разойдутся по сигнатуре таблиц.

const ELECTRON_MIGRATE = fileURLToPath(new URL('../database/migrate.ts', import.meta.url));
const ANDROID_MIGRATE = fileURLToPath(new URL('../../../../android-app/src/db/migrate.ts', import.meta.url));

function createBlock(source: string, table: string): string {
  const start = source.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) return '';
  const end = source.indexOf(';', start);
  return source.slice(start, end + 1);
}

describe('реплика производственной программы', () => {
  const electron = readFileSync(ELECTRON_MIGRATE, 'utf8');
  const android = readFileSync(ANDROID_MIGRATE, 'utf8');

  it('electron и android создают таблицы одинаково (текст CREATE — буквально)', () => {
    for (const table of ['erp_production_programs', 'erp_production_program_rows']) {
      const e = createBlock(electron, table);
      const a = createBlock(android, table);
      expect(e, `в electron нет CREATE TABLE ${table}`).not.toBe('');
      expect(a, `в android нет CREATE TABLE ${table}`).not.toBe('');
      expect(a).toBe(e);
    }
  });

  it('в реплике есть индексы плана и строк', () => {
    expect(electron).toContain('erp_production_programs_period_idx');
    expect(electron).toContain('erp_production_program_rows_program_idx');
    expect(android).toContain('erp_production_programs_period_idx');
    expect(android).toContain('erp_production_program_rows_program_idx');
  });

  it('drizzle-схема клиента экспортирует обе таблицы', () => {
    expect(getTableName(erpProductionPrograms)).toBe('erp_production_programs');
    expect(getTableName(erpProductionProgramRows)).toBe('erp_production_program_rows');
  });

  it('реплика ПП — server-write: клиент в таблицы не пишет', () => {
    // Строки плана ведёт серверная дверь; клиент только читает реплику (pull-only).
    const ownership = readFileSync(
      join(fileURLToPath(new URL('../../../../shared/src/domain/ledgerAuthz.ts', import.meta.url))),
      'utf8',
    );
    expect(ownership).toContain('[SyncTableName.ErpProductionPrograms]: { owner: \'server\'');
    expect(ownership).toContain('[SyncTableName.ErpProductionProgramRows]: { owner: \'server\'');
  });
});
