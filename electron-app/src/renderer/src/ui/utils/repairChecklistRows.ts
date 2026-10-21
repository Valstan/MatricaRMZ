/**
 * Чистая логика идентичности и merge строк чек-листов (дефектовка / комплектность / список деталей).
 *
 * G3 (parts-chain-audit): строки больше НЕ ключуются только текст-сигнатурой `(part_name, part_number)`.
 * У строки есть устойчивый id номенклатуры:
 *  - brand-managed строки несут `__brand_part_id` (+ `__brand_source`) — авто-синк из списка деталей марки;
 *  - вручную выбранные из списка строки несут `__part_id` (id выбранной/созданной детали).
 * Merge и dedup идут по id (`getRowPartId`), текст-сигнатура — только fallback для legacy-строк без id.
 *
 * Извлечено из RepairChecklistPanel.tsx ради юнит-тестов (rfx #013 «доказать, не на глаз»).
 */

import { engineInventoryRowSignature, type FileRef } from '@matricarmz/shared';

export type ChecklistTableRow = Record<string, string | boolean | number>;

export const BRAND_ROW_SOURCE_KEY = '__brand_source';
export const BRAND_ROW_PART_ID_KEY = '__brand_part_id';
export const BRAND_ROW_SOURCE_VALUE = 'engine_brand';
/** id номенклатуры/детали для строки, выбранной вручную из списка (G3 — id-ключевание). */
export const ROW_PART_ID_KEY = '__part_id';
/** Фото-доказательства дефекта на уровне строки (MVP-2): JSON-строка `FileRef[]` в мета-ключе. */
export const ROW_PHOTOS_KEY = '__photos';
/** Отметка «включить строку в печать акта» (Ф1 актов двигателя): мета-ключ, хранится как у `__photos`. */
export const ROW_SELECTED_KEY = '__selected';

