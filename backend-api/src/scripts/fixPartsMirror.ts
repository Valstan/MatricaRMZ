import 'dotenv/config';

import { pool } from '../database/db.js';

// Restores parts↔nomenclature mirror integrity (Phase 1 Directories→Nomenclature).
//
// Auto-fixable categories (use same logic as upsertWarehouseNomenclature auto-backfill,
// see warehouseService.ts:1531-1609):
//   A. entities (type=part, active) missing directory_parts row
//      → INSERT directory_parts(id, name from attribute_values 'name', is_active=true)
//   C. erp_nomenclature with directory_kind='part' and broken directory_ref_id,
//      where directory_ref_id matches an active entities(type=part) row
//      → INSERT directory_parts(id, name from attribute_values 'name', is_active=true)
//        For soft-deleted directory_parts: undelete (deleted_at=null).
//
// NOT auto-fixed (requires manual review):
//   B. directory_parts without entities (type=part) — mirror without source.
//      Cause is usually corrupt history; safe action depends on intent.
//
// Usage:
//   pnpm -F @matricarmz/backend-api warehouse:fix-parts-mirror              # dry-run, default
//   pnpm -F @matricarmz/backend-api warehouse:fix-parts-mirror -- --apply

type FixRow = {
  id: string;
  name: string;
  source: 'category-A' | 'category-C-missing' | 'category-C-soft-deleted';
};

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function extractName(rawJson: unknown): string | null {
  if (rawJson == null) return null;
  const raw = String(rawJson).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string') return parsed.trim() || null;
    if (parsed && typeof parsed === 'object') {
      const value = (parsed as { value?: unknown }).value;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    if (!raw.startsWith('{') && !raw.startsWith('[')) return raw;
  }
  return null;
}

async function getPartEntityTypeId(): Promise<string | null> {
  const res = await pool.query("select id from entity_types where code = 'part' and deleted_at is null limit 1");
  return res.rows[0]?.id ? String(res.rows[0].id) : null;
}

async function getPartNameAttrDefId(partTypeId: string): Promise<string | null> {
  const res = await pool.query(
    "select id from attribute_defs where entity_type_id = $1 and code = 'name' and deleted_at is null limit 1",
    [partTypeId],
  );
  return res.rows[0]?.id ? String(res.rows[0].id) : null;
}

async function loadCategoryAFixCandidates(
  partTypeId: string,
  partNameAttrDefId: string | null,
): Promise<FixRow[]> {
  const sql = partNameAttrDefId
    ? `select e.id, av.value_json as name_json
       from entities e
       left join directory_parts dp on dp.id = e.id
       left join attribute_values av
         on av.entity_id = e.id
        and av.attribute_def_id = $2
        and av.deleted_at is null
       where e.type_id = $1 and e.deleted_at is null
         and dp.id is null`
    : `select e.id, null::text as name_json
       from entities e
       left join directory_parts dp on dp.id = e.id
       where e.type_id = $1 and e.deleted_at is null
         and dp.id is null`;
  const params = partNameAttrDefId ? [partTypeId, partNameAttrDefId] : [partTypeId];
  const res = await pool.query(sql, params);
  return res.rows.map((row) => ({
    id: String(row.id),
    name: extractName(row.name_json) ?? 'Без названия',
    source: 'category-A' as const,
  }));
}

async function loadCategoryCFixCandidates(partTypeId: string, partNameAttrDefId: string | null): Promise<FixRow[]> {
  const sql = partNameAttrDefId
    ? `select n.directory_ref_id as id,
              case when dp.id is null then 'missing' else 'soft-deleted' end as kind,
              coalesce(dp.name, av.value_json::text, n.name) as name_json
       from erp_nomenclature n
       left join directory_parts dp on dp.id = n.directory_ref_id
       inner join entities e on e.id = n.directory_ref_id and e.type_id = $1 and e.deleted_at is null
       left join attribute_values av
         on av.entity_id = n.directory_ref_id
        and av.attribute_def_id = $2
        and av.deleted_at is null
       where n.directory_kind = 'part'
         and n.deleted_at is null
         and n.directory_ref_id is not null
         and (dp.id is null or dp.deleted_at is not null)`
    : `select n.directory_ref_id as id,
              case when dp.id is null then 'missing' else 'soft-deleted' end as kind,
              coalesce(dp.name, n.name) as name_json
       from erp_nomenclature n
       left join directory_parts dp on dp.id = n.directory_ref_id
       inner join entities e on e.id = n.directory_ref_id and e.type_id = $1 and e.deleted_at is null
       where n.directory_kind = 'part'
         and n.deleted_at is null
         and n.directory_ref_id is not null
         and (dp.id is null or dp.deleted_at is not null)`;
  const params = partNameAttrDefId ? [partTypeId, partNameAttrDefId] : [partTypeId];
  const res = await pool.query(sql, params);
  const seen = new Set<string>();
  const out: FixRow[] = [];
  for (const row of res.rows) {
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = String(row.kind);
    out.push({
      id,
      name: extractName(row.name_json) ?? 'Без названия',
      source: kind === 'soft-deleted' ? ('category-C-soft-deleted' as const) : ('category-C-missing' as const),
    });
  }
  return out;
}

