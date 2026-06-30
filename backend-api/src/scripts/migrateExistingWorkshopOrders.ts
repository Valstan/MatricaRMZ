import 'dotenv/config';

import { pool } from '../database/db.js';

// Stage 6 companion (work-order-template-system plan): convert OPEN
// `workOrderKind = 'workshop_template'` work-orders to `'repair'`. Closed orders
// keep the legacy kind so historical records stay readable; the WorkOrderKind
// enum keeps `WorkshopTemplate` marked @deprecated for parsing those.
//
// Selection:
//   operations.operation_type = 'work_order'
//   AND operations.status <> 'closed'
//   AND operations.deleted_at IS NULL
//   AND meta_json::jsonb -> 'workOrderKind' = '"workshop_template"'
//
// Transformation (per row, in Node — meta_json is text):
//   payload.workOrderKind = 'repair'
//   payload.migratedFromWorkshopTemplate = true (audit marker, root meta level)
//
// freeWorks / workshopId / lines are preserved verbatim. The operator continues
// editing the row as a regular Repair work-order.
//
// Idempotent: rows already migrated have workOrderKind = 'repair' and are
// filtered out of the source query; the marker just helps post-hoc audits.
//
// Usage:
//   pnpm -F @matricarmz/backend-api work-order-templates:migrate-open-workshop-orders             # dry-run
//   pnpm -F @matricarmz/backend-api work-order-templates:migrate-open-workshop-orders -- --apply
//   pnpm -F @matricarmz/backend-api work-order-templates:migrate-open-workshop-orders -- --json
//
// Exit code: 0 on success; 1 on write failures in --apply mode; 2 on unexpected error.

type SourceRow = {
  id: string;
  status: string;
  metaJson: string;
  updatedAt: number;
};

type MappedRow = {
  source: SourceRow;
  newMetaJson: string;
};

type Report = {
  candidates: number;
  parseFailures: number;
  alreadyMigrated: number;
  samples: Array<{ id: string; status: string; workshopId: string | null; freeWorksCount: number }>;
  applied?: number;
  failed?: number;
};

function parseArgs(argv: string[]): { apply: boolean; samples: number; json: boolean; help: boolean } {
  const out = { apply: false, samples: 10, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--samples') {
      const next = Number(argv[i + 1]);
      if (Number.isFinite(next) && next >= 0) {
        out.samples = Math.trunc(next);
        i += 1;
      }
    } else if (arg.startsWith('--samples=')) {
      const next = Number(arg.slice('--samples='.length));
      if (Number.isFinite(next) && next >= 0) out.samples = Math.trunc(next);
    }
  }
  return out;
}

function printHelp() {
  console.log(
    [
      'Usage: tsx src/scripts/migrateExistingWorkshopOrders.ts [--apply] [--samples N] [--json]',
      '',
      '  --apply       Update open work-orders. Without it the script is read-only.',
      '  --samples N   How many sample rows to print (default 10, 0 to disable).',
      '  --json        Emit machine-readable JSON instead of a human-formatted report.',
    ].join('\n'),
  );
}

async function loadSourceRows(): Promise<SourceRow[]> {
  const res = await pool.query(
    `select id, status, meta_json, updated_at
       from operations
      where operation_type = 'work_order'
        and status <> 'closed'
        and deleted_at is null
        and meta_json is not null
        and meta_json::jsonb ->> 'workOrderKind' = 'workshop_template'`,
  );
  return res.rows.map((row) => ({
    id: String(row.id),
    status: String(row.status ?? ''),
    metaJson: String(row.meta_json ?? ''),
    updatedAt: Number(row.updated_at) || Date.now(),
  }));
}

function mapRow(source: SourceRow): MappedRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.metaJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const meta = parsed as Record<string, unknown>;
  meta.workOrderKind = 'repair';
  meta.migratedFromWorkshopTemplate = true;
  return { source, newMetaJson: JSON.stringify(meta) };
}

function extractSample(mapped: MappedRow): Report['samples'][number] {
  let workshopId: string | null = null;
  let freeWorksCount = 0;
  try {
    const meta = JSON.parse(mapped.newMetaJson) as Record<string, unknown>;
    if (typeof meta.workshopId === 'string') workshopId = meta.workshopId;
    if (Array.isArray(meta.freeWorks)) freeWorksCount = meta.freeWorks.length;
  } catch {
    /* keep defaults */
  }
  return { id: mapped.source.id, status: mapped.source.status, workshopId, freeWorksCount };
}

async function applyUpdates(mapped: MappedRow[]): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const row of mapped) {
    try {
      const res = await pool.query(
        `update operations
            set meta_json = $1,
                updated_at = $2
          where id = $3`,
        [row.newMetaJson, Date.now(), row.source.id],
      );
      if ((res.rowCount ?? 0) > 0) applied += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `failed to update operation ${row.source.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { applied, failed };
}

function printHumanReport(report: Report, apply: boolean) {
  console.log('open Workshop-orders → Repair migration\n');
  console.log(`  candidates (open, kind=workshop_template): ${report.candidates}`);
  console.log(`  parse failures (skipped):                  ${report.parseFailures}`);
  if (report.samples.length > 0) {
    console.log('\n  samples:');
    for (const s of report.samples) {
      console.log(
        `    ${s.id.slice(0, 8)}…  status=${s.status}  workshop=${s.workshopId?.slice(0, 8) ?? '—'}  freeWorks=${s.freeWorksCount}`,
      );
    }
  }
  if (apply) {
    console.log('\napply results:');
    console.log(`  updated: ${report.applied ?? 0}`);
    console.log(`  failed:  ${report.failed ?? 0}`);
  } else {
    console.log('\ndry-run only — pass --apply to actually update rows.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    const sources = await loadSourceRows();
    const mapped: MappedRow[] = [];
    let parseFailures = 0;
    for (const src of sources) {
      const m = mapRow(src);
      if (m) mapped.push(m);
      else parseFailures += 1;
    }
    const report: Report = {
      candidates: sources.length,
      parseFailures,
      alreadyMigrated: 0,
      samples: mapped.slice(0, args.samples).map(extractSample),
    };

    if (args.apply) {
      const { applied, failed } = await applyUpdates(mapped);
      report.applied = applied;
      report.failed = failed;
    }

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report, args.apply);
    }

    if (args.apply && (report.failed ?? 0) > 0) process.exit(1);
    process.exit(0);
  } catch (err) {
    console.error(`migration failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(2);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main();
