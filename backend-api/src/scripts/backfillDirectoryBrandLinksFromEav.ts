/**
 * Phase 3.7 WS3 — G4 реконсиляция: EAV-only brand-links → directory.
 *
 * Бренд-связи детали марки исторически жили в EAV `part_engine_brand` (entities
 * type=part_engine_brand: part_id / engine_brand_id / assembly_unit_number / quantity).
 * Целевая модель (Phase 3.7) — единственный источник `directory_parts.brand_links_json`
 * (id детали == directory_parts.id). Этот скрипт домеривает связи, которые есть в EAV,
 * но отсутствуют в `brand_links_json` соответствующей directory-строки.
 *
 * Backfill **аддитивный и идемпотентный**: добавляет только отсутствующие связи
 * (match по engineBrandId), существующие никогда не трогает/не удаляет.
 *
 * Маппинг: EAV `part_engine_brand.part_id` == `directory_parts.id` (Stage C-зеркало
 * заводило directory-строку с тем же id, что и part-сущность). part_id без directory-строки
 * репортится как unmapped (не бэкафиллится). Связи на soft-deleted марку — dead, пропуск.
 *
 * Dry-run по умолчанию (НИКАКИХ записей). Флаги: --apply | --json | --samples=N
 *   pnpm -F @matricarmz/backend-api warehouse:backfill-directory-brand-links            # dry-run
 *   pnpm -F @matricarmz/backend-api warehouse:backfill-directory-brand-links --apply
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { pool } from '../database/db.js';
import {
  getWarehouseNomenclaturePartSpec,
  upsertWarehouseNomenclaturePartSpec,
} from '../services/warehouseService.js';
import type { PartSpecBrandLink } from '@matricarmz/shared';

const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');
const samplesArg = process.argv.find((x) => x.startsWith('--samples='));
const SAMPLES = samplesArg ? Math.max(0, Number(samplesArg.split('=')[1]) || 0) : 15;

type EavLink = {
  linkId: string;
  partId: string;
  engineBrandId: string;
  assemblyUnitNumber: string;
  quantity: number;
};

// Live EAV part_engine_brand links (complete: part_id + engine_brand_id present),
// owning link-entity not soft-deleted.
async function loadEavLinks(): Promise<EavLink[]> {
  const res = await pool.query(
    `with peb_type as (
       select id from entity_types where code = 'part_engine_brand' and deleted_at is null
     ),
     defs as (
       select ad.code, ad.id from attribute_defs ad, peb_type t
       where ad.entity_type_id = t.id and ad.deleted_at is null
         and ad.code in ('part_id','engine_brand_id','assembly_unit_number','quantity')
     )
     select e.id as link_id,
       max(case when av.attribute_def_id = (select id from defs where code='part_id') then av.value_json end) as part_id,
       max(case when av.attribute_def_id = (select id from defs where code='engine_brand_id') then av.value_json end) as brand_id,
       max(case when av.attribute_def_id = (select id from defs where code='assembly_unit_number') then av.value_json end) as asm,
       max(case when av.attribute_def_id = (select id from defs where code='quantity') then av.value_json end) as qty
     from entities e
     join peb_type t on t.id = e.type_id and e.deleted_at is null
     join attribute_values av on av.entity_id = e.id and av.deleted_at is null
     group by e.id`,
  );
  const out: EavLink[] = [];
  for (const r of res.rows) {
    const partId = parseJsonText(r.part_id);
    const brandId = parseJsonText(r.brand_id);
    if (!partId || !brandId) continue;
    out.push({
      linkId: String(r.link_id),
      partId,
      engineBrandId: brandId,
      assemblyUnitNumber: (parseJsonText(r.asm) ?? '').trim(),
      quantity: parseQty(r.qty),
    });
  }
  return out;
}

function parseJsonText(raw: unknown): string {
  if (raw == null) return '';
  try {
    const v = JSON.parse(String(raw));
    return typeof v === 'string' ? v.trim() : String(v ?? '').trim();
  } catch {
    return String(raw).trim();
  }
}
function parseQty(raw: unknown): number {
  const v = parseJsonText(raw);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// engine_brand ids that are live (exist, type engine_brand, not soft-deleted).
async function liveBrandSet(brandIds: string[]): Promise<Set<string>> {
  const uniq = [...new Set(brandIds.filter(Boolean))];
  if (uniq.length === 0) return new Set();
  const res = await pool.query(
    `select e.id::text id from entities e join entity_types et on et.id = e.type_id
      where et.code = 'engine_brand' and e.deleted_at is null and e.id::text = any($1)`,
    [uniq],
  );
  return new Set(res.rows.map((r) => String(r.id)));
}

// part_id values that map to a live directory_parts row.
async function directoryPartSet(partIds: string[]): Promise<Set<string>> {
  const uniq = [...new Set(partIds.filter(Boolean))];
  if (uniq.length === 0) return new Set();
  const res = await pool.query(
    `select id::text id from directory_parts where deleted_at is null and id::text = any($1)`,
    [uniq],
  );
  return new Set(res.rows.map((r) => String(r.id)));
}

async function main() {
  const startedAt = Date.now();
  const eavLinks = await loadEavLinks();
  const liveBrands = await liveBrandSet(eavLinks.map((l) => l.engineBrandId));
  const directoryParts = await directoryPartSet(eavLinks.map((l) => l.partId));

  const stat = {
    eavLinks: eavLinks.length,
    deadBrand: 0,
    unmappedPart: 0,
    alreadyCovered: 0,
    gaps: 0,
    partsTouched: 0,
    applied: 0,
    errors: [] as string[],
  };
  const samples: Array<{ partId: string; engineBrandId: string; asm: string; qty: number }> = [];

  // Group gap links by directory part so each part is written once.
  const gapsByPart = new Map<string, EavLink[]>();
  // Cache current directory brand-link engineBrandIds per part (dry-run safe read).
  const coveredCache = new Map<string, Set<string>>();

  async function coveredBrands(partId: string): Promise<Set<string>> {
    const hit = coveredCache.get(partId);
    if (hit) return hit;
    const cur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: partId });
    const set = new Set<string>();
    if (cur.ok && cur.spec) for (const l of cur.spec.brandLinks) set.add(String(l.engineBrandId));
    coveredCache.set(partId, set);
    return set;
  }

  for (const link of eavLinks) {
    if (!liveBrands.has(link.engineBrandId)) {
      stat.deadBrand += 1;
      continue;
    }
    if (!directoryParts.has(link.partId)) {
      stat.unmappedPart += 1;
      continue;
    }
    const covered = await coveredBrands(link.partId);
    if (covered.has(link.engineBrandId)) {
      stat.alreadyCovered += 1;
      continue;
    }
    // mark covered now so a duplicate EAV link to the same (part,brand) counts once
    covered.add(link.engineBrandId);
    stat.gaps += 1;
    const arr = gapsByPart.get(link.partId) ?? [];
    arr.push(link);
    gapsByPart.set(link.partId, arr);
    if (samples.length < SAMPLES) samples.push({ partId: link.partId, engineBrandId: link.engineBrandId, asm: link.assemblyUnitNumber, qty: link.quantity });
  }
  stat.partsTouched = gapsByPart.size;

  if (APPLY) {
    for (const [partId, links] of gapsByPart) {
      try {
        const cur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: partId });
        if (!cur.ok) throw new Error(`read spec: ${cur.error}`);
        const base = cur.spec ?? { code: null, templateId: null, dimensions: [], brandLinks: [] };
        const present = new Set(base.brandLinks.map((l) => String(l.engineBrandId)));
        const additions: PartSpecBrandLink[] = [];
        for (const l of links) {
          if (present.has(l.engineBrandId)) continue;
          present.add(l.engineBrandId);
          additions.push({ id: randomUUID(), engineBrandId: l.engineBrandId, assemblyUnitNumber: l.assemblyUnitNumber || null, quantity: l.quantity });
        }
        if (additions.length === 0) continue;
        const up = await upsertWarehouseNomenclaturePartSpec({
          nomenclatureId: partId,
          spec: { ...base, brandLinks: [...base.brandLinks, ...additions] },
        });
        if (!up.ok) throw new Error(`upsert spec: ${up.error}`);
        stat.applied += additions.length;
      } catch (e) {
        stat.errors.push(`${partId}: ${String(e)}`);
      }
    }
  }

  const report = {
    mode: APPLY ? 'apply' : 'dry-run',
    ...stat,
    samples,
    elapsedMs: Date.now() - startedAt,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[ws3-g4] mode=${report.mode}`);
    console.log(
      `[ws3-g4] eav=${stat.eavLinks} dead-brand=${stat.deadBrand} unmapped=${stat.unmappedPart} already=${stat.alreadyCovered} gaps=${stat.gaps} (parts=${stat.partsTouched})${APPLY ? ` applied=${stat.applied}` : ''}`,
    );
    for (const s of samples) console.log(`  gap part ${s.partId} → brand ${s.engineBrandId} (asm "${s.asm}", qty ${s.qty})`);
    if (stat.unmappedPart > 0) console.log(`  ⚠ ${stat.unmappedPart} EAV-связь(и) на part_id без directory-строки — не бэкафиллены (review).`);
    if (stat.errors.length) for (const e of stat.errors) console.log(`  ERROR ${e}`);
    if (!APPLY && stat.gaps > 0) console.log('\nDry-run. Перезапустите с --apply (после pg_dump) для записи.');
  }
}

void main()
  .catch((e) => {
    console.error('[ws3-g4] ошибка', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
