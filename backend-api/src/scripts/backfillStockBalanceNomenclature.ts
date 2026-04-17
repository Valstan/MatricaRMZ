/**
 * Backfill script: for every erp_reg_stock_balance row where part_card_id is set
 * but nomenclature_id is null, resolve via erp_nomenclature.directory_ref_id
 * and set nomenclature_id.
 *
 * Usage: npx tsx src/scripts/backfillStockBalanceNomenclature.ts [--dry-run]
 */
import { and, eq, isNull, isNotNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { erpNomenclature, erpRegStockBalance } from '../database/schema.js';

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(`[backfill-stock-nomenclature] ${isDryRun ? 'DRY RUN' : 'LIVE RUN'}`);

  const orphanRows = await db
    .select({
      id: erpRegStockBalance.id,
      partCardId: erpRegStockBalance.partCardId,
      warehouseId: erpRegStockBalance.warehouseId,
      qty: erpRegStockBalance.qty,
    })
    .from(erpRegStockBalance)
    .where(and(isNotNull(erpRegStockBalance.partCardId), isNull(erpRegStockBalance.nomenclatureId)));

  console.log(`  Found ${orphanRows.length} balance rows with part_card_id but no nomenclature_id`);
  if (orphanRows.length === 0) {
    console.log('  Nothing to do.');
    return;
  }

  const partCardIds = Array.from(new Set(orphanRows.map((r) => String(r.partCardId)).filter(Boolean)));
  const nomenclatureRows = await db
    .select({ id: erpNomenclature.id, directoryRefId: erpNomenclature.directoryRefId })
    .from(erpNomenclature)
    .where(and(eq(erpNomenclature.directoryKind, 'part'), isNull(erpNomenclature.deletedAt)));

  const nomenclatureByPartCard = new Map<string, string>();
  for (const row of nomenclatureRows) {
    const refId = String(row.directoryRefId ?? '').trim();
    if (refId) nomenclatureByPartCard.set(refId, row.id);
  }

  let updated = 0;
  let orphaned = 0;
  const ts = Date.now();

  for (const row of orphanRows) {
    const partCardId = String(row.partCardId);
    const nomenclatureId = nomenclatureByPartCard.get(partCardId);
    if (!nomenclatureId) {
      orphaned++;
      console.log(`  ORPHAN: balance ${row.id} (part_card_id=${partCardId}, warehouse=${row.warehouseId}, qty=${row.qty}) — no matching nomenclature`);
      continue;
    }
    if (!isDryRun) {
      await db
        .update(erpRegStockBalance)
        .set({ nomenclatureId, updatedAt: ts })
        .where(eq(erpRegStockBalance.id, row.id));
    }
    updated++;
    console.log(`  ${isDryRun ? 'WOULD UPDATE' : 'UPDATED'}: balance ${row.id} → nomenclature_id=${nomenclatureId}`);
  }

  console.log(`\n  Summary: ${updated} updated, ${orphaned} orphaned (no nomenclature match), ${orphanRows.length} total`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
