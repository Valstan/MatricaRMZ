import 'dotenv/config';

import {
  parseRepairHistoryMeta,
  repairHistoryEntryType,
  SyncTableName,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';

// stages:dedupe-duplicates — чистка дублей строк этапов (план
// work-stages-cleanup-facets-passport-2026-10, P1).
//
// Группа = (двигатель, kind, код) среди живых operations repair_history_entry
// с entryType sheet|stage. Повторные проходы (pass>=2) — НЕ дубли: защищены и
// в разбор не входят. Среди строк с pass<2 при N>1 живым остаётся поздняя
// (по at, при равенстве — по updatedAt), остальные — мягкое удаление через
// writeSyncChanges (журнал + seq: парк узнает, строка погаснет у всех).
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:dedupe-duplicates            # dry-run
//   corepack pnpm -F @matricarmz/backend-api stages:dedupe-duplicates -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Удаление живых данных — гейт #025: --apply только после того, как владелец
// видел конкретный список групп из dry-run. Повторный прогон после apply
// обязан показать 0 групп.
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

type StageRow = {
  id: string;
  engineId: string;
  kind: string;
  code: string;
  at: number | null;
  updatedAt: number;
  pass: number;
  label: string;
};

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
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
  console.log(`stages:dedupe-duplicates — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const engineFilter = args.engine ? ` AND engine_entity_id = $1` : '';
  const params: unknown[] = args.engine ? [args.engine] : [];
  const res = await pool.query(
    `SELECT id, engine_entity_id, operation_type, status, note, performed_at, performed_by,
            meta_json, created_at, updated_at, last_server_seq, deleted_at, sync_status
       FROM operations
      WHERE operation_type = 'repair_history_entry' AND deleted_at IS NULL${engineFilter}`,
    params,
  );

  const groups = new Map<string, StageRow[]>();
  let skippedNoMeta = 0;
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const meta = parseRepairHistoryMeta(typeof r.meta_json === 'string' ? r.meta_json : null);
    const entryType = meta ? repairHistoryEntryType(meta, String(r.operation_type ?? '')) : null;
    let kind = '';
    let code = '';
    if (entryType === 'sheet' && meta?.sheet) {
      kind = 'sheet';
      code = String(meta.sheet.typeCode ?? '').trim().toLowerCase();
    } else if (entryType === 'stage' && meta?.stage) {
      kind = 'stage';
      code = String(meta.stage.code ?? '').trim().toLowerCase();
    } else {
      skippedNoMeta += 1;
      continue;
    }
    if (!code) {
      skippedNoMeta += 1;
      continue;
    }
    const pass = Number(meta?.repeat?.pass ?? 1);
    const row: StageRow = {
      id: String(r.id),
      engineId: String(r.engine_entity_id),
      kind,
      code,
      at: meta?.at != null && Number.isFinite(Number(meta.at)) ? Number(meta.at) : null,
      updatedAt: Number(r.updated_at ?? 0),
      pass: Number.isFinite(pass) && pass >= 1 ? Math.floor(pass) : 1,
      label: `${kind}:${code}`,
    };
    const key = `${row.engineId}|${kind}|${code}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const ts = Date.now();
  const actor: SyncWriteActor = { id: 'server', username: 'stages:dedupe-duplicates', role: 'system' };
  const byId = new Map((res.rows as Array<Record<string, unknown>>).map((r) => [String(r.id), r]));
  let groupsTotal = 0;
  let deleteTotal = 0;
  let protectedTotal = 0;
  const pending: SyncWriteInput[] = [];

  for (const [, bucket] of [...groups.entries()].sort()) {
    const plain = bucket.filter((b) => b.pass < 2);
    protectedTotal += bucket.length - plain.length;
    if (plain.length < 2) continue;
    groupsTotal += 1;
    const ordered = [...plain].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.updatedAt - b.updatedAt);
    const survivor = ordered[ordered.length - 1]!;
    const victims = ordered.slice(0, -1);
    console.log(`группа ${bucket[0]!.engineId} ${bucket[0]!.label}: строк ${bucket.length}, живёт ${survivor.id} (at=${survivor.at ?? '—'})`);
    for (const v of victims) {
      console.log(`  − ${v.id} (at=${v.at ?? '—'})`);
      const src = byId.get(v.id);
      if (!src) continue;
      pending.push({
        type: 'delete',
        table: SyncTableName.Operations,
        row: {
          id: String(src.id),
          engine_entity_id: String(src.engine_entity_id),
          operation_type: String(src.operation_type),
          status: String(src.status ?? 'done'),
          note: src.note == null ? null : String(src.note),
          performed_at: num(src.performed_at),
          performed_by: src.performed_by == null ? null : String(src.performed_by),
          meta_json: typeof src.meta_json === 'string' ? src.meta_json : null,
          created_at: Number(src.created_at ?? ts),
          updated_at: ts,
          last_server_seq: src.last_server_seq == null ? null : Number(src.last_server_seq),
          deleted_at: ts,
          sync_status: 'synced',
        },
        row_id: String(src.id),
      });
      deleteTotal += 1;
    }
  }

  if (args.apply) {
    for (let i = 0; i < pending.length; i += 500) {
      await writeSyncChanges(pending.slice(i, i + 500), actor, { allowSyncConflicts: true });
    }
  }

  console.log(`\nгрупп-дублей: ${groupsTotal}, к удалению: ${deleteTotal}, защищено повторов: ${protectedTotal}, пропущено без мета: ${skippedNoMeta}`);
  if (!args.apply) console.log('Без --apply запись не выполняется.');
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
