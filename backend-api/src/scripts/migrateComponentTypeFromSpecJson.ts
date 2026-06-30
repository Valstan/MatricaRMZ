import 'dotenv/config';

import { pool } from '../database/db.js';

// Block C companion (v1.22.0): one-time backfill of erp_nomenclature.component_type_id
// from the legacy spec_json.componentTypeId payload (introduced in v1.21.2).
//
// Why a script and not a SQL UPDATE in the migration:
//   - spec_json is free-form text. A pure-SQL UPDATE with `spec_json::jsonb->>'componentTypeId'`
//     would abort the migration on the first malformed row. Here we tolerate them per-row.
//   - We want a visible audit (dry-run by default) before touching prod data — operator
//     can see categories of rows and how many will actually be written.
//   - Per-row writes keep ledger triggers / change-log behavior identical to a regular UPDATE.
//
// Categorisation of every active (deleted_at IS NULL) erp_nomenclature row:
//   A. column NULL + spec_json has non-empty componentTypeId   → COPY (the only write action)
//   B. column equals spec_json.componentTypeId                 → already in sync, skip
//   C. column non-empty AND spec_json has a *different* value  → column wins, spec_json stale (skip + warn)
//   D. column non-empty AND spec_json missing/empty            → column already authoritative, skip
//   E. column NULL AND spec_json missing/empty                 → nothing to copy; heuristic fallback covers reads
//   F. spec_json malformed                                     → skip + warn
//
// Usage:
//   pnpm -F @matricarmz/backend-api warehouse:migrate-component-type              # dry-run (default)
//   pnpm -F @matricarmz/backend-api warehouse:migrate-component-type -- --apply
//   pnpm -F @matricarmz/backend-api warehouse:migrate-component-type -- --samples 20
//   pnpm -F @matricarmz/backend-api warehouse:migrate-component-type -- --json
//
// Exit code: 0 on success; 1 if a write fails in --apply mode; 2 on unexpected error.

type Category = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

type Row = {
  id: string;
  code: string | null;
  name: string | null;
  columnValue: string | null;
  specJsonValue: string | null;
  category: Category;
};

type Counts = Record<Category, number>;

type Report = {
  totalActive: number;
  counts: Counts;
  samples: Record<Category, Row[]>;
  applied?: number;
  failed?: number;
};

function parseArgs(argv: string[]): {
  apply: boolean;
  samples: number;
  json: boolean;
  help: boolean;
} {
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
      'Usage: tsx src/scripts/migrateComponentTypeFromSpecJson.ts [--apply] [--samples N] [--json]',
      '',
      '  --apply       Write column updates for category A. Without it the script is read-only.',
      '  --samples N   How many example rows to print per category (default 10, 0 to disable).',
      '  --json        Emit machine-readable JSON instead of a human-formatted report.',
    ].join('\n'),
  );
}

