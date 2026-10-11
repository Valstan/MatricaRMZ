import { describe, expect, it } from 'vitest';

import {
  ppeCardNormRowSchema,
  ppeIssueCardRowSchema,
  ppeIssueEntryRowSchema,
  ppeNormLineRowSchema,
  ppeNormSetRowSchema,
} from './dto.js';
import { SyncTableRegistry } from './registry.js';
import { SyncTableName } from './tables.js';

// Кладовщик (СИЗ), MVP, PR-1: реестр — единственный маппинг DB↔DTO.
// Расхождение полей реестра и zod-схемы роняет строки из pull молча
// (схема строже) или теряет колонки (реестр уже).
const CASES = [
  { table: SyncTableName.PpeNormSets, schema: ppeNormSetRowSchema },
  { table: SyncTableName.PpeNormLines, schema: ppeNormLineRowSchema },
  { table: SyncTableName.PpeIssueCards, schema: ppeIssueCardRowSchema },
  { table: SyncTableName.PpeCardNorms, schema: ppeCardNormRowSchema },
  { table: SyncTableName.PpeIssueEntries, schema: ppeIssueEntryRowSchema },
] as const;

describe('PPE: реестр покрывает ровно схему DTO', () => {
  for (const { table, schema } of CASES) {
    it(`${table}: dto-имена полей реестра = ключи схемы`, () => {
      const entry = SyncTableRegistry.get(table);
      expect(entry).toBeDefined();
      const registryDto = new Set(entry!.fields.map((f) => f.dto));
      const schemaKeys = new Set(Object.keys(schema.shape));
      expect(registryDto).toEqual(schemaKeys);
    });
  }

  it('мягкие схемы принимают серверные строки целиком', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(ppeNormSetRowSchema.safeParse({ id, created_at: 1, updated_at: 2, name: 'Слесарь', valid_from: 3 }).success).toBe(true);
    expect(
      ppeNormLineRowSchema.safeParse({ id, created_at: 1, updated_at: 2, norm_set_id: id, nomenclature_id: id, qty: 2, wear_months: 12 }).success,
    ).toBe(true);
    expect(ppeIssueCardRowSchema.safeParse({ id, created_at: 1, updated_at: 2, employee_id: id, opened_at: 3 }).success).toBe(true);
    expect(ppeCardNormRowSchema.safeParse({ id, created_at: 1, updated_at: 2, card_id: id, norm_set_id: id, assigned_at: 3 }).success).toBe(true);
    expect(
      ppeIssueEntryRowSchema.safeParse({ id, created_at: 1, updated_at: 2, card_id: id, nomenclature_id: id, qty: 1, issued_at: 3, document_id: id }).success,
    ).toBe(true);
  });

  it('битая строка (пустое имя нормы, не-uuid ссылка) не проходит', () => {
    expect(ppeNormSetRowSchema.safeParse({ id: 'x', created_at: 1, updated_at: 2, name: '', valid_from: 3 }).success).toBe(false);
    expect(
      ppeIssueEntryRowSchema.safeParse({ id: 'x', created_at: 1, updated_at: 2, card_id: 'x', nomenclature_id: 'x', qty: 1, issued_at: 3, document_id: 'x' })
        .success,
    ).toBe(false);
  });
});
