/**
 * Merge all references to one warehouseId-code into another. Used to consolidate
 * historical "ghost" warehouseId values (e.g. EAV warehouse_ref UUIDs) into the
 * canonical ones (default / workshop_<code>) from warehouse_locations.
 *
 * Usage:
 *   tsx src/scripts/mergeWarehouseLocations.ts --from <SOURCE_CODE> --to <TARGET_CODE> [--dry-run]
 *
 * Example:
 *   tsx src/scripts/mergeWarehouseLocations.ts \
 *     --from 6f68ba3b-39fc-4419-b0b3-26d80df8bcca --to default
 *   tsx src/scripts/mergeWarehouseLocations.ts \
 *     --from cfcb2984-4190-48f6-a13c-e4db0eef8007 --to workshop_4
 *
 * What it does (inside a single transaction):
 *   - erp_reg_stock_balance: for every source row, if a target row with the
 *     same (nomenclature_id, part_card_id) exists, merges qty/reserved into
 *     target and deletes source. Otherwise rewrites source.warehouse_id=target.
 *     Respects the two UNIQUE indexes (nomenclature_warehouse, part_warehouse).
 *   - erp_reg_stock_movements: rewrites warehouse_id (history is just
 *     re-attributed to the canonical id; the events themselves are unchanged).
 *   - erp_engine_instances: rewrites warehouse_id (engine current location).
 *   - erp_planned_incoming: rewrites warehouse_id (planned arrivals).
 *   - warehouse_locations: soft-deletes the source row (sets deleted_at).
 *
 * Run dry-run first to preview counters. The script aborts if the target
 * code does not exist in warehouse_locations (prevents typos).
 */

import { sql } from 'drizzle-orm';

import { db } from '../database/db.js';

type Report = {
  source: string;
  target: string;
  dryRun: boolean;
  stockBalance: { rewritten: number; merged: number; deletedAsMerged: number };
  stockMovements: { rewritten: number };
  engineInstances: { rewritten: number };
  plannedIncoming: { rewritten: number };
  warehouseLocations: { softDeleted: number };
};

function parseArgs(): { from: string; to: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let from = '';
  let to = '';
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--from') from = String(args[++i] ?? '').trim();
    else if (a === '--to') to = String(args[++i] ?? '').trim();
    else if (a === '--dry-run') dryRun = true;
  }
  if (!from || !to) {
    console.error('Usage: tsx mergeWarehouseLocations.ts --from <CODE> --to <CODE> [--dry-run]');
    process.exit(1);
  }
  if (from === to) {
    console.error('--from and --to must differ');
    process.exit(1);
  }
  return { from, to, dryRun };
}

