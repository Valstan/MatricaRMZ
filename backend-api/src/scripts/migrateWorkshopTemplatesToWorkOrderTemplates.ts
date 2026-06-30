import 'dotenv/config';

import { pool } from '../database/db.js';

// Stage 1 companion (work-order-template-system plan): one-time backfill of
// work_order_templates from the v1.26/27 workshop_repair_templates table.
//
// Mapping rules (matches the plan):
//   - work_order_kind = 'repair' (Workshop templates = repair-with-prefilled-parts).
//   - name            = `{workshopName} — {oldName}`, truncated to 100 chars.
//   - payload_overrides = JSON {"workshopId": <old.workshop_id>}.
//   - hidden_fields   = JSON ["engineId","engineNumber","engineBrandId",
//                             "engineBrandName","productNumber"]
//                       (irrelevant for the Workshop autofill flow).
//   - lines           = old.lines_json (same WorkshopRepairTemplateLine shape;
//                       extra fields in the new line type stay undefined).
//   - updated_at / updated_by — copied verbatim for audit.
//
// Soft-deleted workshops (directory_workshops.deleted_at IS NOT NULL) keep their
// templates by design (workshop_repair_templates has ON DELETE CASCADE only for
// hard delete). We still migrate them and report the count separately — the
// operator can clean those up post-migration if needed.
//
// Idempotent: ON CONFLICT (work_order_kind, name) DO NOTHING. Re-running after
// a partial apply is safe.
//
// Usage:
//   pnpm -F @matricarmz/backend-api work-order-templates:migrate-from-workshops             # dry-run
//   pnpm -F @matricarmz/backend-api work-order-templates:migrate-from-workshops -- --apply
//   pnpm -F @matricarmz/backend-api work-order-templates:migrate-from-workshops -- --json
//
// Exit code: 0 on success; 1 on write failures in --apply mode; 2 on unexpected error.

const NAME_MAX = 100;
const HIDDEN_FIELDS_JSON = JSON.stringify([
  'engineId',
  'engineNumber',
  'engineBrandId',
  'engineBrandName',
  'productNumber',
]);

type SourceRow = {
  id: string;
  workshopId: string;
  workshopName: string;
  workshopDeleted: boolean;
  oldName: string;
  linesJson: string;
  updatedAt: number;
  updatedBy: string | null;
};

type MappedRow = {
  newName: string;
  payloadOverridesJson: string;
  hiddenFieldsJson: string;
  linesJson: string;
  updatedAt: number;
  updatedBy: string | null;
  source: SourceRow;
};

type Report = {
  total: number;
  fromActiveWorkshop: number;
  fromDeletedWorkshop: number;
  conflictsPredicted: number;
  truncatedNames: number;
  samples: MappedRow[];
  applied?: number;
  skippedExisting?: number;
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
      'Usage: tsx src/scripts/migrateWorkshopTemplatesToWorkOrderTemplates.ts [--apply] [--samples N] [--json]',
      '',
      '  --apply       Insert rows into work_order_templates. Without it the script is read-only.',
      '  --samples N   How many sample mapped rows to print (default 10, 0 to disable).',
      '  --json        Emit machine-readable JSON instead of a human-formatted report.',
    ].join('\n'),
  );
}

function truncateName(raw: string): { value: string; truncated: boolean } {
  if (raw.length <= NAME_MAX) return { value: raw, truncated: false };
  return { value: raw.slice(0, NAME_MAX), truncated: true };
}

async function loadSourceRows(): Promise<SourceRow[]> {
  const res = await pool.query(
    `select t.id,
            t.workshop_id,
            t.name as old_name,
            t.lines_json,
            t.updated_at,
            t.updated_by,
            w.name as workshop_name,
            (w.deleted_at is not null) as workshop_deleted
       from workshop_repair_templates t
       join directory_workshops w on w.id = t.workshop_id
      order by w.name, t.name`,
  );
  return res.rows.map((row) => ({
    id: String(row.id),
    workshopId: String(row.workshop_id),
    workshopName: String(row.workshop_name ?? ''),
    workshopDeleted: Boolean(row.workshop_deleted),
    oldName: String(row.old_name ?? ''),
    linesJson: row.lines_json == null ? '[]' : String(row.lines_json),
    updatedAt: Number(row.updated_at) || Date.now(),
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
  }));
}

