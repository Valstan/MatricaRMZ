import {
  parseRepairHistoryMeta,
  REPAIR_STAGE_CODES,
  SyncTableName,
  SyncTableRegistry,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';
import { pr3CanonicalName } from './pr3StageNames.js';
import { camelOperationRowForSync } from './pr3SyncRow.js';

// stages:refresh-names — перевод подписей stage-строк на канонические имена
// реестра (таблица этапов 05.10.2026, единый источник имён).
//
// Старые строки несут снимки прежних названий (`Принят на завод`, `Сборка`,
// …) — списки и отчёты показывают снимок, поэтому без переписи единый
// источник не держится. Переписываются `action` и `stage.name`;
// id/даты/проход/цех/причина/автор не трогаются. Коды не меняются
// (`kitting_done` — не наша работа: его забирает stages:merge-kitting;
// неизвестные коды пропускаются со счётчиком).
// Пишет через writeSyncChanges (ledger + seq + таблицы), парк видит
// переименования обычным pull'ом.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:refresh-names            # dry-run
//   corepack pnpm -F @matricarmz/backend-api stages:refresh-names -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

const ACTOR: SyncWriteActor = { id: 'server', username: 'stages:refresh-names', role: 'system' };

const KNOWN = new Set<string>(REPAIR_STAGE_CODES);

/**
 * Каноническая meta_json строки (id/даты/проход untouched) либо null, если
 * строка уже канонична. Чистая — покрыта тестами.
 */
export function canonicalStageMetaJson(metaJson: string): string | null {
  const meta = parseRepairHistoryMeta(metaJson);
  if (!meta?.stage || !KNOWN.has(meta.stage.code)) return null;
  const name = pr3CanonicalName(meta.stage.code);
  if (!name) return null;
  if (meta.stage.name === name && meta.action === name) return null;
  return JSON.stringify({ ...meta, action: name, stage: { code: meta.stage.code, name } });
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
  console.log(`stages:refresh-names — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const params: unknown[] = args.engine ? [args.engine] : [];
  const found = (await pool.query(
    `SELECT o.id::text AS id, o.engine_entity_id::text AS engine_id, o.meta_json
       FROM operations o
      WHERE o.operation_type = 'repair_history_entry' AND o.deleted_at IS NULL
        AND o.meta_json LIKE '%"stage":%'
        ${args.engine ? 'AND o.engine_entity_id = $1' : ''}`,
    params,
  )) as { rows: Array<{ id: string; engine_id: string; meta_json: string }> };

  const ts = Date.now();
  const byCode: Record<string, number> = {};
  let skipped = 0;
  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (args.apply) await writeSyncChanges(pending, ACTOR, { allowSyncConflicts: true });
    pending = [];
  };

  for (const row of found.rows) {
    const next = canonicalStageMetaJson(row.meta_json);
    if (next === null) {
      skipped += 1;
      continue;
    }
    if (!args.apply) {
      const code = parseRepairHistoryMeta(row.meta_json)?.stage?.code ?? '?';
      byCode[code] = (byCode[code] ?? 0) + 1;
      continue;
    }
    const current = (await pool.query(`SELECT * FROM operations WHERE id = $1`, [row.id])) as {
      rows: Array<Record<string, unknown>>;
    };
    if (!current.rows[0]) {
      skipped += 1;
      continue;
    }
    const dto = SyncTableRegistry.toSyncRow(
      SyncTableName.Operations,
      camelOperationRowForSync(current.rows[0] as Record<string, unknown>),
    ) as Record<string, unknown>;
    const code = parseRepairHistoryMeta(row.meta_json)?.stage?.code ?? '?';
    byCode[code] = (byCode[code] ?? 0) + 1;
    pending.push({
      type: 'upsert',
      table: SyncTableName.Operations,
      row_id: row.id,
      row: { ...dto, meta_json: next, updated_at: ts, deleted_at: null, sync_status: 'synced' },
    });
    if (pending.length >= 500) await flush();
  }
  await flush();

  console.log(
    ['обновлено по кодам:', ...Object.entries(byCode).map(([k, v]) => `  ${k}: ${v}`), `пропущено (уже канон/неизвестно): ${skipped}`].join(
      '\n',
    ),
  );
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
