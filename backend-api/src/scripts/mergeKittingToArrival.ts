import {
  parseRepairHistoryMeta,
  SyncTableName,
  SyncTableRegistry,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';
import { pr3CanonicalName } from './pr3StageNames.js';
import { camelOperationRowForSync } from './pr3SyncRow.js';

// stages:merge-kitting — снос `kitting_done` слиянием в `arrival`
// (таблица этапов 05.10.2026, решение владельца).
//
// Правило на строку (идемпотентно, повтор безопасен):
//   - у двигателя уже есть живая строка `arrival` → kitting-строка гасится
//     (дубль: дата приёмки уже представлена; типичный случай — бэкфилл из
//     `arrival_date` уже создал arrival);
//   - arrival-строки нет → kitting-строка ПЕРЕПИСЫВАЕТСЯ в arrival тем же id
//     (дата осмотра сохраняется — это единственное свидетельство приёмки).
// Имена/действия — канонические из реестра. Пишет через writeSyncChanges
// (ledger + seq + таблицы), поэтому парк видит слияние обычным pull'ом.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:merge-kitting            # dry-run
//   corepack pnpm -F @matricarmz/backend-api stages:merge-kitting -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

const ACTOR: SyncWriteActor = { id: 'server', username: 'stages:merge-kitting', role: 'system' };

type KittingRow = { id: string; engineId: string; meta_json: string };

export type KittingDecision = 'delete' | 'convert';

export function decideKittingRow(hasArrivalRow: boolean): KittingDecision {
  return hasArrivalRow ? 'delete' : 'convert';
}

/** Переписанная meta kitting-строки: тот же id/даты/проход, код и подписи — arrival. */
export function buildConvertedMetaJson(metaJson: string): string {
  const meta = parseRepairHistoryMeta(metaJson);
  if (!meta?.stage || meta.stage.code !== 'kitting_done') {
    throw new Error('не kitting-строка — решение устарело');
  }
  const name = pr3CanonicalName('arrival');
  if (!name) throw new Error('нет канона arrival — решение устарело');
  const at = typeof meta.at === 'number' && Number.isFinite(meta.at) && meta.at > 0 ? meta.at : undefined;
  return JSON.stringify({
    ...meta,
    action: name,
    ...(at !== undefined ? { at } : {}),
    stage: { code: 'arrival', name },
  });
}

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
  console.log(`stages:merge-kitting — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const params: unknown[] = args.engine ? [args.engine] : [];
  const kitting = (await pool.query(
    `SELECT o.id::text AS id, o.engine_entity_id::text AS "engineId", o.meta_json
       FROM operations o
      WHERE o.operation_type = 'repair_history_entry' AND o.deleted_at IS NULL
        AND o.meta_json::json->'stage'->>'code' = 'kitting_done'
        ${args.engine ? 'AND o.engine_entity_id = $1' : ''}`,
    params,
  )) as { rows: KittingRow[] };

  const engineIds = [...new Set(kitting.rows.map((r) => r.engineId))];
  const withArrival = new Set<string>();
  if (engineIds.length > 0) {
    const arr = (await pool.query(
      `SELECT DISTINCT o.engine_entity_id::text AS "engineId"
         FROM operations o
        WHERE o.operation_type = 'repair_history_entry' AND o.deleted_at IS NULL
          AND o.meta_json::json->'stage'->>'code' = 'arrival'
          AND o.engine_entity_id = ANY($1)`,
      [engineIds],
    )) as { rows: Array<{ engineId: string }> };
    for (const r of arr.rows) withArrival.add(r.engineId);
  }

  const ts = Date.now();
  let deleted = 0;
  let converted = 0;
  let skipped = 0;
  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (args.apply) await writeSyncChanges(pending, ACTOR, { allowSyncConflicts: true });
    pending = [];
  };

  for (const row of kitting.rows) {
    const meta = parseRepairHistoryMeta(row.meta_json);
    if (!meta?.stage || meta.stage.code !== 'kitting_done' || !row.engineId) {
      skipped += 1;
      continue;
    }
    const decision = decideKittingRow(withArrival.has(row.engineId));
    if (!args.apply) {
      console.log(`  ${decision.toUpperCase()} ${row.engineId} ${row.id} (kitting ${meta.at ?? 'без даты'})`);
    }
    if (decision === 'delete') {
      const found = await pool.query(`SELECT * FROM operations WHERE id = $1`, [row.id]);
      const current = (found as { rows: Array<Record<string, unknown>> }).rows[0];
      if (!current) {
        skipped += 1;
        continue;
      }
      const dto = SyncTableRegistry.toSyncRow(
        SyncTableName.Operations,
        camelOperationRowForSync(current),
      ) as Record<string, unknown>;
      pending.push({
        type: 'delete',
        table: SyncTableName.Operations,
        row_id: row.id,
        row: { ...dto, updated_at: ts, deleted_at: ts, sync_status: 'synced' },
      });
      deleted += 1;
    } else {
      const found = await pool.query(`SELECT * FROM operations WHERE id = $1`, [row.id]);
      const current = (found as { rows: Array<Record<string, unknown>> }).rows[0];
      if (!current) {
        skipped += 1;
        continue;
      }
      const dto = SyncTableRegistry.toSyncRow(
      SyncTableName.Operations,
      camelOperationRowForSync(current),
    ) as Record<string, unknown>;
      pending.push({
        type: 'upsert',
        table: SyncTableName.Operations,
        row_id: row.id,
        row: {
          ...dto,
          meta_json: buildConvertedMetaJson(String(dto.meta_json ?? row.meta_json)),
          updated_at: ts,
          deleted_at: null,
          sync_status: 'synced',
        },
      });
      converted += 1;
    }
    if (pending.length >= 500) await flush();
  }
  await flush();

  console.log(`\ndelete: ${deleted}, convert: ${converted}, skipped: ${skipped}`);
  if (!args.apply) console.log('Без --apply запись не выполняется.');
}

const invokedDirectly = typeof process.argv[1] === 'string' && process.argv[1].endsWith('.ts');
if (invokedDirectly) {
  main()
    .catch((e: unknown) => {
      console.error(String((e as Error)?.message ?? e));
      process.exitCode = 2;
    })
    .finally(() => void pool.end().catch(() => {}));
}
