import { describe, expect, it } from 'vitest';

import {
  ppeAbsenceRowSchema,
  ppeCardNormRowSchema,
  ppeCollectiveLineRowSchema,
  ppeCollectiveRowSchema,
  ppeGroupMemberRowSchema,
  ppeGroupNormRowSchema,
  ppeGroupRowSchema,
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
  // Фаза 2, PR-1.
  { table: SyncTableName.PpeAbsences, schema: ppeAbsenceRowSchema },
  { table: SyncTableName.PpeGroups, schema: ppeGroupRowSchema },
  { table: SyncTableName.PpeGroupMembers, schema: ppeGroupMemberRowSchema },
  { table: SyncTableName.PpeGroupNorms, schema: ppeGroupNormRowSchema },
  { table: SyncTableName.PpeCollectives, schema: ppeCollectiveRowSchema },
  { table: SyncTableName.PpeCollectiveLines, schema: ppeCollectiveLineRowSchema },
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
    // Фаза 2: условия норм и NULL-документ доввода истории проходят.
    expect(
      ppeNormSetRowSchema.safeParse({ id, created_at: 1, updated_at: 2, name: 'Зима', valid_from: 3, gender: 'M', season: 'winter', is_duty: false }).success,
    ).toBe(true);
    expect(
      ppeIssueEntryRowSchema.safeParse({ id, created_at: 1, updated_at: 2, card_id: id, nomenclature_id: id, qty: 1, issued_at: 3, document_id: null }).success,
    ).toBe(true);
    expect(
      ppeAbsenceRowSchema.safeParse({ id, created_at: 1, updated_at: 2, employee_id: id, from_ms: 3, to_ms: 4, kind: 'vacation' }).success,
    ).toBe(true);
    expect(ppeGroupRowSchema.safeParse({ id, created_at: 1, updated_at: 2, name: 'Зимники' }).success).toBe(true);
    expect(
      ppeGroupMemberRowSchema.safeParse({ id, created_at: 1, updated_at: 2, group_id: id, employee_id: id }).success,
    ).toBe(true);
    expect(
      ppeGroupNormRowSchema.safeParse({ id, created_at: 1, updated_at: 2, group_id: id, norm_set_id: id }).success,
    ).toBe(true);
    expect(
      ppeCollectiveRowSchema.safeParse({ id, created_at: 1, updated_at: 2, department_id: id, warehouse_id: id }).success,
    ).toBe(true);
    expect(
      ppeCollectiveLineRowSchema.safeParse({ id, created_at: 1, updated_at: 2, collective_id: id, employee_id: id, nomenclature_id: id, qty: 1 }).success,
    ).toBe(true);
  });

  it('битая строка (пустое имя нормы, не-uuid ссылка) не проходит', () => {
    expect(ppeNormSetRowSchema.safeParse({ id: 'x', created_at: 1, updated_at: 2, name: '', valid_from: 3 }).success).toBe(false);
    expect(
      ppeIssueEntryRowSchema.safeParse({ id: 'x', created_at: 1, updated_at: 2, card_id: 'x', nomenclature_id: 'x', qty: 1, issued_at: 3, document_id: 'x' })
        .success,
    ).toBe(false);
    // Фаза 2: чужой пол/сезон в норме — не строка контракта.
    expect(
      ppeNormSetRowSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111', created_at: 1, updated_at: 2, name: 'Норма', valid_from: 3, gender: 'X' }).success,
    ).toBe(false);
  });
});
