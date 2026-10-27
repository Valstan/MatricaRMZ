import { describe, expect, it } from 'vitest';

import { erpEngineNumberRowSchema } from './dto.js';
import { SyncTableRegistry } from './registry.js';
import { SyncTableName } from './tables.js';

// Реестр — единственный маппинг DB↔DTO: расхождение полей реестра и zod-схемы
// роняет строки из pull молча (схема строже) или теряет колонки (реестр уже).
describe('ErpEngineNumbers: реестр покрывает ровно схему DTO', () => {
  it('dto-имена полей реестра = ключи схемы', () => {
    const entry = SyncTableRegistry.get(SyncTableName.ErpEngineNumbers);
    expect(entry).toBeDefined();
    const registryDto = new Set(entry!.fields.map((f) => f.dto));
    const schemaKeys = new Set(Object.keys(erpEngineNumberRowSchema.shape));
    expect(registryDto).toEqual(schemaKeys);
  });

  it('схема принимает серверную строку целиком', () => {
    const row: Record<string, unknown> = {
      id: '11111111-1111-4111-8111-111111111111',
      created_at: 1000,
      updated_at: 2000,
      last_server_seq: 77,
      seq: 451,
      status: 'active',
      created_by: 'oper',
    };
    expect(erpEngineNumberRowSchema.safeParse(row).success).toBe(true);
  });

  it('номер без seq или с чужим состоянием — не номер РМЗ', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      created_at: 1000,
      updated_at: 2000,
      status: 'active',
    };
    expect(erpEngineNumberRowSchema.safeParse(base).success).toBe(false);
    expect(erpEngineNumberRowSchema.safeParse({ ...base, seq: 0 }).success).toBe(false);
    expect(erpEngineNumberRowSchema.safeParse({ ...base, seq: 451, status: 'unknown' }).success).toBe(false);
  });
});
