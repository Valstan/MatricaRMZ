/**
 * Гарантия согласованности «BOM-деталь ↔ деталь марки» (директива brain bom-parts, интерпретация A).
 *
 * Phase 3.7 WS1 — directory-native. Деталь марки живёт на строке `directory_parts`
 * с **id == erp_nomenclature.id** (id-тождество), brand-link'и — прямо в
 * `directory_parts.brand_links_json`. EAV-keyspace (`entities part`,
 * `part_engine_brand`) больше не пишется, `erp_nomenclature.directory_ref_id`
 * больше не выставляется (двойная конвенция G1 не плодится у источника).
 *
 * Идемпотентно заводит BOM-компонент как деталь его марок:
 *   1. read: getWarehouseNomenclaturePartSpec({ id == nomId }) — текущий spec/brandLinks;
 *   2. merge: добавляет недостающие brand-link'и (по engineBrandId), сохраняя существующие;
 *   3. write: upsertWarehouseNomenclaturePartSpec({ id == nomId }) — directory-only,
 *      без ledger-подписи (server-only таблица, клиенты читают по live-HTTP-API).
 *
 * Используется и разовым backfill-скриптом, и хуком-гарантией в upsertWarehouseAssemblyBom.
 * Steady-state (все brand-link'и уже есть) — только read, без записи.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PartSpec, PartSpecBrandLink } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { erpNomenclature } from '../database/schema.js';
import type { AuthUser } from '../auth/jwt.js';
import { getWarehouseNomenclaturePartSpec, upsertWarehouseNomenclaturePartSpec } from './warehouseService.js';

/** В BOM нет «узла сборки» — brand-link детали марки несёт человекочитаемый placeholder. */
export const BOM_BRAND_PART_ASM_PLACEHOLDER = '—';

export type EnsureBrandPartResult = {
  partId: string;
  partCreated: boolean;
  bound: boolean;
  linksCreated: number;
  linksPresent: number;
};

const EMPTY_SPEC: PartSpec = { code: null, dimensions: [], brandLinks: [] };

/**
 * Гарантирует directory-представление детали марки + brand-link'и для одной BOM-номенклатуры.
 * `brandQty` — карта engineBrandId → quantity (qty_per_unit из BOM-строки).
 * Возвращает null, если номенклатура удалена/не найдена. Бросает только на сбое чтения/записи
 * (вызывающий оборачивает best-effort).
 *
 * `opts.bind` сохранён в сигнатуре для совместимости с backfill-скриптом, но в directory-native
 * режиме игнорируется: id-тождество — единственная конвенция, `directory_ref_id` не выставляется.
 */
export async function ensureNomenclatureBrandPart(
  actor: AuthUser,
  nomId: string,
  brandQty: Map<string, number>,
  opts: { bind?: boolean; asmPlaceholder?: string } = {},
): Promise<EnsureBrandPartResult | null> {
  const asm = opts.asmPlaceholder ?? BOM_BRAND_PART_ASM_PLACEHOLDER;

  const nom = (
    await db
      .select({
        id: erpNomenclature.id,
        name: erpNomenclature.name,
        directoryRefId: erpNomenclature.directoryRefId,
        deletedAt: erpNomenclature.deletedAt,
      })
      .from(erpNomenclature)
      .where(eq(erpNomenclature.id, nomId))
      .limit(1)
  )[0];
  if (!nom || nom.deletedAt != null) return null;

  // id-тождество: brand-link'и пишутся на directory_parts с id == nomId. Если у номенклатуры
  // уже выставлен directory_ref_id на другую (одну из 27 ref-only) строку — её мы здесь не
  // трогаем: legacy-строка осиротеет и подберётся унификацией WS4. Пишем по id-тождеству.
  if (nom.directoryRefId && String(nom.directoryRefId) !== nomId) {
    console.warn(
      `[bom-parts] nom ${nomId}: directory_ref_id=${String(nom.directoryRefId)} (ref-only) — пишу brand-links по id-тождеству, legacy-строка отложена в WS4`,
    );
  }

  const current = await getWarehouseNomenclaturePartSpec({ nomenclatureId: nomId });
  if (!current.ok) throw new Error(`read part-spec "${nomId}": ${current.error}`);
  const partCreated = current.spec == null;
  const existingSpec: PartSpec = current.spec ?? EMPTY_SPEC;
  const existingLinks = existingSpec.brandLinks;
  const present = new Set(existingLinks.map((l) => String(l.engineBrandId)));

  const newLinks: PartSpecBrandLink[] = [];
  let linksCreated = 0;
  let linksPresent = 0;
  for (const [brandId, qty] of brandQty) {
    if (present.has(brandId)) {
      linksPresent += 1;
      continue;
    }
    newLinks.push({ id: randomUUID(), engineBrandId: brandId, assemblyUnitNumber: asm, quantity: qty });
    linksCreated += 1;
  }

  // Пишем только когда есть что добавить, либо чтобы материализовать пустую id-тождественную
  // строку для новой детали (сохраняем прежнее «деталь марки заведена даже без brand-link'ов»).
  if (linksCreated > 0 || partCreated) {
    const merged: PartSpec = { ...existingSpec, brandLinks: [...existingLinks, ...newLinks] };
    const saved = await upsertWarehouseNomenclaturePartSpec({ nomenclatureId: nomId, spec: merged });
    if (!saved.ok) throw new Error(`upsert part-spec "${nomId}": ${saved.error}`);
  }

  return { partId: nomId, partCreated, bound: false, linksCreated, linksPresent };
}
