import 'dotenv/config';

import { pool } from '../database/db.js';

// Stage 4 of docs/plans/checklist-unify.md.
//
// Soft-delete всех operations(operation_type='repair', status='checklist',
// deleted_at IS NULL). Legacy «Контрольный лист ремонта» не используется на
// заводе (бизнес-фидбек оператора 2026-05-24) и больше не имеет UI после
// Stage 3b (PR #41). Скрипт идемпотентен — повторный запуск не находит
// candidate'ов после первого --apply.
//
// Скрипт НЕ пишет в change_log / ledger. Старые клиенты увидят soft-delete
// через следующий обычный sync (operations pulled напрямую). UI Stage 3b
// уже не рендерит stage='repair' панель.
//
// Usage:
//   pnpm -F @matricarmz/backend-api repair-stage:soft-delete            # dry-run (default)
//   pnpm -F @matricarmz/backend-api repair-stage:soft-delete -- --apply
//   pnpm -F @matricarmz/backend-api repair-stage:soft-delete -- --samples 10
//   pnpm -F @matricarmz/backend-api repair-stage:soft-delete -- --json
//
// Exit codes: 0 success / 1 partial failure / 2 unexpected error.

type RepairOp = {
  id: string;
  engine_entity_id: string;
  status: string;
  created_at: number | string;
  updated_at: number | string;
};

type Report = {
  totalCandidates: number;
  samples: RepairOp[];
  applied?: number;
  failed?: number;
};

function parseArgs(argv: string[]): { apply: boolean; samples: number; json: boolean; help: boolean } {
  const out = { apply: false, samples: 5, json: false, help: false };
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
  console.log(`Soft-delete legacy operations(operation_type='repair', status='checklist').

Usage:
  pnpm -F @matricarmz/backend-api repair-stage:soft-delete            # dry-run
  pnpm -F @matricarmz/backend-api repair-stage:soft-delete -- --apply

Flags:
  --apply           perform writes (default: dry-run, no writes)
  --samples N       show up to N samples (default: 5)
  --json            machine-readable report on stdout
  --help            this message
`);
}

async function fetchCandidates(): Promise<RepairOp[]> {
  const { rows } = await pool.query<RepairOp>(
    `SELECT id, engine_entity_id, status, created_at, updated_at
       FROM operations
       WHERE operation_type = 'repair'
         AND status = 'checklist'
         AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
  );
  return rows;
}

function printPlainReport(report: Report, sampleLimit: number) {
  console.log('legacy repair operations soft-delete — report');
  console.log('=============================================');
  console.log(`total candidates             : ${report.totalCandidates}`);
  if (report.applied !== undefined) {
    console.log('');
    console.log(`writes applied               : ${report.applied}`);
    console.log(`writes failed                : ${report.failed}`);
  }
  if (report.samples.length > 0) {
    console.log('');
    console.log(`-- samples (showing up to ${sampleLimit}) --`);
    for (const s of report.samples.slice(0, sampleLimit)) {
      console.log(`id=${s.id} engine=${s.engine_entity_id} updated_at=${s.updated_at}`);
    }
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const candidates = await fetchCandidates();
  const report: Report = {
    totalCandidates: candidates.length,
    samples: candidates.slice(0, args.samples),
  };

  if (!args.apply) {
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printPlainReport(report, args.samples);
    return 0;
  }

  if (candidates.length === 0) {
    report.applied = 0;
    report.failed = 0;
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printPlainReport(report, args.samples);
    return 0;
  }

  const ts = Date.now();
  let applied = 0;
  let failed = 0;
  try {
    const { rowCount } = await pool.query(
      `UPDATE operations
          SET deleted_at = $1, updated_at = $1, sync_status = 'synced'
        WHERE operation_type = 'repair'
          AND status = 'checklist'
          AND deleted_at IS NULL`,
      [ts],
    );
    applied = rowCount ?? 0;
  } catch (e) {
    failed = candidates.length;
    console.error(`FAILED bulk update: ${String(e)}`);
  }
  report.applied = applied;
  report.failed = failed;

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printPlainReport(report, args.samples);

  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    return pool.end().then(() => process.exit(code));
  })
  .catch((e) => {
    console.error('UNEXPECTED ERROR:', e);
    void pool.end().finally(() => process.exit(2));
  });