async function main() {
  const { from, to, dryRun } = parseArgs();
  console.log(`[merge-warehouse] ${dryRun ? 'DRY-RUN' : 'APPLY'}: ${from} → ${to}`);

  // Sanity: target must exist in warehouse_locations.
  const targetRow = (await db.execute<{ id: string; type: string }>(
    sql`SELECT id, type FROM warehouse_locations WHERE code = ${to} AND deleted_at IS NULL LIMIT 1`,
  )).rows[0];
  if (!targetRow) {
    console.error(`[merge-warehouse] target code "${to}" not found in warehouse_locations (or soft-deleted). Refusing.`);
    process.exit(2);
  }
  console.log(`[merge-warehouse] target verified: type=${targetRow.type}`);

  const report: Report = {
    source: from,
    target: to,
    dryRun,
    stockBalance: { rewritten: 0, merged: 0, deletedAsMerged: 0 },
    stockMovements: { rewritten: 0 },
    engineInstances: { rewritten: 0 },
    plannedIncoming: { rewritten: 0 },
    warehouseLocations: { softDeleted: 0 },
  };

  // Detect overlaps in stock_balance up-front (regardless of mode).
  const balanceRows = (await db.execute<{
    id: string;
    nomenclature_id: string | null;
    part_card_id: string | null;
    qty: number;
    reserved_qty: number;
    target_id: string | null;
    target_qty: number | null;
    target_reserved: number | null;
  }>(
    sql`
      SELECT s.id, s.nomenclature_id, s.part_card_id, s.qty, s.reserved_qty,
             t.id AS target_id, t.qty AS target_qty, t.reserved_qty AS target_reserved
        FROM erp_reg_stock_balance s
   LEFT JOIN erp_reg_stock_balance t
          ON t.warehouse_id = ${to}
         AND t.nomenclature_id IS NOT DISTINCT FROM s.nomenclature_id
         AND t.part_card_id    IS NOT DISTINCT FROM s.part_card_id
       WHERE s.warehouse_id = ${from}
    `,
  )).rows as Array<{
    id: string; nomenclature_id: string | null; part_card_id: string | null;
    qty: number; reserved_qty: number;
    target_id: string | null; target_qty: number | null; target_reserved: number | null;
  }>;
  for (const row of balanceRows) {
    if (row.target_id) report.stockBalance.merged += 1;
    else report.stockBalance.rewritten += 1;
  }
  console.log(`[merge-warehouse] stock_balance to process: ${balanceRows.length} (rewrites=${report.stockBalance.rewritten}, merges=${report.stockBalance.merged})`);

  // Count touchable rows in other registers (for the report).
  const mvRows = (await db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM erp_reg_stock_movements WHERE warehouse_id = ${from}`)).rows[0];
  const eiRows = (await db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM erp_engine_instances    WHERE warehouse_id = ${from}`)).rows[0];
  const piRows = (await db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM erp_planned_incoming    WHERE warehouse_id = ${from}`)).rows[0];
  report.stockMovements.rewritten = Number(mvRows?.n ?? 0);
  report.engineInstances.rewritten = Number(eiRows?.n ?? 0);
  report.plannedIncoming.rewritten = Number(piRows?.n ?? 0);

  if (dryRun) {
    console.log('[merge-warehouse] DRY-RUN REPORT:', JSON.stringify(report, null, 2));
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    const ts = Date.now();

    // 1) stock_balance: merge or rewrite, row-by-row.
    for (const row of balanceRows) {
      if (row.target_id) {
        const mergedQty = Number(row.qty) + Number(row.target_qty ?? 0);
        const mergedReserved = Number(row.reserved_qty) + Number(row.target_reserved ?? 0);
        await tx.execute(sql`
          UPDATE erp_reg_stock_balance
             SET qty = ${mergedQty}, reserved_qty = ${mergedReserved}, updated_at = ${ts}
           WHERE id = ${row.target_id}
        `);
        await tx.execute(sql`DELETE FROM erp_reg_stock_balance WHERE id = ${row.id}`);
        report.stockBalance.deletedAsMerged += 1;
      } else {
        await tx.execute(sql`
          UPDATE erp_reg_stock_balance
             SET warehouse_id = ${to}, updated_at = ${ts}
           WHERE id = ${row.id}
        `);
      }
    }

    // 2) stock_movements: bulk rewrite.
    await tx.execute(sql`UPDATE erp_reg_stock_movements SET warehouse_id = ${to} WHERE warehouse_id = ${from}`);

    // 3) engine_instances: bulk rewrite. Bump sync_status to 'pending' so the
    //    ledger picks the change up on next sync (the table has a sync_status column).
    await tx.execute(sql`
      UPDATE erp_engine_instances
         SET warehouse_id = ${to}, sync_status = 'pending'
       WHERE warehouse_id = ${from}
    `);

    // 4) planned_incoming: bulk rewrite. The UNIQUE index (document_header_id,
    //    nomenclature_id, warehouse_id) could theoretically clash; we surface
    //    such errors as transaction failures (no partial state).
    await tx.execute(sql`UPDATE erp_planned_incoming SET warehouse_id = ${to} WHERE warehouse_id = ${from}`);

    // 5) Soft-delete the source row in warehouse_locations.
    const wlRes = (await tx.execute<{ id: string }>(
      sql`
        UPDATE warehouse_locations
           SET deleted_at = ${ts}, is_active = false, updated_at = ${ts}
         WHERE code = ${from} AND deleted_at IS NULL
       RETURNING id
      `,
    )).rows as Array<{ id: string }>;
    report.warehouseLocations.softDeleted = wlRes.length;
  });

  console.log('[merge-warehouse] APPLIED. Final report:', JSON.stringify(report, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[merge-warehouse] fatal:', e);
    process.exit(1);
  });