async function applyFix(rows: FixRow[]): Promise<{ inserted: number; undeleted: number }> {
  let inserted = 0;
  let undeleted = 0;
  const ts = Date.now();
  for (const row of rows) {
    if (row.source === 'category-C-soft-deleted') {
      const res = await pool.query(
        `update directory_parts
         set deleted_at = null, updated_at = $2, is_active = true
         where id = $1 and deleted_at is not null`,
        [row.id, ts],
      );
      if ((res.rowCount ?? 0) > 0) undeleted += 1;
    } else {
      const res = await pool.query(
        `insert into directory_parts (id, name, is_active, metadata_json, deprecated_at, created_at, updated_at, deleted_at)
         values ($1, $2, true, null, null, $3, $3, null)
         on conflict (id) do nothing`,
        [row.id, row.name, ts],
      );
      if ((res.rowCount ?? 0) > 0) inserted += 1;
    }
  }
  return { inserted, undeleted };
}

async function countCategoryB(partTypeId: string): Promise<number> {
  const res = await pool.query(
    `select count(*)::int as n
     from directory_parts dp
     left join entities e on e.id = dp.id and e.type_id = $1
     where dp.deleted_at is null
       and (e.id is null or e.deleted_at is not null)`,
    [partTypeId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function main() {
  const apply = hasFlag('--apply');
  const help = hasFlag('--help') || hasFlag('-h');
  if (help) {
    console.log(
      [
        'Usage: tsx src/scripts/fixPartsMirror.ts [--apply]',
        '',
        '  --apply   Actually write changes (insert/undelete directory_parts).',
        '            Without this flag the script only prints what it would do (dry-run).',
      ].join('\n'),
    );
    await pool.end();
    return;
  }
  try {
    const partTypeId = await getPartEntityTypeId();
    if (!partTypeId) {
      console.log("entity_types.code='part' not registered yet — nothing to fix.");
      return;
    }
    const partNameAttrDefId = await getPartNameAttrDefId(partTypeId);
    const [categoryAFixes, categoryCFixes, categoryBCount] = await Promise.all([
      loadCategoryAFixCandidates(partTypeId, partNameAttrDefId),
      loadCategoryCFixCandidates(partTypeId, partNameAttrDefId),
      countCategoryB(partTypeId),
    ]);
    const fixes = [...categoryAFixes, ...categoryCFixes];
    console.log(`Plan: ${categoryAFixes.length} (A: missing dp for entity)`);
    console.log(`      ${categoryCFixes.filter((r) => r.source === 'category-C-missing').length} (C: nomenclature → insert dp)`);
    console.log(`      ${categoryCFixes.filter((r) => r.source === 'category-C-soft-deleted').length} (C: nomenclature → undelete dp)`);
    if (categoryBCount > 0) {
      console.log('');
      console.log(
        `WARNING: ${categoryBCount} directory_parts rows have no matching entity (category B).\n` +
          '         Not auto-fixed — review manually with auditPartsMirror.ts.',
      );
    }
    if (fixes.length === 0) {
      console.log('Nothing to do.');
      return;
    }
    if (!apply) {
      console.log('');
      console.log('Dry-run sample (first 10):');
      for (const row of fixes.slice(0, 10)) {
        const action = row.source === 'category-C-soft-deleted' ? 'undelete' : 'insert';
        console.log(`  - ${action} directory_parts ${row.id} "${row.name}" (${row.source})`);
      }
      console.log('');
      console.log('Re-run with --apply to write changes.');
      return;
    }
    const result = await applyFix(fixes);
    console.log('');
    console.log(`Applied: inserted=${result.inserted}, undeleted=${result.undeleted}`);
  } finally {
    await pool.end();
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(2);
});
