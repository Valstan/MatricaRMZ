// Гейт уникальности внутреннего номера договора («20/ГОЗ-25»). Смысл номера и
// почему он обязан быть уникальным — shared/src/domain/contractInternalNumber.ts.
// Leaf-модуль по образцу engineNumberGuard: импортируется гейтом записи
// (adminMasterdataService) и не тянет за собой сервисы.
import {
  contractInternalNumberKey,
  type ContractInternalNumberDuplicate,
} from '@matricarmz/shared';
import { isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { erpContracts } from '../database/schema.js';

/**
 * Живой договор, уже занявший этот внутренний номер, — или null.
 *
 * Сравнение по нормализованному ключу, а не по строке: «20/ГОЗ-25» и «20 гоз 25»
 * должны считаться одним номером. Удалённые записи (`deleted_at`) не мешают:
 * освободить номер, удалив договор, — законный сценарий.
 *
 * B2 (миграция 0084): читает строгую erp_contracts — триггерное зеркало EAV,
 * синхронное с любым путём записи, — вместо скана attribute_values. Нормализация
 * ключа остаётся в TS (contractInternalNumberKey), поэтому сравниваем в памяти:
 * живых договоров десятки, полный проход дешевле дублирования нормализации в SQL.
 */
export async function findContractInternalNumberDuplicate(
  internalNumber: unknown,
  excludeEntityId?: string,
): Promise<ContractInternalNumberDuplicate | null> {
  const key = contractInternalNumberKey(internalNumber);
  if (!key) return null;

  const rows = await db
    .select({ id: erpContracts.id, internalNumber: erpContracts.internalNumber, number: erpContracts.number })
    .from(erpContracts)
    .where(isNull(erpContracts.deletedAt));

  for (const row of rows) {
    const id = String(row.id);
    if (excludeEntityId && id === excludeEntityId) continue;
    const number = String(row.internalNumber ?? '').trim();
    if (!number || contractInternalNumberKey(number) !== key) continue;
    return { id, internalNumber: number, contractNumber: String(row.number ?? '').trim() };
  }
  return null;
}
