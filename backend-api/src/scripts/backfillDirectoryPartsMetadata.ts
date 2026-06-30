/**
 * Backfill `directory_parts.metadata_json` from the residual part-EAV fields that
 * still live in the legacy `parts` store (`entities.type='part'` + `attribute_values`).
 *
 * Phase 3 (parts EAV → directory_parts), Stage B.2. Idempotent UPDATE by id.
 * Dry-run by default — reports what WOULD change without writing.
 *
 * Companion to `backfillDirectoryParts.ts` (Stage B): that script fills the typed
 * spec columns (code/templateId/dimensionsJson/brandLinksJson); this one fills the
 * `metadata_json` blob (shape = shared `PartMetadata`) with everything else. The
 * EAV → metadata mapping lives in `services/partFieldMirror.ts` (shared with the
 * Stage C live mirror so the two never drift).
 *
 * Only UPDATEs existing `directory_parts` rows (run `warehouse:backfill-directory-parts`
 * first if rows are missing — reported as `missingDirectoryRow`). Never clobbers the
 * spec columns; touches only `metadata_json` + `updated_at`.
 *
 * Usage:
 *   tsx src/scripts/backfillDirectoryPartsMetadata.ts            # dry-run (read-only)
 *   tsx src/scripts/backfillDirectoryPartsMetadata.ts --apply    # write changes
 */

import { type PartCustomFieldDef } from '@matricarmz/shared';
import { sql } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import {
  buildPartMetadataBlob,
  isKnownPartCode,
  serializePartMetadataBlob,
  type PartCustomDefMap,
} from '../services/partFieldMirror.js';

const APPLY = process.argv.includes('--apply');

type AttrRow = { entity_id: string; code: string; value_json: string | null };
type DefRow = { code: string; name: string; data_type: string; sort_order: number | null };

async function main() {
  // 1) all active parts
  const partsRes = await db.execute<{ id: string }>(
    sql.raw(`
      select e.id from entities e
        join entity_types t on t.id = e.type_id
       where t.code = 'part' and e.deleted_at is null
    `),
  );
  const partIds = (partsRes.rows as Array<{ id: string }>).map((r) => r.id);

  // 2) every part attribute value (all codes — custom needs the full set)
  const attrsRes = await db.execute<AttrRow>(
    sql.raw(`
      select av.entity_id, ad.code, av.value_json
        from attribute_values av
        join attribute_defs ad on ad.id = av.attribute_def_id
        join entities e on e.id = av.entity_id
        join entity_types t on t.id = e.type_id
       where t.code = 'part' and e.deleted_at is null and av.deleted_at is null
    `),
  );
  const attrsByPart = new Map<string, Record<string, string | null>>();
  for (const r of attrsRes.rows as AttrRow[]) {
    const m = attrsByPart.get(r.entity_id) ?? {};
    m[r.code] = r.value_json;
    attrsByPart.set(r.entity_id, m);
  }

  // 3) part-type attribute defs → customDefs source + global-custom-defs audit (Решение B)
  const defsRes = await db.execute<DefRow>(
    sql.raw(`
      select ad.code, ad.name, ad.data_type, ad.sort_order
        from attribute_defs ad
        join entity_types t on t.id = ad.entity_type_id
       where t.code = 'part' and ad.deleted_at is null
    `),
  );
  const customDefByCode: PartCustomDefMap = new Map<string, PartCustomFieldDef>();
  for (const r of defsRes.rows as DefRow[]) {
    if (isKnownPartCode(r.code)) continue;
    customDefByCode.set(r.code, {
      code: r.code,
      name: String(r.name),
      dataType: String(r.data_type),
      ...(r.sort_order != null ? { sortOrder: Number(r.sort_order) } : {}),
    });
  }

  // 4) existing directory_parts (metadata is UPDATE-only — never insert partial rows)
  const existRes = await db.execute<{ id: string }>(
    sql.raw(`select id from directory_parts where deleted_at is null`),
  );
  const existingIds = new Set((existRes.rows as Array<{ id: string }>).map((r) => r.id));

  // global-custom-defs usage: how many parts carry each custom code (per-part vs global risk)
  const customUsage = new Map<string, number>();
  for (const code of customDefByCode.keys()) customUsage.set(code, 0);

  const report = {
    parts: partIds.length,
    withDirectoryRow: 0,
    missingDirectoryRow: [] as string[],
    toUpdate: 0,
    withDescription: 0,
    withSupplier: 0,
    withAttachments: 0,
    withStatusFlags: 0,
    withCustom: 0,
    globalCustomDefs: {
      count: customDefByCode.size,
      codes: [] as Array<{ code: string; name: string; dataType: string; usedByParts: number }>,
    },
  };
  const now = Date.now();

  for (const id of partIds) {
    const a = attrsByPart.get(id) ?? {};
    const meta = buildPartMetadataBlob(a, customDefByCode);

    // tally custom-code usage regardless of whether the directory row exists
    if (meta.custom) {
      for (const code of Object.keys(meta.custom)) {
        if (customUsage.has(code)) customUsage.set(code, (customUsage.get(code) ?? 0) + 1);
      }
    }

    if (existingIds.has(id)) report.withDirectoryRow += 1;
    else report.missingDirectoryRow.push(id);

    if (meta.description) report.withDescription += 1;
    if (meta.supplierId || meta.supplierLegacy) report.withSupplier += 1;
    if (meta.drawings || meta.techDocs || meta.attachments) report.withAttachments += 1;
    if (meta.statusFlags) report.withStatusFlags += 1;
    if (meta.custom) report.withCustom += 1;

    const metadataJson = serializePartMetadataBlob(meta);
    if (!metadataJson || !existingIds.has(id)) continue;

    report.toUpdate += 1;
    if (APPLY) {
      await db.execute(
        sql`update directory_parts
               set metadata_json = ${metadataJson}, updated_at = ${now}
             where id = ${id} and deleted_at is null`,
      );
    }
  }

  report.globalCustomDefs.codes = [...customDefByCode.values()]
    .map((d) => ({ code: d.code, name: d.name, dataType: d.dataType, usedByParts: customUsage.get(d.code) ?? 0 }))
    .sort((x, y) => y.usedByParts - x.usedByParts);

  console.log(
    '[backfill directory_parts metadata]',
    APPLY ? 'APPLIED' : 'DRY-RUN',
    JSON.stringify(report, null, 2),
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
