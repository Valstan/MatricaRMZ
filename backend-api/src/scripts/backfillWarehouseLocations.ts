/**
 * Backfill the `warehouse_locations` registry from existing data.
 *
 * Scans all places where `warehouseId` is stored as free-form text and creates
 * matching rows in `warehouse_locations`. Idempotent: re-running picks up only
 * new warehouseId values.
 *
 * Usage:
 *   tsx src/scripts/backfillWarehouseLocations.ts            # apply changes
 *   tsx src/scripts/backfillWarehouseLocations.ts --dry-run  # only report what would change
 *
 * Sources scanned (all merged into a single distinct warehouseId set):
 *   - erp_reg_stock_balance.warehouse_id
 *   - erp_reg_stock_movements.warehouse_id
 *   - erp_engine_instances.warehouse_id
 *   - erp_planned_incoming.warehouse_id
 *
 * Classification:
 *   - matches SYSTEM_WAREHOUSE_LOCATIONS or 'default'  → type='system' (handled by seedSystemLocations)
 *   - matches `workshop_<code>`                         → type='workshop', workshop_id resolved by code
 *   - looks like a UUID and matches directory_workshops → type='workshop', code rewritten to `workshop_<code>`
 *   - everything else                                   → type='regular', name=code
 *
 * Does NOT modify the registers themselves. (The legacy `warehouse_id` text column
 * was dropped from the registers in migration 0057, so ghost-UUID normalization is
 * no longer applicable.)
 */

import { sql } from 'drizzle-orm';

import { db } from '../database/db.js';
import { seedSystemLocations, syncFromWorkshop } from '../services/warehouseLocationsService.js';
import { warehouseLocations, directoryWorkshops } from '../database/schema.js';
import { randomUUID } from 'node:crypto';

type Report = {
  scanned: number;
  systemSeeded: number;
  workshopsLinkedExisting: number;
  workshopsLinkedByUuid: number;
  regularsInserted: number;
  unknownSkipped: string[];
};

