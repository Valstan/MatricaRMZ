import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import {
  ENGINE_INVENTORY_STAGE,
  type EngineInventoryRow,
  mergeLegacyChecklistAnswers,
  type RepairChecklistPayload,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';

// Stage 2 of docs/plans/checklist-unify.md (Этап 2 — backend admin-скрипт).
//
// Объединяет пары operations(stage='defect') + operations(stage='completeness') одного
// engine_entity_id в одну operations(stage='engine_inventory'). Старые две записи
// soft-delete'ятся (deleted_at = now). Новый payload собирается через
// mergeLegacyChecklistAnswers из shared.
//
// Скрипт НЕ пишет в change_log / ledger — это БД-миграция. Клиенты увидят
// результат через следующий обычный sync.run (он пуллит operations напрямую).
// Этот шаг безопасно запускать ПОСЛЕ Этапа 3 (UI EngineInventoryPanel
// развёрнут) — иначе старые panels у клиентов будут пустыми (data soft-deleted).
//
// Категории engine_id:
//   A. Есть и defect, и completeness   → merge into new engine_inventory; soft-delete оба.
//   B. Только defect                   → создать engine_inventory с defect-only mапированием.
//   C. Только completeness             → создать engine_inventory с completeness-only мапированием.
//   D. Уже есть engine_inventory + один из legacy → SKIP (operator уже мигрировал вручную? warning).
//   E. Только engine_inventory         → SKIP (уже мигрировано).
//
// Usage:
//   pnpm -F @matricarmz/backend-api engine-inventory:migrate            # dry-run (default)
//   pnpm -F @matricarmz/backend-api engine-inventory:migrate -- --apply
//   pnpm -F @matricarmz/backend-api engine-inventory:migrate -- --samples 5
//   pnpm -F @matricarmz/backend-api engine-inventory:migrate -- --json
//
// Exit codes: 0 success / 1 partial failure / 2 unexpected error.

type Category = 'A' | 'B' | 'C' | 'D' | 'E';

type OperationRow = {
  id: string;
  engine_entity_id: string;
  operation_type: string;
  status: string;
  meta_json: string | null;
  created_at: number | string;
  updated_at: number | string;
};

type EngineGroup = {
  engineId: string;
  category: Category;
  defectOp?: OperationRow;
  completenessOp?: OperationRow;
  existingInventoryOp?: OperationRow;
  mergedRows?: EngineInventoryRow[];
  defectRowCount?: number;
  completenessRowCount?: number;
};

type Counts = Record<Category, number>;

type Report = {
  totalEngines: number;
  counts: Counts;
  samples: Record<Category, EngineGroup[]>;
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
  console.log(`Merge defect+completeness checklists into engine_inventory.

Usage:
  pnpm -F @matricarmz/backend-api engine-inventory:migrate            # dry-run
  pnpm -F @matricarmz/backend-api engine-inventory:migrate -- --apply

Flags:
  --apply           perform writes (default: dry-run, no writes)
  --samples N       show up to N samples per category (default: 5)
  --json            machine-readable report on stdout
  --help            this message
`);
}

function safeJsonParse(s: string | null): unknown {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractRows(payload: unknown, tableId: string): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object') return [];
  const answers = (payload as RepairChecklistPayload).answers as Record<string, unknown> | undefined;
  if (!answers || typeof answers !== 'object') return [];
  const table = answers[tableId] as { kind?: string; rows?: unknown } | undefined;
  if (!table || table.kind !== 'table' || !Array.isArray(table.rows)) return [];
  return table.rows as Record<string, unknown>[];
}

async function fetchAllChecklistOperations(): Promise<OperationRow[]> {
  const { rows } = await pool.query<OperationRow>(
    `SELECT id, engine_entity_id, operation_type, status, meta_json, created_at, updated_at
       FROM operations
       WHERE operation_type IN ('defect', 'completeness', $1)
         AND status = 'checklist'
         AND deleted_at IS NULL
       ORDER BY engine_entity_id, operation_type, updated_at`,
    [ENGINE_INVENTORY_STAGE],
  );
  return rows;
}

function groupByEngine(rows: OperationRow[]): EngineGroup[] {
  const byEngine = new Map<string, EngineGroup>();
  for (const row of rows) {
    const key = String(row.engine_entity_id);
    let group = byEngine.get(key);
    if (!group) {
      group = { engineId: key, category: 'E' };
      byEngine.set(key, group);
    }
    if (row.operation_type === 'defect') {
      // Самая свежая запись побеждает (rows отсортированы по updated_at ASC).
      group.defectOp = row;
    } else if (row.operation_type === 'completeness') {
      group.completenessOp = row;
    } else if (row.operation_type === ENGINE_INVENTORY_STAGE) {
      group.existingInventoryOp = row;
    }
  }

  for (const group of byEngine.values()) {
    const hasLegacy = !!(group.defectOp || group.completenessOp);
    const hasInventory = !!group.existingInventoryOp;
    if (hasInventory && hasLegacy) group.category = 'D';
    else if (hasInventory) group.category = 'E';
    else if (group.defectOp && group.completenessOp) group.category = 'A';
    else if (group.defectOp) group.category = 'B';
    else if (group.completenessOp) group.category = 'C';
  }
  return [...byEngine.values()];
}

function prepareMergedRows(group: EngineGroup): EngineInventoryRow[] {
  const defectRows = group.defectOp ? extractRows(safeJsonParse(group.defectOp.meta_json), 'defect_items') : [];
  const completenessRows = group.completenessOp
    ? extractRows(safeJsonParse(group.completenessOp.meta_json), 'completeness_items')
    : [];
  group.defectRowCount = defectRows.length;
  group.completenessRowCount = completenessRows.length;
  return mergeLegacyChecklistAnswers({ defectRows, completenessRows });
}

function buildNewInventoryPayload(args: {
  engineId: string;
  filledBy: string | null;
  rows: EngineInventoryRow[];
}): RepairChecklistPayload {
  return {
    kind: 'repair_checklist',
    templateId: 'engine_inventory_default',
    templateVersion: 1,
    stage: ENGINE_INVENTORY_STAGE,
    engineEntityId: args.engineId,
    filledBy: args.filledBy,
    filledAt: null,
    answers: {
      engine_inventory_items: {
        kind: 'table',
        rows: args.rows as unknown as Record<string, string | boolean | number>[],
      },
    },
  };
}

async function applyMigration(client: typeof pool, group: EngineGroup): Promise<void> {
  if (!group.mergedRows) throw new Error(`mergedRows missing for engine ${group.engineId}`);
  const ts = Date.now();
  const payload = buildNewInventoryPayload({
    engineId: group.engineId,
    filledBy: null,
    rows: group.mergedRows,
  });

  await client.query(
    `INSERT INTO operations
       (id, engine_entity_id, operation_type, status, note, performed_at, performed_by,
        meta_json, created_at, updated_at, deleted_at, sync_status)
     VALUES ($1, $2, $3, 'checklist', $4, $5, $6, $7, $8, $8, NULL, 'synced')`,
    [
      randomUUID(),
      group.engineId,
      ENGINE_INVENTORY_STAGE,
      'Инвентаризация двигателя (объединено из defect + completeness)',
      ts,
      'engine-inventory-migrate',
      JSON.stringify(payload),
      ts,
    ],
  );

  if (group.defectOp) {
    await client.query(
      `UPDATE operations SET deleted_at = $1, updated_at = $1, sync_status = 'synced' WHERE id = $2`,
      [ts, group.defectOp.id],
    );
  }
  if (group.completenessOp) {
    await client.query(
      `UPDATE operations SET deleted_at = $1, updated_at = $1, sync_status = 'synced' WHERE id = $2`,
      [ts, group.completenessOp.id],
    );
  }
}

function emptyCounts(): Counts {
  return { A: 0, B: 0, C: 0, D: 0, E: 0 };
}

function emptySamples(): Record<Category, EngineGroup[]> {
  return { A: [], B: [], C: [], D: [], E: [] };
}

function printPlainReport(report: Report, sampleLimit: number) {
  const totals = Object.values(report.counts).reduce((a, b) => a + b, 0);
  console.log('engine-inventory migration — dry-run report');
  console.log('============================================');
  console.log(`total engines scanned          : ${report.totalEngines}`);
  console.log(`engines with checklist data    : ${totals}`);
  console.log(`  A defect + completeness     : ${report.counts.A}  (merge — 2 rows soft-delete + 1 new)`);
  console.log(`  B defect only                : ${report.counts.B}  (defect-only migration — 1 soft-delete + 1 new)`);
  console.log(`  C completeness only          : ${report.counts.C}  (completeness-only migration — 1 soft-delete + 1 new)`);
  console.log(`  D already has inventory      : ${report.counts.D}  (WARNING — manual cleanup needed)`);
  console.log(`  E only inventory             : ${report.counts.E}  (already migrated, skipped)`);
  if (report.applied !== undefined) {
    console.log('');
    console.log(`writes applied               : ${report.applied}`);
    console.log(`writes failed                : ${report.failed}`);
  }
  for (const cat of ['A', 'B', 'C', 'D'] as Category[]) {
    const samples = report.samples[cat];
    if (samples.length === 0) continue;
    console.log('');
    console.log(`-- samples [${cat}] (showing up to ${sampleLimit}) --`);
    for (const s of samples.slice(0, sampleLimit)) {
      console.log(
        `engine=${s.engineId} defectRows=${s.defectRowCount ?? '-'} completenessRows=${s.completenessRowCount ?? '-'} mergedRows=${s.mergedRows?.length ?? '-'}`,
      );
    }
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const ops = await fetchAllChecklistOperations();
  const groups = groupByEngine(ops);

  const counts: Counts = emptyCounts();
  const samples = emptySamples();
  for (const group of groups) {
    counts[group.category] += 1;
    if (samples[group.category].length < args.samples) {
      // Eagerly prepare merged rows for samples + future apply.
      if (group.category === 'A' || group.category === 'B' || group.category === 'C') {
        group.mergedRows = prepareMergedRows(group);
      }
      samples[group.category].push(group);
    } else if (group.category === 'A' || group.category === 'B' || group.category === 'C') {
      group.mergedRows = prepareMergedRows(group);
    }
  }

  const report: Report = { totalEngines: groups.length, counts, samples };

  if (!args.apply) {
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printPlainReport(report, args.samples);
    return 0;
  }

  let applied = 0;
  let failed = 0;
  for (const group of groups) {
    if (group.category === 'D' || group.category === 'E') continue;
    try {
      await applyMigration(pool, group);
      applied += 1;
    } catch (e) {
      failed += 1;
      console.error(`FAILED engine=${group.engineId}: ${String(e)}`);
    }
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
