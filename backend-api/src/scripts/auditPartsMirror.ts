import 'dotenv/config';

import { pool } from '../database/db.js';

// Read-only audit of parts↔nomenclature mirror integrity (Phase 1 Directories→Nomenclature).
//
// Three orphan categories:
//   A. entities (type=part, active) without matching directory_parts row
//   B. directory_parts (active) without matching entities (type=part, active)
//   C. erp_nomenclature (directory_kind='part', active) with directory_ref_id pointing
//      to a missing or soft-deleted directory_parts row
//
// Usage:
//   pnpm -F @matricarmz/backend-api warehouse:audit-parts-mirror
//   pnpm -F @matricarmz/backend-api warehouse:audit-parts-mirror -- --samples 20
//   pnpm -F @matricarmz/backend-api warehouse:audit-parts-mirror -- --json
//
// Exit code: 0 when all categories have zero orphans, 1 otherwise (CI-friendly).

type SampleA = { id: string; reason: string; name: string | null };
type SampleB = { id: string; name: string; reason: string };
type SampleC = {
  id: string;
  code: string;
  name: string;
  directoryRefId: string;
  reason: string;
};
type CategoryResult<S> = { total: number; samples: S[] };
type AuditReport = {
  partTypeId: string | null;
  categoryA: CategoryResult<SampleA>;
  categoryB: CategoryResult<SampleB>;
  categoryC: CategoryResult<SampleC>;
};

function parseArgs(argv: string[]): { samples: number; json: boolean; help: boolean } {
  const out = { samples: 10, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--samples') {
      const next = Number(argv[i + 1]);
      if (Number.isFinite(next) && next >= 0) {
        out.samples = Math.trunc(next);
        i += 1;
      }
    } else if (arg.startsWith('--samples=')) {
      const next = Number(arg.slice('--samples='.length));
      if (Number.isFinite(next) && next >= 0) out.samples = Math.trunc(next);
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
}

function printHelp() {
  console.log(
    [
      'Usage: tsx src/scripts/auditPartsMirror.ts [--samples N] [--json]',
      '',
      '  --samples N   How many example rows to print per category (default 10, 0 to disable).',
      '  --json        Emit machine-readable JSON instead of a human-formatted report.',
      '',
      'Exits with code 1 if any orphan rows are found.',
    ].join('\n'),
  );
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

async function auditCategoryA(
  partTypeId: string,
  partNameAttrDefId: string | null,
  sampleLimit: number,
): Promise<CategoryResult<SampleA>> {
  const countRes = await pool.query(
    `select count(*)::int as n
     from entities e
     left join directory_parts dp on dp.id = e.id
     where e.type_id = $1 and e.deleted_at is null
       and (dp.id is null or dp.deleted_at is not null)`,
    [partTypeId],
  );
  const total = Number(countRes.rows[0]?.n ?? 0);
  if (total === 0 || sampleLimit === 0) return { total, samples: [] };
  const sampleSql = partNameAttrDefId
    ? `select e.id,
              case when dp.id is not null and dp.deleted_at is not null then 'soft-deleted dp'
                   else 'no dp row' end as reason,
              av.value_json as name_json
       from entities e
       left join directory_parts dp on dp.id = e.id
       left join attribute_values av
         on av.entity_id = e.id
        and av.attribute_def_id = $2
        and av.deleted_at is null
       where e.type_id = $1 and e.deleted_at is null
         and (dp.id is null or dp.deleted_at is not null)
       order by e.updated_at desc nulls last
       limit ${sampleLimit}`
    : `select e.id,
              case when dp.id is not null and dp.deleted_at is not null then 'soft-deleted dp'
                   else 'no dp row' end as reason,
              null::text as name_json
       from entities e
       left join directory_parts dp on dp.id = e.id
       where e.type_id = $1 and e.deleted_at is null
         and (dp.id is null or dp.deleted_at is not null)
       order by e.updated_at desc nulls last
       limit ${sampleLimit}`;
  const params = partNameAttrDefId ? [partTypeId, partNameAttrDefId] : [partTypeId];
  const samplesRes = await pool.query(sampleSql, params);
  return {
    total,
    samples: samplesRes.rows.map((row) => ({
      id: String(row.id),
      reason: String(row.reason),
      name: extractName(row.name_json),
    })),
  };
}

async function auditCategoryB(
  partTypeId: string,
  sampleLimit: number,
): Promise<CategoryResult<SampleB>> {
  const countRes = await pool.query(
    `select count(*)::int as n
     from directory_parts dp
     left join entities e on e.id = dp.id and e.type_id = $1
     where dp.deleted_at is null
       and (e.id is null or e.deleted_at is not null)`,
    [partTypeId],
  );
  const total = Number(countRes.rows[0]?.n ?? 0);
  if (total === 0 || sampleLimit === 0) return { total, samples: [] };
  const samplesRes = await pool.query(
    `select dp.id, dp.name,
            case when e.id is not null and e.deleted_at is not null then 'soft-deleted entity'
                 else 'no entity row' end as reason
     from directory_parts dp
     left join entities e on e.id = dp.id and e.type_id = $1
     where dp.deleted_at is null
       and (e.id is null or e.deleted_at is not null)
     order by dp.updated_at desc nulls last
     limit ${sampleLimit}`,
    [partTypeId],
  );
  return {
    total,
    samples: samplesRes.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      reason: String(row.reason),
    })),
  };
}

