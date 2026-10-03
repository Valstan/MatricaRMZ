import { describe, expect, it } from 'vitest';

import { erpEngineCardRowSchema } from './dto.js';
import { SyncTableRegistry } from './registry.js';
import { SyncTableName } from './tables.js';

// Реестр — единственный маппинг DB↔DTO: расхождение полей реестра и zod-схемы
// роняет строки из pull молча (схема строже) или теряет колонки (реестр уже).
describe('ErpEngineCards: реестр покрывает ровно схему DTO', () => {
  it('dto-имена полей реестра = ключи схемы', () => {
    const entry = SyncTableRegistry.get(SyncTableName.ErpEngineCards);
    expect(entry).toBeDefined();
    const registryDto = new Set(entry!.fields.map((f) => f.dto));
    const schemaKeys = new Set(Object.keys(erpEngineCardRowSchema.shape));
    expect(registryDto).toEqual(schemaKeys);
  });

  it('мягкая схема принимает серверную строку целиком', () => {
    const row: Record<string, unknown> = {
      id: '11111111-1111-4111-8111-111111111111',
      created_at: 1000,
      updated_at: 2000,
      engine_number: 'A-1',
      status_repaired: true,
    };
    expect(erpEngineCardRowSchema.safeParse(row).success).toBe(true);
  });
});
