/**
 * Backfill `directory_engine_brands` from legacy `entities.type='engine_brand'`.
 *
 * Phase 2 (parts→nomenclature, Variant A), Stage B. Idempotent upsert by id.
 * Dry-run by default — reports what WOULD change without writing.
 *
 * Usage:
 *   tsx src/scripts/backfillDirectoryEngineBrands.ts            # dry-run (read-only)
 *   tsx src/scripts/backfillDirectoryEngineBrands.ts --apply    # write changes
 */

import { sql } from 'drizzle-orm';

import { db, pool } from '../database/db.js';

const APPLY = process.argv.includes('--apply');

type SrcRow = { id: string; name: string | null };

function parseJsonText(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function loadSourceBrands(): Promise<SrcRow[]> {
  const res = await db.execute<SrcRow>(
    sql.raw(`
      select e.id,
             (select av.value_json
                from attribute_values av
                join attribute_defs ad on ad.id = av.attribute_def_id
               where av.entity_id = e.id and ad.code = 'name' and av.deleted_at is null
               limit 1) as name
        from entities e
        join entity_types t on t.id = e.type_id
       where t.code = 'engine_brand' and e.deleted_at is null
    `),
  );
  return (res.rows as SrcRow[]).map((r) => ({ id: r.id, name: r.name }));
}

async function main() {
  const src = await loadSourceBrands();
  const existing = await db.execute<{ id: string }>(
    sql.raw(`select id from directory_engine_brands where deleted_at is null`),
  );
  const existingIds = new Set((existing.rows as Array<{ id: string }>).map((r) => r.id));

  const report = { source: src.length, toInsert: 0, toUpdate: 0, skippedNoName: [] as string[] };
  const now = Date.now();

  for (const row of src) {
    const name = String(parseJsonText(row.name) ?? '').trim();
    if (!name) {
      report.skippedNoName.push(row.id);
      continue;
    }
    const isUpdate = existingIds.has(row.id);
    if (isUpdate) report.toUpdate += 1;
    else report.toInsert += 1;

    if (APPLY) {
      await db.execute(
        sql`insert into directory_engine_brands (id, name, is_active, created_at, updated_at)
            values (${row.id}, ${name}, true, ${now}, ${now})
            on conflict (id) do update set name = excluded.name, updated_at = ${now}, deleted_at = null`,
      );
    }
  }

  console.log('[backfill directory_engine_brands]', APPLY ? 'APPLIED' : 'DRY-RUN', JSON.stringify(report, null, 2));
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