function mapRow(source: SourceRow): MappedRow {
  const composite = `${source.workshopName} — ${source.oldName}`.trim();
  const { value: newName } = truncateName(composite);
  const payloadOverridesJson = JSON.stringify({ workshopId: source.workshopId });
  return {
    newName,
    payloadOverridesJson,
    hiddenFieldsJson: HIDDEN_FIELDS_JSON,
    linesJson: source.linesJson,
    updatedAt: source.updatedAt,
    updatedBy: source.updatedBy,
    source,
  };
}

async function predictConflicts(mapped: MappedRow[]): Promise<Set<string>> {
  if (mapped.length === 0) return new Set();
  const names = Array.from(new Set(mapped.map((m) => m.newName)));
  const res = await pool.query(
    `select name from work_order_templates where work_order_kind = 'repair' and name = ANY($1::text[])`,
    [names],
  );
  return new Set(res.rows.map((r) => String(r.name)));
}

function buildReport(mapped: MappedRow[], existingNames: Set<string>, sampleLimit: number): Report {
  let fromActive = 0;
  let fromDeleted = 0;
  let truncated = 0;
  for (const row of mapped) {
    if (row.source.workshopDeleted) fromDeleted += 1;
    else fromActive += 1;
    const composite = `${row.source.workshopName} — ${row.source.oldName}`.trim();
    if (composite.length > NAME_MAX) truncated += 1;
  }
  return {
    total: mapped.length,
    fromActiveWorkshop: fromActive,
    fromDeletedWorkshop: fromDeleted,
    conflictsPredicted: existingNames.size,
    truncatedNames: truncated,
    samples: mapped.slice(0, sampleLimit),
  };
}

async function applyInserts(mapped: MappedRow[]): Promise<{ applied: number; skipped: number; failed: number }> {
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of mapped) {
    try {
      const res = await pool.query(
        `insert into work_order_templates
           (work_order_kind, name, payload_overrides, hidden_fields, lines, updated_at, updated_by)
         values ('repair', $1, $2, $3, $4, $5, $6)
         on conflict (work_order_kind, name) do nothing`,
        [
          row.newName,
          row.payloadOverridesJson,
          row.hiddenFieldsJson,
          row.linesJson,
          row.updatedAt,
          row.updatedBy,
        ],
      );
      if ((res.rowCount ?? 0) > 0) applied += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `failed to insert template "${row.newName}" (source=${row.source.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { applied, skipped, failed };
}

function printHumanReport(report: Report, apply: boolean) {
  console.log('workshop_repair_templates → work_order_templates migration\n');
  console.log(`  total source rows:           ${report.total}`);
  console.log(`    from active workshops:     ${report.fromActiveWorkshop}`);
  console.log(`    from soft-deleted workshops: ${report.fromDeletedWorkshop}`);
  console.log(`  predicted name conflicts:    ${report.conflictsPredicted}`);
  console.log(`  truncated names (> ${NAME_MAX} chars): ${report.truncatedNames}`);
  if (report.samples.length > 0) {
    console.log('\n  samples:');
    for (const m of report.samples) {
      console.log(
        `    [${m.source.workshopDeleted ? 'DEL' : 'ACT'}] ${m.newName}` +
          ` (workshop=${m.source.workshopId.slice(0, 8)}…)`,
      );
    }
  }
  if (apply) {
    console.log('\napply results:');
    console.log(`  inserted: ${report.applied ?? 0}`);
    console.log(`  skipped (already exists): ${report.skippedExisting ?? 0}`);
    console.log(`  failed:   ${report.failed ?? 0}`);
  } else {
    console.log('\ndry-run only — pass --apply to actually insert rows.');
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
    const mapped = sources.map(mapRow);
    const existing = await predictConflicts(mapped);
    const report = buildReport(mapped, existing, args.samples);

    if (args.apply) {
      const { applied, skipped, failed } = await applyInserts(mapped);
      report.applied = applied;
      report.skippedExisting = skipped;
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