async function auditCategoryC(sampleLimit: number): Promise<CategoryResult<SampleC>> {
  const countRes = await pool.query(
    `select count(*)::int as n
     from erp_nomenclature n
     left join directory_parts dp on dp.id = n.directory_ref_id
     where n.directory_kind = 'part'
       and n.deleted_at is null
       and n.directory_ref_id is not null
       and (dp.id is null or dp.deleted_at is not null)`,
  );
  const total = Number(countRes.rows[0]?.n ?? 0);
  if (total === 0 || sampleLimit === 0) return { total, samples: [] };
  const samplesRes = await pool.query(
    `select n.id, n.code, n.name, n.directory_ref_id,
            case when dp.id is not null and dp.deleted_at is not null then 'soft-deleted dp'
                 else 'missing dp' end as reason
     from erp_nomenclature n
     left join directory_parts dp on dp.id = n.directory_ref_id
     where n.directory_kind = 'part'
       and n.deleted_at is null
       and n.directory_ref_id is not null
       and (dp.id is null or dp.deleted_at is not null)
     order by n.updated_at desc nulls last
     limit ${sampleLimit}`,
  );
  return {
    total,
    samples: samplesRes.rows.map((row) => ({
      id: String(row.id),
      code: String(row.code ?? ''),
      name: String(row.name ?? ''),
      directoryRefId: String(row.directory_ref_id ?? ''),
      reason: String(row.reason),
    })),
  };
}

function printHumanReport(report: AuditReport): void {
  if (!report.partTypeId) {
    console.log("entity_types.code='part' not registered yet — nothing to audit.");
    return;
  }
  console.log(`parts entity_type id: ${report.partTypeId}`);
  console.log('');

  console.log(`A. entities (type=part) without directory_parts: ${report.categoryA.total}`);
  for (const s of report.categoryA.samples) {
    const nameStr = s.name ? `"${s.name}"` : '(no name attr)';
    console.log(`  - ${s.id} [${s.reason}] ${nameStr}`);
  }
  console.log('');

  console.log(`B. directory_parts without entities (type=part): ${report.categoryB.total}`);
  for (const s of report.categoryB.samples) {
    console.log(`  - ${s.id} "${s.name}" [${s.reason}]`);
  }
  console.log('');

  console.log(
    `C. erp_nomenclature (directory_kind='part') with broken directory_ref_id: ${report.categoryC.total}`,
  );
  for (const s of report.categoryC.samples) {
    console.log(`  - ${s.code} "${s.name}" → directory_ref_id=${s.directoryRefId} [${s.reason}]`);
  }
  console.log('');

  const totalOrphans = report.categoryA.total + report.categoryB.total + report.categoryC.total;
  console.log(`total orphan rows: ${totalOrphans}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    await pool.end();
    return;
  }
  let exitCode = 0;
  try {
    const partTypeId = await getPartEntityTypeId();
    if (!partTypeId) {
      const empty: AuditReport = {
        partTypeId: null,
        categoryA: { total: 0, samples: [] },
        categoryB: { total: 0, samples: [] },
        categoryC: { total: 0, samples: [] },
      };
      if (args.json) console.log(JSON.stringify(empty, null, 2));
      else printHumanReport(empty);
      return;
    }
    const partNameAttrDefId = await getPartNameAttrDefId(partTypeId);
    const [categoryA, categoryB, categoryC] = await Promise.all([
      auditCategoryA(partTypeId, partNameAttrDefId, args.samples),
      auditCategoryB(partTypeId, args.samples),
      auditCategoryC(args.samples),
    ]);
    const report: AuditReport = { partTypeId, categoryA, categoryB, categoryC };
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printHumanReport(report);
    if (categoryA.total + categoryB.total + categoryC.total > 0) exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

void main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(2);
});
