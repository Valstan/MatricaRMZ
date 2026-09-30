import 'dotenv/config';

import {
  ENGINE_INVENTORY_STAGE,
  SyncTableName,
  SyncTableRegistry,
  inventoryRawRowsFromPayload,
  inventoryRowsLocation,
  stripInventoryRowsForStorage,
} from '@matricarmz/shared';
import { and, eq, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { operations } from '../database/schema.js';
import { readExistingLines } from '../services/engineInventoryLinesService.js';
import { writeSyncChanges } from '../services/sync/syncWriteService.js';

// engine-inventory:strip-rows — разово убирает строки списка деталей из `operations.meta_json`
// живых листов engine_inventory (E3 плана engine-inventory-lines-2026-09): остаётся пустой
// список с маркером `rowsIn`, сами строки живут только в `erp_engine_inventory_lines`.
// После прогона `operations.meta_json` теряет ~140 МБ — и только тогда компакция ledger'а
// получает предмет (план, E3 п. 3).
//
// Безопасность — три запрета:
//   1. Помеченные листы не трогаем (уже чистые).
//   2. Листы БЕЗ живых строк в таблице не трогаем: их JSON — единственная копия строк
//      (старые дубли эпохи гонки — корм G4, не этого скрипта). Стрип их осиротил бы.
//   3. Пишем через writeSyncChanges: вывод строк из помеченного JSON пропускается
//      (`skippedMarked`), таблица не меняется — скрипт только худеет JSON.
// dry-run показывает те же цифры без записи.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api engine-inventory:strip-rows            # dry-run
//   corepack pnpm -F @matricarmz/backend-api engine-inventory:strip-rows -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.
// Apply на проде — мутация прод-данных: только под явный OK владельца в том же ходе (#025).

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

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`engine-inventory:strip-rows — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const conds = [eq(operations.operationType, ENGINE_INVENTORY_STAGE as any), isNull(operations.deletedAt)];
  if (args.engine) conds.push(eq(operations.engineEntityId, args.engine as any));
  const sheets = (await db.select().from(operations).where(and(...conds))) as any[];
  console.log(`  живых листов: ${sheets.length}`);

  const candidates: Array<{ id: string; meta: string; payload: unknown }> = [];
  let alreadyMarked = 0;
  let noRows = 0;
  let broken = 0;
  for (const s of sheets) {
    const meta = s.metaJson == null ? null : String(s.metaJson);
    const payload = safeParse(meta);
    if (!payload || typeof payload !== 'object' || (payload as any).kind !== 'repair_checklist') {
      broken++;
      continue;
    }
    if (inventoryRowsLocation(payload) === 'table') {
      alreadyMarked++;
      continue;
    }
    if (inventoryRawRowsFromPayload(payload).length === 0) {
      noRows++;
      continue;
    }
    candidates.push({ id: String(s.id), meta: meta ?? '', payload });
  }

  const liveByOp = await readExistingLines(candidates.map((c) => c.id));
  const strippable = candidates.filter((c) => (liveByOp.get(c.id) ?? []).some((l) => l.deleted_at == null));
  const noLines = candidates.length - strippable.length;

  let bytesBefore = 0;
  let bytesAfter = 0;
  const strippedById = new Map<string, string>();
  for (const c of strippable) {
    const stripped = JSON.stringify(stripInventoryRowsForStorage(c.payload));
    strippedById.set(c.id, stripped);
    bytesBefore += Buffer.byteLength(c.meta, 'utf8');
    bytesAfter += Buffer.byteLength(stripped, 'utf8');
  }

  console.log(
    `  уже помечены (чистые): ${alreadyMarked}, без секции/битые: ${broken}, пустой rows: ${noRows}\n` +
      `  кандидатов со строками в JSON: ${candidates.length}\n` +
      `  из них БЕЗ живых строк в таблице (не трогаем, корм G4): ${noLines}\n` +
      `  к стрипу: ${strippable.length}, meta_json ${((bytesBefore - bytesAfter) / 1048576).toFixed(1)} МБ → ${(
        bytesAfter / 1048576
      ).toFixed(1)} МБ (экономия ${((bytesBefore - bytesAfter) / 1048576).toFixed(1)} МБ)`,
  );

  if (!args.apply) {
    console.log('\nБез --apply запись не выполняется.');
    return;
  }

  const ts = Date.now();
  const actor = { id: 'server', username: 'engine-inventory:strip-rows', role: 'system' };
  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < strippable.length; i += BATCH) {
    const chunk = strippable.slice(i, i + BATCH);
    const rows = chunk.map((c) => {
      const dto = SyncTableRegistry.toSyncRow(SyncTableName.Operations, sheets.find((s) => String(s.id) === c.id)) as Record<string, unknown>;
      return {
        type: 'upsert' as const,
        table: SyncTableName.Operations,
        row: { ...dto, meta_json: strippedById.get(c.id), updated_at: ts, sync_status: 'synced' },
        row_id: c.id,
      };
    });
    await writeSyncChanges(rows, actor, { allowSyncConflicts: true });
    done += chunk.length;
    console.log(`  записано ${done}/${strippable.length}`);
  }
  console.log('Готово.');
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