function readSpecComponentTypeId(raw: string | null): { value: string | null; malformed: boolean } {
  if (raw == null) return { value: null, malformed: false };
  const trimmed = String(raw).trim();
  if (!trimmed) return { value: null, malformed: false };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, malformed: false };
    }
    const candidate = (parsed as Record<string, unknown>).componentTypeId;
    if (typeof candidate !== 'string') return { value: null, malformed: false };
    const value = candidate.trim();
    return { value: value || null, malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

function classify(columnValueRaw: string | null, specJsonRaw: string | null): {
  category: Category;
  columnValue: string | null;
  specJsonValue: string | null;
} {
  const columnValue = typeof columnValueRaw === 'string' && columnValueRaw.trim() ? columnValueRaw.trim() : null;
  const { value: specJsonValue, malformed } = readSpecComponentTypeId(specJsonRaw);
  if (malformed) return { category: 'F', columnValue, specJsonValue: null };
  if (columnValue === null && specJsonValue !== null) return { category: 'A', columnValue, specJsonValue };
  if (columnValue !== null && specJsonValue !== null && columnValue === specJsonValue) {
    return { category: 'B', columnValue, specJsonValue };
  }
  if (columnValue !== null && specJsonValue !== null && columnValue !== specJsonValue) {
    return { category: 'C', columnValue, specJsonValue };
  }
  if (columnValue !== null && specJsonValue === null) return { category: 'D', columnValue, specJsonValue };
  return { category: 'E', columnValue, specJsonValue };
}

async function loadActiveRows(): Promise<Row[]> {
  const res = await pool.query(
    `select id, code, name, component_type_id, spec_json
       from erp_nomenclature
      where deleted_at is null`,
  );
  return res.rows.map((row) => {
    const { category, columnValue, specJsonValue } = classify(
      row.component_type_id == null ? null : String(row.component_type_id),
      row.spec_json == null ? null : String(row.spec_json),
    );
    return {
      id: String(row.id),
      code: row.code == null ? null : String(row.code),
      name: row.name == null ? null : String(row.name),
      columnValue,
      specJsonValue,
      category,
    };
  });
}

function buildReport(rows: Row[], sampleLimit: number): Report {
  const counts: Counts = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  const samples: Record<Category, Row[]> = { A: [], B: [], C: [], D: [], E: [], F: [] };
  for (const row of rows) {
    counts[row.category] += 1;
    if (samples[row.category].length < sampleLimit) samples[row.category].push(row);
  }
  return { totalActive: rows.length, counts, samples };
}

async function applyCategoryA(rows: Row[]): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.category !== 'A' || row.specJsonValue == null) continue;
    try {
      const res = await pool.query(
        `update erp_nomenclature
            set component_type_id = $2,
                updated_at = greatest(updated_at, $3::bigint)
          where id = $1
            and component_type_id is null
            and deleted_at is null`,
        [row.id, row.specJsonValue, Date.now()],
      );
      if ((res.rowCount ?? 0) > 0) applied += 1;
    } catch (err) {
      failed += 1;
      console.error(`failed to update ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { applied, failed };
}

function printHumanReport(report: Report, apply: boolean): void {
  console.log(`active erp_nomenclature rows: ${report.totalActive}`);
  console.log('');
  console.log('Categories:');
  console.log(`  A. column NULL + spec_json has componentTypeId (will be copied): ${report.counts.A}`);
  console.log(`  B. column == spec_json (already in sync):                        ${report.counts.B}`);
  console.log(`  C. column != spec_json (column wins, spec_json stale):           ${report.counts.C}`);
  console.log(`  D. column has value + spec_json empty (column authoritative):    ${report.counts.D}`);
  console.log(`  E. both empty (heuristic fallback in reader):                    ${report.counts.E}`);
  console.log(`  F. spec_json malformed (skipped):                                ${report.counts.F}`);
  console.log('');
  const printSamples = (cat: Category, label: string) => {
    const items = report.samples[cat];
    if (items.length === 0) return;
    console.log(`Samples — ${label}:`);
    for (const s of items) {
      const labelStr = s.code ? `${s.code} "${s.name ?? ''}"` : `"${s.name ?? ''}" (${s.id})`;
      const detail =
        cat === 'A' ? `→ ${s.specJsonValue}`
        : cat === 'C' ? `column=${s.columnValue} specJson=${s.specJsonValue}`
        : cat === 'B' || cat === 'D' ? `column=${s.columnValue}`
        : '';
      console.log(`  - ${labelStr} ${detail}`);
    }
    console.log('');
  };
  printSamples('A', 'A (will be copied in --apply)');
  printSamples('C', 'C (column wins, spec_json stale, no write)');
  printSamples('F', 'F (malformed spec_json, no write)');

  if (apply) {
    console.log(`apply: updated ${report.applied ?? 0} rows, ${report.failed ?? 0} failures`);
  } else if (report.counts.A > 0) {
    console.log('Run again with --apply to copy category A rows into the new column.');
  } else {
    console.log('No category A rows — nothing to write.');
  }
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
    const rows = await loadActiveRows();
    const report = buildReport(rows, args.samples);
    if (args.apply) {
      const { applied, failed } = await applyCategoryA(rows);
      report.applied = applied;
      report.failed = failed;
      if (failed > 0) exitCode = 1;
    }
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printHumanReport(report, args.apply);
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

void main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(2);
});
