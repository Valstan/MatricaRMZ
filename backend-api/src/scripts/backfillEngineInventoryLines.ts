import 'dotenv/config';

import { ENGINE_INVENTORY_STAGE } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { deriveEngineInventoryLines, type InventoryOperationRow } from '../services/engineInventoryLinesService.js';

// engine-inventory:backfill-lines — разово выводит строки erp_engine_inventory_lines из всех
// живых листов engine_inventory (план engine-inventory-lines-2026-09, E1 п. 5).
//
// На двигатель берётся ОДИН лист — самый свежий по updated_at (~350 двигателей держат по
// два и больше листа из эпохи гонки; клиент и так показывает первый по updated_at desc).
// Остальные листы строк не получают и не гасятся — решение по дублям отдельное (план, §вопросы).
//
// Идемпотентен: id строки детерминирован от (лист, ключ строки), сверка по ключу — повторный
// прогон обновляет изменившееся и ничего не дублирует. Пишет через writeSyncChanges, то есть
// строки идут в ledger и инкрементальный pull; пачка ≤ 1000 строк на блок.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api engine-inventory:backfill-lines            # dry-run
//   corepack pnpm -F @matricarmz/backend-api engine-inventory:backfill-lines -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

function parseArgs(argv: string[]): { apply: boolean; engine: string | null } {
  const out = { apply: false, engine: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') out.apply = true;
    else if (a === '--engine') out.engine = String(argv[++i] ?? '').trim() || null;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`engine-inventory:backfill-lines — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const params: unknown[] = [ENGINE_INVENTORY_STAGE];
  const engineFilter = args.engine ? ` AND engine_entity_id = $2` : '';
  if (args.engine) params.push(args.engine);
  const res = await pool.query<InventoryOperationRow & { updated_at: string }>(
    `SELECT DISTINCT ON (engine_entity_id) id, engine_entity_id, operation_type, meta_json, deleted_at, updated_at
       FROM operations
      WHERE operation_type = $1 AND deleted_at IS NULL${engineFilter}
      ORDER BY engine_entity_id, updated_at DESC, id`,
    params,
  );
  const ops: InventoryOperationRow[] = res.rows.map((r) => ({
    id: String(r.id),
    engine_entity_id: String(r.engine_entity_id),
    operation_type: String(r.operation_type),
    meta_json: r.meta_json == null ? null : String(r.meta_json),
    deleted_at: null,
  }));
  console.log(`  листов (по одному на двигатель): ${ops.length}`);

  const started = Date.now();
  const actor = { id: 'server', username: 'engine-inventory:backfill-lines', role: 'system' };
  const r = await deriveEngineInventoryLines(ops, actor, { dryRun: !args.apply, batchRows: 1000 });
  console.log(
    `  листов с секцией строк: ${r.operations}, пропущено (без секции/битый payload): ${r.skipped}\n` +
      `  строк: вставить ${r.insert}, обновить ${r.update}, погасить ${r.tombstone}, без изменений ${r.unchanged}\n` +
      `  ${((Date.now() - started) / 1000).toFixed(1)} с, RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)} МБ`,
  );
  if (!args.apply) console.log('\nБез --apply запись не выполняется.');
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
