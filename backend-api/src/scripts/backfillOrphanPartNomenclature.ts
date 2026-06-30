import 'dotenv/config';

import { backfillMissingPartNomenclature } from '../services/warehouseService.js';
import { pool } from '../database/db.js';

// Phase 2 (parts→nomenclature), pre-Stage-E.2-deploy data step. Creates an
// erp_nomenclature row for any directory_parts that lacks one (orphans), via the
// signed upsert path (see warehouseService.backfillMissingPartNomenclature).
// Without this, the openPart→openNomenclature redirect shows «Позиция не найдена»
// for orphan parts. CREATE-only, idempotent.
//
// Usage:
//   pnpm -F @matricarmz/backend-api warehouse:backfill-orphan-part-nomenclature            # dry-run (default)
//   pnpm -F @matricarmz/backend-api warehouse:backfill-orphan-part-nomenclature -- --apply # write

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const apply = hasFlag('--apply');
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(
      [
        'Usage: tsx src/scripts/backfillOrphanPartNomenclature.ts [--apply]',
        '',
        '  --apply   Create the missing erp_nomenclature rows (signed upsert path).',
        '            Without this flag the script only lists orphans (dry-run).',
      ].join('\n'),
    );
    await pool.end();
    return;
  }
  try {
    const res = await backfillMissingPartNomenclature({ apply });
    console.log(`Orphan directory_parts without erp_nomenclature: ${res.orphans.length}`);
    for (const o of res.orphans) {
      console.log(`  - ${o.id} "${o.name}" code=${o.code ?? '(none)'}`);
    }
    if (!apply) {
      console.log('');
      console.log('Dry-run. Re-run with --apply to create the nomenclature rows.');
      return;
    }
    console.log('');
    console.log(`Applied: created ${res.created.length} nomenclature row(s)${res.created.length ? `: ${res.created.join(', ')}` : ''}`);
    if (res.failed.length > 0) {
      console.log(`Failed: ${res.failed.length}`);
      for (const f of res.failed) console.log(`  - ${f.id}: ${f.error}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(2);
});