export function normalizeChecklistSignaturePart(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

export function defectRowSignature(row: ChecklistTableRow): string {
  return `${normalizeChecklistSignaturePart((row as any).part_name)}::${normalizeChecklistSignaturePart((row as any).part_number)}`;
}

export function completenessRowSignature(row: ChecklistTableRow): string {
  return `${normalizeChecklistSignaturePart((row as any).part_name)}::${normalizeChecklistSignaturePart((row as any).assembly_unit_number)}`;
}

export function getBrandPartId(row: ChecklistTableRow): string {
  return String((row as any)?.[BRAND_ROW_PART_ID_KEY] ?? '').trim();
}

export function getManualPartId(row: ChecklistTableRow): string {
  return String((row as any)?.[ROW_PART_ID_KEY] ?? '').trim();
}

/** Единая идентичность строки: id brand-managed детали, иначе id вручную выбранной детали. */
export function getRowPartId(row: ChecklistTableRow): string {
  return getBrandPartId(row) || getManualPartId(row);
}

/** Фото-доказательства строки (MVP-2). Парсит JSON из `__photos`; невалидные элементы отбрасывает. */
export function getRowPhotos(row: ChecklistTableRow): FileRef[] {
  const raw = (row as any)?.[ROW_PHOTOS_KEY];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x): x is FileRef => !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.name === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Возвращает копию строки с записанными фото (`__photos` как JSON-строка).
 * Пустой список удаляет мета-ключ — строка не несёт лишнего шума и не двоит sync-сигнатуру.
 */
export function withRowPhotos(row: ChecklistTableRow, photos: FileRef[]): ChecklistTableRow {
  const next = { ...row } as Record<string, string | boolean | number | undefined>;
  if (photos.length === 0) {
    delete next[ROW_PHOTOS_KEY];
  } else {
    next[ROW_PHOTOS_KEY] = JSON.stringify(photos);
  }
  return next as ChecklistTableRow;
}

/** Отмечена ли строка для печати акта. Толерантна к boolean/`'1'`/1 (разные источники записи). */
export function getRowSelected(row: ChecklistTableRow): boolean {
  const v = (row as any)?.[ROW_SELECTED_KEY];
  return v === true || v === '1' || v === 1;
}

/**
 * Копия строки с отметкой выбора. Невыбранная строка теряет мета-ключ — не несёт лишнего шума
 * и не двоит sync-сигнатуру (тот же приём, что у `withRowPhotos`).
 */
export function withRowSelected(row: ChecklistTableRow, selected: boolean): ChecklistTableRow {
  const next = { ...row } as Record<string, string | boolean | number | undefined>;
  if (selected) next[ROW_SELECTED_KEY] = true;
  else delete next[ROW_SELECTED_KEY];
  return next as ChecklistTableRow;
}

export function isBrandLinkedChecklistRow(row: ChecklistTableRow): boolean {
  return String((row as any)?.[BRAND_ROW_SOURCE_KEY] ?? '') === BRAND_ROW_SOURCE_VALUE && getBrandPartId(row) !== '';
}

/**
 * Видимость строки списка деталей при фильтре по варианту сборки (checklist-unify Этап 5).
 *
 * `membership` — map `nomenclatureId → set вариантов из BOM марки` (детали без variantGroup в BOM
 * туда НЕ попадают — они общие для всех сборок). `activeVariant` — вариант активного Assembly-наряда.
 *
 * Правило: фильтр выключен (`activeVariant` пуст) → видно всё; деталь без членства (общая) → видна
 * всегда; иначе видна только если её множество вариантов содержит активный.
 */
export function isInventoryRowVisibleForVariant(
  rowPartId: string,
  membership: Map<string, Set<string>>,
  activeVariant: string | null,
): boolean {
  const variant = String(activeVariant ?? '').trim();
  if (!variant) return true;
  const set = membership.get(String(rowPartId ?? '').trim());
  if (!set || set.size === 0) return true;
  return set.has(variant);
}

export function markBrandLinkedRow(row: ChecklistTableRow, partId: string): ChecklistTableRow {
  return {
    ...row,
    [BRAND_ROW_SOURCE_KEY]: BRAND_ROW_SOURCE_VALUE,
    [BRAND_ROW_PART_ID_KEY]: String(partId),
  };
}

/** Снимает brand-разметку (строка переходит в ручные). Идентичность `__part_id` СОХРАНЯЕТСЯ. */
export function clearBrandRowMeta(row: ChecklistTableRow): ChecklistTableRow {
  const next = { ...row } as Record<string, string | boolean | number | undefined>;
  delete next[BRAND_ROW_SOURCE_KEY];
  delete next[BRAND_ROW_PART_ID_KEY];
  return next as ChecklistTableRow;
}

/**
 * Извлекает id вручную выбранной детали из id опции SearchSelect.
 * `part:<id>` → `<id>` (unprefixed — совпадает с brand `__brand_part_id` той же детали);
 * `node:<id>` и прочее → исходная строка (namespaced, не коллизирует с part-id).
 */
export function rowPartIdFromOptionId(optionId: string | null | undefined): string {
  const id = String(optionId ?? '').trim();
  if (!id) return '';
  return id.startsWith('part:') ? id.slice('part:'.length) : id;
}

/**
 * Метаданные идентичности строки для переклейки после нормализации, которая стирает extra-ключи
 * (inventory: `normalizeEngineInventoryRow` возвращает только известные колонки).
 */
export function preserveRowIdentityMeta(prev: ChecklistTableRow | null | undefined): Record<string, string> {
  const meta: Record<string, string> = {};
  if (prev && String((prev as any)[BRAND_ROW_SOURCE_KEY] ?? '') === BRAND_ROW_SOURCE_VALUE) {
    meta[BRAND_ROW_SOURCE_KEY] = BRAND_ROW_SOURCE_VALUE;
    meta[BRAND_ROW_PART_ID_KEY] = String((prev as any)[BRAND_ROW_PART_ID_KEY] ?? '');
  }
  const manualPartId = getManualPartId(prev ?? {});
  if (manualPartId) meta[ROW_PART_ID_KEY] = manualPartId;
  const photos = prev ? String((prev as any)[ROW_PHOTOS_KEY] ?? '').trim() : '';
  if (photos) meta[ROW_PHOTOS_KEY] = photos;
  if (getRowSelected(prev ?? {})) meta[ROW_SELECTED_KEY] = '1';
  return meta;
}

/**
 * Сливает свежий список brand-managed строк с текущими (ручные правки сохраняются).
 *
 * Матчинг prev→base: сначала по id детали (`getRowPartId`), затем fallback по текст-сигнатуре.
 * Ручная строка удерживается, если её id НЕ среди brand-managed id; для legacy-строк без id —
 * fallback на текст-сигнатуру (как раньше). Так строка с правками не теряется при коллизии текста,
 * а ручная строка той же детали, что стала brand-managed, дедупится по id (её правки сливаются в base).
 */
export function mergeBrandManagedRows(
  currentRows: ChecklistTableRow[],
  freshBrandRows: ChecklistTableRow[],
  getSignature: (row: ChecklistTableRow) => string,
  mergeEditableFields: (base: ChecklistTableRow, prev: ChecklistTableRow | null) => ChecklistTableRow,
): ChecklistTableRow[] {
  const currentByPartId = new Map<string, ChecklistTableRow>();
  const currentBySignature = new Map<string, ChecklistTableRow>();
  for (const row of currentRows) {
    const partId = getRowPartId(row);
    if (partId && !currentByPartId.has(partId)) currentByPartId.set(partId, row);
    const signature = getSignature(row);
    if (signature && !currentBySignature.has(signature)) currentBySignature.set(signature, row);
  }

  const managedBrandSignatures = new Set<string>();
  const managedBrandPartIds = new Set<string>();
  const mergedManagedRows = freshBrandRows.map((base) => {
    const signature = getSignature(base);
    managedBrandSignatures.add(signature);
    const basePartId = getRowPartId(base);
    if (basePartId) managedBrandPartIds.add(basePartId);
    const prev = (basePartId ? currentByPartId.get(basePartId) : null) ?? currentBySignature.get(signature) ?? null;
    return mergeEditableFields(base, prev);
  });

  const manualRows = currentRows.filter((row) => {
    if (getBrandPartId(row)) return false;
    const partId = getManualPartId(row);
    if (partId) return !managedBrandPartIds.has(partId);
    const signature = getSignature(row);
    return signature ? !managedBrandSignatures.has(signature) : true;
  });

  return [...mergedManagedRows, ...manualRows.map(clearBrandRowMeta)];
}

/* -------------------------------------------------------------------------- *
 * Канонические строки стадии по спецификации марки
 * -------------------------------------------------------------------------- */

/**
 * Привязка детали к марке в той форме, в какой её ждут строки акта. Живёт здесь, а не
 * в панели акта: с 21.10.2026 те же строки строит пакетный приём (утиль верхнего
 * картера) — две копии разошлись бы, и строка приёмки не слилась бы с строкой панели.
 */
export function getBrandLinkForPart(part: unknown, engineBrandId: string | undefined) {
  const brandId = String(engineBrandId || '').trim();
  if (!brandId || !part || typeof part !== 'object') return null;
  const links = Array.isArray((part as any).brandLinks) ? (part as any).brandLinks : [];
  const link = links.find((x: any) => String(x?.engineBrandId || '').trim() === brandId);
  if (!link) return null;
  // Решение владельца (2026-06-12): артикул детали И ЕСТЬ «№ сборочной единицы».
  // Артикул приоритетен; legacy-привязки без артикула падают на старый assemblyUnitNumber.
  const article = String((part as any).article ?? '').trim();
  return {
    partNumber: String(link.assemblyUnitNumber ?? ''),
    assemblyUnitNumber: article || String(link.assemblyUnitNumber ?? ''),
    quantity: Number.isFinite(Number(link.quantity)) ? Number(link.quantity) : 0,
    inCompletenessAct: Boolean(link.inCompletenessAct),
    inDefectAct: Boolean(link.inDefectAct),
    hasOwnNumber: Boolean(link.hasOwnNumber),
  };
}

export function toQtyValue(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Канонические строки стадии по спецификации марки — единственный источник «как должно быть».
 * Используется авто-resync'ом (там результат сливается с правками оператора), кнопкой
 * «Сбросить по двигателю и марке» (заменяет строки целиком) и пакетным приёмом.
 */
export function buildBrandRowsForStage(
  parts: unknown[],
  engineBrandId: string | undefined,
  stage: string,
): ChecklistTableRow[] {
  return parts.map((p: any) => {
    const link = getBrandLinkForPart(p, engineBrandId);
    const qty = toQtyValue(link?.quantity ?? 0);
    const partName = String(p.name ?? p.article ?? p.id);
    const partId = String(p?.id ?? '');

    if (stage === 'defect') {
      return markBrandLinkedRow(
        {
          part_name: partName,
          part_number: String(link?.partNumber ?? ''),
          quantity: qty,
          repairable_qty: qty,
          scrap_qty: 0,
        },
        partId,
      );
    }

    if (stage === 'completeness') {
      return markBrandLinkedRow(
        {
          part_name: partName,
          assembly_unit_number: String(link?.assemblyUnitNumber ?? ''),
          quantity: qty,
          present: false,
          actual_qty: 0,
        },
        partId,
      );
    }

    // Т4: галочки актов копируются из привязки деталь↔марка; default-наличие: акт-детали
    // приходят с ПУСТЫМ наличием (печатается чистый акт, работники заполняют на бумаге),
    // остальная мелочёвка — наличие проставлено сразу.
    const inCompleteness = Boolean((link as any)?.inCompletenessAct);
    const inDefect = Boolean((link as any)?.inDefectAct);
    const defaultPresent = !(inCompleteness || inDefect);
    return markBrandLinkedRow(
      {
        part_name: partName,
        assembly_unit_number: String(link?.assemblyUnitNumber ?? ''),
        part_number: String(link?.partNumber ?? ''),
        bom_variant_group: '',
        quantity: qty,
        present: defaultPresent,
        actual_qty: defaultPresent ? qty : 0,
        repairable_qty: qty,
        scrap_qty: 0,
        replace_qty: 0,
        in_completeness_act: inCompleteness,
        in_defect_act: inDefect,
        // «Свой номер» — тоже флаг комплекта марки: строка двигателя наследует его отсюда.
        has_own_number: Boolean((link as any)?.hasOwnNumber),
      },
      partId,
    );
  });
}

/** Идентичность строки списка деталей — та же, что у панели акта (part_name + номера). */
export function inventoryRowSignature(row: ChecklistTableRow): string {
  return engineInventoryRowSignature({
    part_name: String((row as any).part_name ?? ''),
    assembly_unit_number: String((row as any).assembly_unit_number ?? ''),
    part_number: String((row as any).part_number ?? ''),
  });
}

/**
 * Пометить утиль строки в списке деталей двигателя (утиль верхнего картера, 21.10.2026).
 * Строку ищем по сигнатуре, а не по порядку: оператор мог её уже править, а порядок
 * строк меняется при resync по марке. Существующую обновляем — второй строки той же
 * детали не появляется.
 */
export function markScrapRow(
  rows: ChecklistTableRow[],
  scrapRow: ChecklistTableRow,
): { rows: ChecklistTableRow[]; existed: boolean } {
  const signature = inventoryRowSignature(scrapRow);
  const index = rows.findIndex((row) => inventoryRowSignature(row) === signature);
  const scrapQty = Number((scrapRow as any).scrap_qty ?? 0) || 1;
  if (index < 0) return { rows: [...rows, scrapRow], existed: false };
  const next = [...rows];
  next[index] = {
    ...next[index],
    present: true,
    actual_qty: Number((next[index] as any).actual_qty ?? 0) || scrapQty,
    scrap_qty: scrapQty,
    repairable_qty: 0,
  };
  return { rows: next, existed: true };
}
