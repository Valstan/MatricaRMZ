import { and, eq, isNull } from 'drizzle-orm';

import { SCRAP_CRITERION_ATTR_CODE, isEavFlagSet, type PartMetadata } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes, erpNomenclature } from '../database/schema.js';
import { applyScrapCriterionToMetadata, mergeScrapCriterionIntoMetadata } from './partScrapCriterionMeta.js';

export { applyScrapCriterionToMetadata, mergeScrapCriterionIntoMetadata };

/**
 * Признак «деталь уводит двигатель в утиль» на стороне сервера.
 *
 * Метка живёт EAV-атрибутом детали (`scrap_criterion`): её пишет клиент через
 * общий канал атрибутов, и она же едет в синке на сервер. Карточка детали на
 * сервере читает `directory_parts.metadata_json` — поэтому сервер подмешивает
 * значение EAV в блоб, когда отдаёт карточку, и не даёт старому значению из
 * блоба воскреснуть при записи.
 *
 * Источник правды — EAV: блоб копия для показа, а не второй источник.
 */

/** Значение метки по детали: `null` — метка не задана. */
export async function readPartScrapCriterion(partId: string): Promise<boolean | null> {
  const id = String(partId ?? '').trim();
  if (!id) return null;
  try {
    const typeRows = await db
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(and(eq(entityTypes.code, 'part'), isNull(entityTypes.deletedAt)))
      .limit(1);
    const partTypeId = typeRows[0]?.id;
    if (!partTypeId) return null;
    const defRows = await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(
        and(
          eq(attributeDefs.entityTypeId, partTypeId),
          eq(attributeDefs.code, SCRAP_CRITERION_ATTR_CODE),
          isNull(attributeDefs.deletedAt),
        ),
      )
      .limit(1);
    const defId = defRows[0]?.id;
    if (!defId) return null;

    // id детали справочника обычно совпадает с id номенклатурной позиции
    // (часть → номенклатура, Variant A), но на всякий случай ищем по зеркалу.
    const entityRows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, id), isNull(entities.deletedAt)))
      .limit(1);
    let entityId = entityRows[0]?.id ?? null;
    if (!entityId) {
      const mirrorRows = await db
        .select({ refId: erpNomenclature.directoryRefId })
        .from(erpNomenclature)
        .where(and(eq(erpNomenclature.id, id), isNull(erpNomenclature.deletedAt)))
        .limit(1);
      const refId = String(mirrorRows[0]?.refId ?? '').trim();
      if (refId) entityId = refId;
    }
    if (!entityId) return null;

    const valueRows = await db
      .select({ valueJson: attributeValues.valueJson })
      .from(attributeValues)
      .where(
        and(
          eq(attributeValues.entityId, entityId),
          eq(attributeValues.attributeDefId, defId),
          isNull(attributeValues.deletedAt),
        ),
      )
      .limit(1);
    const raw = valueRows[0]?.valueJson;
    if (raw == null) return null;
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (!text) return null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return isEavFlagSet(parsed);
  } catch {
    return null;
  }
}

/** Приводит значение метки в блобе к EAV (запись карточки детали). */
export async function normalizeScrapCriterionInMetadata(
  metadata: PartMetadata | null,
  partId: string,
): Promise<PartMetadata | null> {
  if (!metadata) return metadata;
  const enabled = await readPartScrapCriterion(partId);
  return applyScrapCriterionToMetadata(metadata, enabled);
}
