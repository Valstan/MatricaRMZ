/**
 * Backfill `directory_parts` from legacy `entities.type='part'` + part-spec EAV.
 *
 * Phase 2 (parts→nomenclature, Variant A), Stage B. Idempotent upsert by id.
 * Dry-run by default — reports what WOULD change without writing.
 *
 * Fills the spec columns added in migration 0059:
 *   - code             ← attribute `article`
 *   - template_id      ← attribute `part_template_id`
 *   - dimensions_json  ← attribute `dimensions` (JSON array, stored verbatim)
 *   - brand_links_json ← entities.type='part_engine_brand' linked to the part
 *
 * The EAV → spec-column mapping lives in `services/partFieldMirror.ts` (shared with
 * the Stage C live mirror so the two never drift).
 *
 * Usage:
 *   tsx src/scripts/backfillDirectoryParts.ts            # dry-run (read-only)
 *   tsx src/scripts/backfillDirectoryParts.ts --apply    # write changes
 */

import { sql } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { asText, buildPartSpecColumns, parseJsonText } from '../services/partFieldMirror.js';

const APPLY = process.argv.includes('--apply');

type AttrRow = { entity_id: string; code: string; value_json: string | null };
type LinkRow = { link_id: string; code: string; value_json: string | null };

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

  // 2) relevant attribute values for all parts in one pass
  const attrsRes = await db.execute<AttrRow>(
    sql.raw(`
      select av.entity_id, ad.code, av.value_json
        from attribute_values av
        join attribute_defs ad on ad.id = av.attribute_def_id
        join entities e on e.id = av.entity_id
        join entity_types t on t.id = e.type_id
       where t.code = 'part' and e.deleted_at is null and av.deleted_at is null
         and ad.code in ('name','article','part_template_id','dimensions')
    `),
  );
  const attrsByPart = new Map<string, Record<string, string | null>>();
  for (const r of attrsRes.rows as AttrRow[]) {
    const m = attrsByPart.get(r.entity_id) ?? {};
    m[r.code] = r.value_json;
    attrsByPart.set(r.entity_id, m);
  }

  // 3) brand-link entities (type='part_engine_brand') with their 4 attributes
  const linksRes = await db.execute<LinkRow>(
    sql.raw(`
      select le.id as link_id, ad.code, av.value_json
        from entities le
        join entity_types lt on lt.id = le.type_id
        join attribute_values av on av.entity_id = le.id and av.deleted_at is null
        join attribute_defs ad on ad.id = av.attribute_def_id
       where lt.code = 'part_engine_brand' and le.deleted_at is null
         and ad.code in ('part_id','engine_brand_id','assembly_unit_number','quantity')
    `),
  );
  const linkAttrs = new Map<string, Record<string, string | null>>();
  for (const r of linksRes.rows as LinkRow[]) {
    const m = linkAttrs.get(r.link_id) ?? {};
    m[r.code] = r.value_json;
    linkAttrs.set(r.link_id, m);
  }
  const brandLinksByPart = new Map<string, Array<Record<string, unknown>>>();
  for (const [linkId, m] of linkAttrs) {
    const partId = asText(m['part_id'] ?? null);
    if (!partId) continue;
    const arr = brandLinksByPart.get(partId) ?? [];
    arr.push({
      id: linkId,
      engineBrandId: asText(m['engine_brand_id'] ?? null),
      assemblyUnitNumber: asText(m['assembly_unit_number'] ?? null),
      quantity: Number(parseJsonText(m['quantity'] ?? null) ?? 0) || 0,
    });
    brandLinksByPart.set(partId, arr);
  }

  // 4) existing directory_parts
  const existRes = await db.execute<{ id: string }>(
    sql.raw(`select id from directory_parts where deleted_at is null`),
  );
  const existingIds = new Set((existRes.rows as Array<{ id: string }>).map((r) => r.id));

  const report = {
    parts: partIds.length,
    toInsert: 0,
    toUpdate: 0,
    withBrandLinks: 0,
    withDimensions: 0,
    withTemplate: 0,
    skippedNoName: [] as string[],
  };
  const now = Date.now();

  for (const id of partIds) {
    const a = attrsByPart.get(id) ?? {};
    const { name, code, templateId, dimensionsJson } = buildPartSpecColumns(a);
    if (!name) {
      report.skippedNoName.push(id);
      continue;
    }
    const links = brandLinksByPart.get(id) ?? [];
    const brandLinksJson = links.length ? JSON.stringify(links) : null;

    if (dimensionsJson) report.withDimensions += 1;
    if (templateId) report.withTemplate += 1;
    if (brandLinksJson) report.withBrandLinks += 1;
    if (existingIds.has(id)) report.toUpdate += 1;
    else report.toInsert += 1;

    if (APPLY) {
      await db.execute(
        sql`insert into directory_parts
              (id, name, is_active, code, template_id, dimensions_json, brand_links_json, created_at, updated_at)
            values
              (${id}, ${name}, true, ${code}, ${templateId}, ${dimensionsJson}, ${brandLinksJson}, ${now}, ${now})
            on conflict (id) do update set
              name = excluded.name,
              code = excluded.code,
              template_id = excluded.template_id,
              dimensions_json = excluded.dimensions_json,
              brand_links_json = excluded.brand_links_json,
              updated_at = ${now},
              deleted_at = null`,
      );
    }
  }

  console.log('[backfill directory_parts]', APPLY ? 'APPLIED' : 'DRY-RUN', JSON.stringify(report, null, 2));
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