const SYSTEM_CODES = new Set(['default', 'repair_fund', 'scrap', 'assembly_in_progress']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function collectDistinctWarehouseIds(): Promise<string[]> {
  const sources = [
    'erp_reg_stock_balance',
    'erp_reg_stock_movements',
    'erp_engine_instances',
    'erp_planned_incoming',
  ];
  const all = new Set<string>();
  for (const table of sources) {
    try {
      // Using raw SQL because the columns are the same name across tables;
      // drizzle would require importing each table separately.
      const rows = await db.execute<{ warehouse_id: string }>(
        sql.raw(`SELECT DISTINCT warehouse_id FROM ${table} WHERE warehouse_id IS NOT NULL AND warehouse_id <> ''`),
      );
      for (const row of rows.rows as Array<{ warehouse_id: string }>) {
        all.add(String(row.warehouse_id).trim());
      }
    } catch (e) {
      console.warn(`[backfill] skipped ${table}:`, e);
    }
  }
  return Array.from(all);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[backfill] mode: ${dryRun ? 'dry-run' : 'apply'}`);

  const report: Report = {
    scanned: 0,
    systemSeeded: 0,
    workshopsLinkedExisting: 0,
    workshopsLinkedByUuid: 0,
    regularsInserted: 0,
    unknownSkipped: [],
  };

  // 1) Seed system rows (idempotent).
  if (!dryRun) {
    const seedRes = await seedSystemLocations();
    if (seedRes.ok) report.systemSeeded = seedRes.created;
    else console.error('[backfill] seedSystemLocations failed:', seedRes.error);
  } else {
    console.log('[backfill] dry-run: skip seedSystemLocations');
  }

  // 1b) Mirror every existing workshop into warehouse_locations.
  // Without this, workshops without any movements yet would never appear in the
  // central registry (auto-sync from workshopsService only triggers on upsert/delete).
  {
    const wsRows = await db
      .select({ id: directoryWorkshops.id, code: directoryWorkshops.code, name: directoryWorkshops.name, isActive: directoryWorkshops.isActive, displayOrder: directoryWorkshops.displayOrder, deletedAt: directoryWorkshops.deletedAt })
      .from(directoryWorkshops);
    let workshopsSeeded = 0;
    for (const ws of wsRows) {
      const isDeleted = ws.deletedAt != null;
      if (!dryRun) {
        await syncFromWorkshop({
          workshopId: String(ws.id),
          code: String(ws.code),
          name: String(ws.name),
          isActive: Boolean(ws.isActive),
          sortOrder: Number(ws.displayOrder ?? 0),
          deleted: isDeleted,
        });
      }
      workshopsSeeded += 1;
    }
    console.log(`[backfill] mirrored ${workshopsSeeded} workshop(s) into warehouse_locations`);
  }

  // 2) Distinct warehouseIds across all registers.
  const ids = await collectDistinctWarehouseIds();
  report.scanned = ids.length;
  console.log(`[backfill] scanned ${ids.length} distinct warehouseId values`);

  // 3) Existing warehouse_locations.code set.
  const existingCodes = new Set<string>();
  const existingByCode = new Map<string, string>();
  const existingRows = await db.select({ id: warehouseLocations.id, code: warehouseLocations.code })
    .from(warehouseLocations);
  for (const row of existingRows) {
    existingCodes.add(String(row.code));
    existingByCode.set(String(row.code), String(row.id));
  }

  // 4) Workshops by id and by code.
  const wsRows = await db
    .select({ id: directoryWorkshops.id, code: directoryWorkshops.code, name: directoryWorkshops.name, isActive: directoryWorkshops.isActive, displayOrder: directoryWorkshops.displayOrder })
    .from(directoryWorkshops);
  const wsById = new Map<string, typeof wsRows[number]>();
  const wsByCode = new Map<string, typeof wsRows[number]>();
  for (const row of wsRows) {
    wsById.set(String(row.id), row);
    wsByCode.set(String(row.code), row);
  }

  // 5) Classify each warehouseId.
  for (const wid of ids) {
    if (SYSTEM_CODES.has(wid)) continue; // already seeded

    // workshop_<code>
    if (wid.startsWith('workshop_')) {
      const code = wid.slice('workshop_'.length);
      const ws = wsByCode.get(code);
      if (ws) {
        if (!dryRun) {
          await syncFromWorkshop({
            workshopId: String(ws.id),
            code: String(ws.code),
            name: String(ws.name),
            isActive: Boolean(ws.isActive),
            sortOrder: Number(ws.displayOrder ?? 0),
            deleted: false,
          });
        }
        report.workshopsLinkedExisting += 1;
        continue;
      }
      // workshop_<code> referencing a deleted/unknown workshop — treat as regular orphan.
      if (!existingCodes.has(wid)) {
        if (!dryRun) {
          const ts = Date.now();
          await db.insert(warehouseLocations).values({
            id: randomUUID(),
            type: 'regular',
            code: wid,
            name: `Цех ${code} (источник не найден)`,
            workshopId: null,
            isActive: false,
            sortOrder: 9000,
            metadataJson: JSON.stringify({ orphan: true, reason: 'workshop_code_not_in_directory' }),
            createdAt: ts,
            updatedAt: ts,
          });
        }
        report.regularsInserted += 1;
      }
      continue;
    }

    // Raw UUID — could be a workshop id (historical) or an entity from EAV warehouse_ref.
    if (UUID_RE.test(wid)) {
      const ws = wsById.get(wid);
      if (ws) {
        if (!dryRun) {
          await syncFromWorkshop({
            workshopId: String(ws.id),
            code: String(ws.code),
            name: String(ws.name),
            isActive: Boolean(ws.isActive),
            sortOrder: Number(ws.displayOrder ?? 0),
            deleted: false,
          });
        }
        report.workshopsLinkedByUuid += 1;
        continue;
      }
      // Unknown UUID — register as regular with the UUID as code, name unknown.
      if (!existingCodes.has(wid)) {
        if (!dryRun) {
          const ts = Date.now();
          await db.insert(warehouseLocations).values({
            id: randomUUID(),
            type: 'regular',
            code: wid,
            name: `Локация ${wid.slice(0, 8)}…`,
            workshopId: null,
            isActive: true,
            sortOrder: 8000,
            metadataJson: JSON.stringify({ historical: true, source: 'register-scan' }),
            createdAt: ts,
            updatedAt: ts,
          });
        }
        report.regularsInserted += 1;
        report.unknownSkipped.push(wid);
      }
      continue;
    }

    // Anything else — free-form string. Treat as regular.
    if (!existingCodes.has(wid)) {
      if (!dryRun) {
        const ts = Date.now();
        await db.insert(warehouseLocations).values({
          id: randomUUID(),
          type: 'regular',
          code: wid,
          name: wid,
          workshopId: null,
          isActive: true,
          sortOrder: 7000,
          metadataJson: null,
          createdAt: ts,
          updatedAt: ts,
        });
      }
      report.regularsInserted += 1;
    }
  }

  console.log('[backfill] report:', JSON.stringify(report, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[backfill] fatal:', e);
    process.exit(1);
  });
