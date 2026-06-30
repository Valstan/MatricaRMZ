import 'dotenv/config';

import { and, eq, isNull } from 'drizzle-orm';
import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { erpNomenclature } from '../database/schema.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';

/**
 * Owner request 2026-06-29: retire the deprecated nomenclature item type «Изделие (legacy)»
 * (item_type = 'product') by reclassifying every such row to «Деталь» (item_type = 'part').
 *
 * Why it's safe (verified before writing this):
 *  - 'product' is a LEGACY type: the create UI no longer offers it (WAREHOUSE_ITEM_TYPE_CREATE_OPTIONS),
 *    only the «(legacy)» filter label remains. Every active 'product' row on prod is a real part
 *    (Гильза, Блок, Вал коленчатый, Вкладыши…), not a finished good for sale — so nothing
 *    unintended is swept in.
 *  - Both 'product' and 'part' are HAS_STOCK types → no stock/movement/visibility change.
 *  - normalizeItemTypeToCategory differs only as a FALLBACK for the derived `category` (stored
 *    category untouched); the products-catalog report reads ENTITY type 'product' (EAV), not
 *    erp_nomenclature.item_type, so it is unaffected; directory_kind sync keys on directory_kind,
 *    not item_type, and 'part' is equally valid there.
 *
 * erp_nomenclature IS synced → write THROUGH recordSyncChanges (ledger → index → PG, bumps
 * last_server_seq) so every client pulls the new type. Dry-run by default; pass --apply to mutate.
 * Run on prod AFTER the release pull, with a pg_dump of erp_nomenclature beforehand.
 */
const APPLY = process.argv.includes('--apply');
const FROM = 'product';
const TO = 'part';
const actor = { id: 'system', username: 'system', role: 'system' as const };

async function main() {
  const rows = await db
    .select({ id: erpNomenclature.id, code: erpNomenclature.code, name: erpNomenclature.name, isActive: erpNomenclature.isActive })
    .from(erpNomenclature)
    .where(and(eq(erpNomenclature.itemType, FROM), isNull(erpNomenclature.deletedAt)));

  console.log(`[reclassify] erp_nomenclature item_type='${FROM}' (active+inactive, not deleted): ${rows.length}`);
  const sample = rows.slice(0, 20);
  for (const r of sample) {
    console.log(`   ${String(r.id).slice(0, 8)}  ${String(r.code ?? '').padEnd(16)}  active=${r.isActive ? 1 : 0}  ${String(r.name ?? '').slice(0, 40)}`);
  }
  if (rows.length > sample.length) console.log(`   … +${rows.length - sample.length} more`);

  if (!APPLY) {
    console.log(`[reclassify] DRY-RUN — would set item_type '${FROM}' → '${TO}' for ${rows.length} rows (pass --apply to mutate)`);
    await pool.end();
    return;
  }

  const ts = Date.now();
  let done = 0;
  for (const r of rows) {
    const cur = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, r.id as any)).limit(1);
    if (!cur[0]) continue;
    const dto = SyncTableRegistry.toSyncRow(SyncTableName.ErpNomenclature, cur[0] as Record<string, unknown>);
    dto.item_type = TO;
    dto.updated_at = ts;
    await recordSyncChanges(actor, [{ tableName: SyncTableName.ErpNomenclature, rowId: String(r.id), op: 'upsert', payload: dto }]);
    done += 1;
  }

  console.log(`[reclassify] APPLIED: ${done} rows item_type '${FROM}' → '${TO}' (synced to clients via ledger)`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('[reclassify] fatal', e);
  await pool.end();
  process.exit(1);
});
