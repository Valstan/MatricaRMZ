import { SCRAP_CRITERION_ATTR_CODE, SCRAP_CRITERION_ATTR_NAME, type PartMetadata } from '@matricarmz/shared';

/**
 * Метка «уводит двигатель в утиль» в блобе карточки детали — чистые функции,
 * без базы: блоб — копия для показа, источник правды — EAV-атрибут детали.
 */

/** Подмешивает метку в блоб карточки детали (показ). */
export function mergeScrapCriterionIntoMetadata(
  metadata: PartMetadata | null,
  enabled: boolean | null,
): PartMetadata | null {
  if (!metadata || enabled == null) return metadata;
  const custom = { ...(metadata.custom ?? {}) };
  custom[SCRAP_CRITERION_ATTR_CODE] = enabled;
  const defs = [...(metadata.customDefs ?? [])];
  if (!defs.some((d) => d.code === SCRAP_CRITERION_ATTR_CODE)) {
    defs.push({
      code: SCRAP_CRITERION_ATTR_CODE,
      name: SCRAP_CRITERION_ATTR_NAME,
      dataType: 'boolean',
      sortOrder: 900,
    });
  }
  return { ...metadata, custom, customDefs: defs };
}

/**
 * Приводит значение метки в блобе к EAV (запись): если EAV-значение есть —
 * оно и есть истина, иначе старый хвост из блоба вычищается, чтобы снятая
 * метка не воскресла при следующей записи карточки.
 */
export function applyScrapCriterionToMetadata(metadata: PartMetadata | null, enabled: boolean | null): PartMetadata | null {
  if (!metadata) return metadata;
  const custom = { ...(metadata.custom ?? {}) };
  if (enabled == null) {
    if (!(SCRAP_CRITERION_ATTR_CODE in custom)) return metadata;
    delete custom[SCRAP_CRITERION_ATTR_CODE];
  } else {
    custom[SCRAP_CRITERION_ATTR_CODE] = enabled;
  }
  const next: PartMetadata = { ...metadata, custom };
  if (Object.keys(custom).length === 0) delete next.custom;
  return next;
}
