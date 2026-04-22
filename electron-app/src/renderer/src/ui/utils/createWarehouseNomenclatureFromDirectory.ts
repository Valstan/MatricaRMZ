import type { NomenclatureItemType } from '@matricarmz/shared';

import type { NomenclatureCreateConfig } from '../pages/nomenclatureDirectoryPresets.js';
import { buildNomenclatureCode } from './nomenclatureCode.js';

export async function createSourceEntityForDirectoryKind(kind: string, label: string): Promise<string | null> {
  const normalizedKind = String(kind ?? '').trim().toLowerCase();
  if (!normalizedKind) return null;
  const typeCandidates: Record<string, string[]> = {
    part: ['part'],
    tool: ['tool'],
    good: ['good', 'product'],
    service: ['service'],
    engine_brand: ['engine_brand'],
  };
  const candidates = typeCandidates[normalizedKind] ?? [normalizedKind];
  const typeList = await window.matrica.admin.entityTypes.list();
  if (!Array.isArray(typeList)) return null;
  const found = candidates
    .map((code) => typeList.find((row) => String(row.code ?? '').trim().toLowerCase() === code))
    .find(Boolean) as { id?: string } | undefined;
  const typeId = String(found?.id ?? '').trim();
  if (!typeId) return null;
  const created = await window.matrica.admin.entities.create(typeId);
  if (!created?.ok || !created.id) return null;
  const entityId = String(created.id);
  const trimmedLabel = String(label ?? '').trim() || 'Новая позиция';
  for (const attrCode of ['name', 'title', 'label']) {
    const setRes = await window.matrica.admin.entities.setAttr(entityId, attrCode, trimmedLabel);
    if (setRes?.ok) break;
  }
  return entityId;
}

export type CreateNomenclatureLineFromPresetResult =
  | { ok: true; mode: 'nomenclature'; nomenclatureId: string }
  | { ok: true; mode: 'part'; partId: string }
  | { ok: false; error: string }
  | { ok: false; duplicatePartId: string; message: string };

/**
 * Создание позиции как в каталоге номенклатуры: деталь через parts.create, остальное — источник + warehouse.nomenclatureUpsert.
 */
export async function createNomenclatureLineFromPreset(args: {
  directoryKind: string;
  createConfig: NomenclatureCreateConfig;
  displayName: string;
}): Promise<CreateNomenclatureLineFromPresetResult> {
  const directoryKind = String(args.directoryKind ?? '').trim().toLowerCase();
  const displayName = String(args.displayName ?? '').trim();
  const createConfig = args.createConfig;
  const nameForRow = displayName || createConfig.name;

  if (directoryKind === 'part') {
    const createdPart = await window.matrica.parts.create({
      attributes: {
        code: buildNomenclatureCode(createConfig.codePrefix),
        name: nameForRow,
      },
    });
    if (!createdPart?.ok || !createdPart.part?.id) {
      const rawErr = createdPart && 'error' in createdPart ? String(createdPart.error ?? '') : 'не удалось создать деталь';
      const duplicateMatch = rawErr.match(/duplicate part exists:\s*([0-9a-f-]{36})/i);
      if (duplicateMatch?.[1]) {
        return { ok: false, duplicatePartId: String(duplicateMatch[1]), message: rawErr };
      }
      return { ok: false, error: rawErr };
    }
    return { ok: true, mode: 'part', partId: String(createdPart.part.id) };
  }

  const sourceId = await createSourceEntityForDirectoryKind(directoryKind, nameForRow);
  if (!sourceId) {
    return { ok: false, error: `Не удалось создать карточку источника для «${directoryKind}». Проверьте типы справочников (например, «good» / «service») и права.` };
  }

  const lookups = await window.matrica.warehouse.lookupsGet();
  if (!lookups?.ok) {
    return { ok: false, error: String(lookups?.error ?? 'не удалось загрузить справочники склада') };
  }
  const groupId = String(lookups.lookups?.nomenclatureGroups?.[0]?.id ?? '').trim();
  const unitId = String(lookups.lookups?.units?.[0]?.id ?? '').trim();
  if (!groupId || !unitId) {
    return { ok: false, error: 'Не найдены группа номенклатуры или единица измерения по умолчанию (Склад → Номенклатура).' };
  }

  const templatesRes = await window.matrica.warehouse.nomenclatureTemplatesList();
  if (!templatesRes?.ok) {
    return { ok: false, error: String(templatesRes?.error ?? 'не удалось загрузить шаблоны номенклатуры') };
  }
  const templates = (templatesRes.rows ?? []).map((row) => ({
    id: String((row as { id?: string }).id ?? ''),
    code: String((row as { code?: string }).code ?? '').trim().toLowerCase(),
    itemTypeCode: String((row as { itemTypeCode?: string }).itemTypeCode ?? '').trim().toLowerCase(),
    directoryKind: String((row as { directoryKind?: string }).directoryKind ?? '').trim().toLowerCase(),
  }));
  const itemTypeCode = String(createConfig.itemType ?? '').trim().toLowerCase() as NomenclatureItemType;
  const defaultCode = `default_${directoryKind}`;
  const bestTemplate =
    templates.find((t) => t.id && t.code === defaultCode) ??
    templates.find((t) => t.id && t.itemTypeCode === itemTypeCode && t.directoryKind === directoryKind) ??
    templates.find((t) => t.id && t.itemTypeCode === itemTypeCode && !t.directoryKind) ??
    templates.find((t) => t.id && !t.itemTypeCode && (t.directoryKind === directoryKind || !t.directoryKind)) ??
    null;
  if (!bestTemplate?.id) {
    return {
      ok: false,
      error: `Не найден шаблон номенклатуры для типа «${itemTypeCode}» и источника «${directoryKind}». Настройте шаблон в «Склад → Номенклатура».`,
    };
  }

  const created = await window.matrica.warehouse.nomenclatureUpsert({
    code: buildNomenclatureCode(createConfig.codePrefix),
    name: nameForRow,
    itemType: createConfig.itemType,
    category: createConfig.category,
    directoryKind: String(args.directoryKind ?? '').trim(),
    directoryRefId: sourceId,
    groupId,
    unitId,
    specJson: JSON.stringify({ templateId: bestTemplate.id, propertyValues: {} }),
    isActive: true,
  });
  if (!created?.ok) {
    return { ok: false, error: String(created.error ?? 'не удалось создать позицию номенклатуры') };
  }
  if (!created.id) {
    return { ok: false, error: 'Не удалось создать позицию номенклатуры' };
  }
  return { ok: true, mode: 'nomenclature', nomenclatureId: String(created.id) };
}
