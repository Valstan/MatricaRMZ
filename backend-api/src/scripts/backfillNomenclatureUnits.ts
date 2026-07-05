import 'dotenv/config';

import { isNull, and } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { erpNomenclature } from '../database/schema.js';
import { upsertWarehouseNomenclature } from '../services/warehouseService.js';

/**
 * Backfill: legacy nomenclature rows created before units were mandatory have
 * unit_id = null (~185 on prod as of 2026-07-05; all are engine parts/products —
 * «шт» applies). Fills ONLY empty unit_id with the given unit; never overwrites.
 *
 * Writes go through upsertWarehouseNomenclature (signed ledger path) so clients
 * receive the change via sync.
 *
 * Dry-run by default; --apply to mutate. --unit <name> overrides «шт».
 */

const APPLY = process.argv.includes('--apply');
const unitArgIdx = process.argv.indexOf('--unit');
const UNIT_NAME = unitArgIdx >= 0 ? String(process.argv[unitArgIdx + 1] ?? '').trim() : 'шт';

async function resolveUnitId(name: string): Promise<string> {
  const r = await pool.query(
    `select e.id::text as id
       from entities e
       join entity_types et on et.id = e.type_id and et.code = 'unit'
       join attribute_defs ad on ad.entity_type_id = et.id and ad.code = 'name'
       join attribute_values av on av.entity_id = e.id and av.attribute_def_id = ad.id and av.deleted_at is null
      where e.deleted_at is null and lower(trim(both '"' from av.value_json)) = lower($1) limit 1`,
    [name],
  );
  if (!r.rows[0]) throw new Error(`единица измерения «${name}» не найдена в справочнике unit`);
  return String(r.rows[0].id);
}

async function main() {
  const unitId = await resolveUnitId(UNIT_NAME);
  console.log(`[backfill-units] единица: «${UNIT_NAME}» (${unitId.slice(0, 8)}…), режим: ${APPLY ? 'APPLY' : 'dry-run'}`);

  const rows = await db
    .select()
    .from(erpNomenclature)
    .where(and(isNull(erpNomenclature.unitId), isNull(erpNomenclature.deletedAt)))
    .limit(10_000);
  console.log(`[backfill-units] позиций без единицы: ${rows.length}`);

  let updated = 0;
  let failed = 0;
  for (const nom of rows) {
    console.log(`  ${String(nom.code)} «${String(nom.name)}» → ${UNIT_NAME}`);
    if (!APPLY) continue;
    // Legacy rows may carry specJson.templateId pointing at a deleted template —
    // the upsert validates it and refuses. Dead reference → strip and retry once.
    let effectiveSpecJson = nom.specJson == null ? null : String(nom.specJson);
    const doUpsert = () =>
      upsertWarehouseNomenclature({
      id: String(nom.id),
      code: String(nom.code),
      sku: nom.sku == null ? null : String(nom.sku),
      name: String(nom.name),
      itemType: String(nom.itemType ?? 'material'),
      category: nom.category == null ? null : String(nom.category),
      directoryKind: nom.directoryKind == null ? null : String(nom.directoryKind),
      directoryRefId: nom.directoryRefId == null ? null : String(nom.directoryRefId),
      groupId: nom.groupId == null ? null : String(nom.groupId),
      unitId,
      barcode: nom.barcode == null ? null : String(nom.barcode),
      minStock: nom.minStock == null ? null : Number(nom.minStock),
      maxStock: nom.maxStock == null ? null : Number(nom.maxStock),
      defaultBrandId: nom.defaultBrandId == null ? null : String(nom.defaultBrandId),
      isSerialTracked: Boolean(nom.isSerialTracked),
      defaultWarehouseId: nom.defaultWarehouseId == null ? null : String(nom.defaultWarehouseId),
        specJson: effectiveSpecJson,
        componentTypeId: nom.componentTypeId == null ? null : String(nom.componentTypeId),
        isActive: Boolean(nom.isActive),
      });
    let res = await doUpsert();
    if (!res.ok && /шаблон номенклатуры не найден/i.test(String(res.error)) && effectiveSpecJson) {
      try {
        const spec = JSON.parse(effectiveSpecJson) as Record<string, unknown>;
        delete spec.templateId;
        effectiveSpecJson = JSON.stringify(spec);
        res = await doUpsert();
      } catch {
        /* keep original error */
      }
    }
    if (res.ok) updated += 1;
    else {
      failed += 1;
      console.error(`  !! ${String(nom.code)}: ${String(res.error)}`);
    }
  }

  console.log(`[backfill-units] итог: ${APPLY ? `обновлено ${updated}, ошибок ${failed}` : `к обновлению ${rows.length} (dry-run)`}`);
  await pool.end();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
