import { describe, expect, it } from 'vitest';

import { signatureDefaultRowSchema } from './dto.js';
import { SyncTableRegistry } from './registry.js';
import { SyncTableName } from './tables.js';

// Умолчания подписей (PR-5): реестр — единственный маппинг DB↔DTO.
// Расхождение полей реестра и zod-схемы роняет строки из pull молча
// (схема строже) или теряет колонки (реестр уже).
describe('signature-defaults: реестр покрывает ровно схему DTO', () => {
  it('dto-имена полей реестра = ключи схемы', () => {
    const entry = SyncTableRegistry.get(SyncTableName.SignatureDefaults);
    expect(entry).toBeDefined();
    const registryDto = new Set(entry!.fields.map((f) => f.dto));
    const schemaKeys = new Set(Object.keys(signatureDefaultRowSchema.shape));
    expect(registryDto).toEqual(schemaKeys);
  });

  it('мягкая схема принимает серверную строку целиком', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(
      signatureDefaultRowSchema.safeParse({ id, created_at: 1, updated_at: 2, field_key: 'defect_signed_by', employee_id: id }).success,
    ).toBe(true);
    // Пустое умолчание (отмена кнопкой) — тоже валидная строка.
    expect(
      signatureDefaultRowSchema.safeParse({ id, created_at: 1, updated_at: 2, field_key: 'defect_signed_by' }).success,
    ).toBe(true);
  });

  it('битая строка (пустой ключ, не-uuid сотрудник) не проходит', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(signatureDefaultRowSchema.safeParse({ id, created_at: 1, updated_at: 2, field_key: '' }).success).toBe(false);
    expect(
      signatureDefaultRowSchema.safeParse({ id, created_at: 1, updated_at: 2, field_key: 'defect_signed_by', employee_id: 'x' }).success,
    ).toBe(false);
  });
});
