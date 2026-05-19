/**
 * Backfill script: for every erp_reg_stock_movements row tied to a parts-movement
 * document (engine_dismantling / repair_recovery / assembly_consumption / assembly_return)
 * where engine_id is NULL, resolve engine_id from the header's payload_json.engineId.
 *
 * Safe to run repeatedly. Idempotent: only updates rows with NULL engine_id.
 *
 * Usage:
 *   npx tsx src/scripts/backfillMovementEngineId.ts            # live
 *   npx tsx src/scripts/backfillMovementEngineId.ts --dry-run  # report only
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { erpDocumentHeaders, erpRegStockMovements } from '../database/schema.js';

const isDryRun = process.argv.includes('--dry-run');

const TARGET_DOC_TYPES = [
  'engine_dismantling',
  'repair_recovery',
  'assembly_consumption',
  'assembly_return',
] as const;

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function main() {
  console.log(`[backfill-movement-engine-id] ${isDryRun ? 'DRY RUN' : 'LIVE RUN'}`);

  const headers = await db
    .select({
      id: erpDocumentHeaders.id,
      docType: erpDocumentHeaders.docType,
      payloadJson: erpDocumentHeaders.payloadJson,
    })
    .from(erpDocumentHeaders)
    .where(inArray(erpDocumentHeaders.docType, TARGET_DOC_TYPES as unknown as string[]));

  const engineIdByHeader = new Map<string, string>();
  for (const header of headers) {
    const payload = parseJsonObject(header.payloadJson);
    const engineId = String(payload.engineId ?? '').trim();
    if (engineId) engineIdByHeader.set(String(header.id), engineId);
  }
  console.log(`  Documents scanned: ${headers.length}, with engineId in payload: ${engineIdByHeader.size}`);

  if (engineIdByHeader.size === 0) {
    console.log('  Nothing to backfill.');
    await pool.end();
    return;
  }

  const headerIds = Array.from(engineIdByHeader.keys());
  const movements = await db
    .select({ id: erpRegStockMovements.id, documentHeaderId: erpRegStockMovements.documentHeaderId })
    .from(erpRegStockMovements)
    .where(and(inArray(erpRegStockMovements.documentHeaderId, headerIds), isNull(erpRegStockMovements.engineId)));

  console.log(`  Candidate movements (header in scope AND engine_id NULL): ${movements.length}`);

  if (movements.length === 0) {
    console.log('  Nothing to update.');
    await pool.end();
    return;
  }

  let updated = 0;
  let skipped = 0;
  for (const movement of movements) {
    const headerId = String(movement.documentHeaderId ?? '');
    const engineId = engineIdByHeader.get(headerId);
    if (!engineId) {
      skipped += 1;
      continue;
    }
    if (!isDryRun) {
      await db.update(erpRegStockMovements).set({ engineId }).where(eq(erpRegStockMovements.id, movement.id));
    }
    updated += 1;
  }
  console.log(`  Updated: ${updated}, skipped: ${skipped}`);
  if (isDryRun) console.log('  (dry-run — no rows actually changed)');

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
