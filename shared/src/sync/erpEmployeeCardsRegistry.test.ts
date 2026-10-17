import { describe, expect, it } from 'vitest';

import { erpEmployeeCardRowSchema } from './dto.js';
import { SyncTableRegistry } from './registry.js';
import { SyncTableName } from './tables.js';

// Сотрудники СИЗ (PR-6): реестр — единственный маппинг DB↔DTO. Расхождение полей
// реестра и zod-схемы роняет строки из pull молча (схема строже) или теряет колонки
// (реестр уже). attrs_json в реестре быть НЕ должно: это PII (даты рождения/приёма),
// в зеркало едут только ФИО/табельный/должность/активность.
describe('erp_employee_cards: реестр покрывает ровно схему DTO', () => {
  it('dto-имена полей реестра = ключи схемы', () => {
    const entry = SyncTableRegistry.get(SyncTableName.ErpEmployeeCards);
    expect(entry).toBeDefined();
    const registryDto = new Set(entry!.fields.map((f) => f.dto));
    const schemaKeys = new Set(Object.keys(erpEmployeeCardRowSchema.shape));
    expect(registryDto).toEqual(schemaKeys);
  });

  it('attrs_json срезается даже при полной строке двери', () => {
    const entry = SyncTableRegistry.get(SyncTableName.ErpEmployeeCards);
    expect(entry!.fields.map((f) => f.db)).not.toContain('attrsJson');
    const row = SyncTableRegistry.toSyncRow(SyncTableName.ErpEmployeeCards, {
      id: '11111111-1111-4111-8111-111111111111',
      fullName: 'Иванов Иван Иванович',
      personnelNo: '0042',
      roleCode: 'slesar',
      attrsJson: '{"birth_date":"1980-01-01","hire_date":"2010-03-01"}',
      isActive: true,
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
      syncStatus: 'synced',
    });
    expect(Object.keys(row)).not.toContain('attrs_json');
    expect(row).toMatchObject({ full_name: 'Иванов Иван Иванович', personnel_no: '0042', role_code: 'slesar' });
  });

  it('мягкая схема принимает серверную строку целиком', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(
      erpEmployeeCardRowSchema.safeParse({ id, created_at: 1, updated_at: 2, full_name: 'Иванов Иван Иванович' }).success,
    ).toBe(true);
    // ФИО — единственное обязательное: строку без табельного/должности схема принимает.
    expect(
      erpEmployeeCardRowSchema.safeParse({
        id,
        created_at: 1,
        updated_at: 2,
        full_name: 'Иванов Иван Иванович',
        personnel_no: null,
        role_code: null,
        is_active: true,
      }).success,
    ).toBe(true);
  });

  it('битая строка (пустое ФИО) не проходит', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(erpEmployeeCardRowSchema.safeParse({ id, created_at: 1, updated_at: 2, full_name: '' }).success).toBe(false);
  });
});
