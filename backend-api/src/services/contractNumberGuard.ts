// Гейт уникальности внутреннего номера договора («20/ГОЗ-25»). Смысл номера и
// почему он обязан быть уникальным — shared/src/domain/contractInternalNumber.ts.
// Leaf-модуль по образцу engineNumberGuard: импортируется гейтом записи
// (adminMasterdataService) и не тянет за собой сервисы.
import {
  CONTRACT_ENTITY_TYPE_CODE,
  CONTRACT_INTERNAL_NUMBER_CODE,
  contractInternalNumberKey,
  type ContractInternalNumberDuplicate,
} from '@matricarmz/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';

function parseTextAttr(valueJson: string | null | undefined): string {
  if (valueJson == null) return '';
  try {
    const parsed = JSON.parse(String(valueJson));
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return String(valueJson).trim();
  }
}

/**
 * Живой договор, уже занявший этот внутренний номер, — или null.
 *
 * Сравнение по нормализованному ключу, а не по строке: «20/ГОЗ-25» и «20 гоз 25»
 * должны считаться одним номером. Удалённые записи (`deleted_at`) не мешают:
 * освободить номер, удалив договор, — законный сценарий.
 */
export async function findContractInternalNumberDuplicate(
  internalNumber: unknown,
  excludeEntityId?: string,
): Promise<ContractInternalNumberDuplicate | null> {
  const key = contractInternalNumberKey(internalNumber);
  if (!key) return null;

  const rows = await db
    .select({
      entityId: attributeValues.entityId,
      code: attributeDefs.code,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .innerJoin(attributeDefs, eq(attributeDefs.id, attributeValues.attributeDefId))
    .innerJoin(entities, eq(entities.id, attributeValues.entityId))
    .innerJoin(entityTypes, eq(entityTypes.id, entities.typeId))
    .where(
      and(
        eq(entityTypes.code, CONTRACT_ENTITY_TYPE_CODE),
        // Казённый номер дочитываем той же выборкой: он нужен только для текста
        // ошибки, но без него владелец не поймёт, тот же это договор или другой.
        inArray(attributeDefs.code, [CONTRACT_INTERNAL_NUMBER_CODE, 'number']),
        isNull(attributeDefs.deletedAt),
        isNull(attributeValues.deletedAt),
        isNull(entities.deletedAt),
        isNull(entityTypes.deletedAt),
      ),
    )
    .limit(200_000);

  const byContract = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const id = String(r.entityId);
    if (excludeEntityId && id === excludeEntityId) continue;
    const value = parseTextAttr(r.valueJson);
    if (!value) continue;
    const entry = byContract.get(id) ?? {};
    entry[String(r.code)] = value;
    byContract.set(id, entry);
  }

  for (const [id, entry] of byContract) {
    const number = entry[CONTRACT_INTERNAL_NUMBER_CODE] ?? '';
    if (!number || contractInternalNumberKey(number) !== key) continue;
    return { id, internalNumber: number, contractNumber: entry['number'] ?? '' };
  }
  return null;
}
