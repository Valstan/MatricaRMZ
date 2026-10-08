import 'dotenv/config';

import {
  isStageBackwardMove,
  moscowDayKey,
  parseRepairHistoryMeta,
  resolveStageCode,
  SyncTableName,
  SyncTableRegistry,
  type DatedStage,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';
import { camelOperationRowForSync } from './pr3SyncRow.js';

// stages:recount-passes — снять ложные «возвраты», поставленные датой внесения,
// а не датой этапа (баг 09.10.2026: поздно внесённая сборка с ранней датой при живом
// shipped получала pass≥2, потому что isStageBackwardMove смотрел только ранги).
//
// Правила:
//   - пересчёт тем же предикатом, что теперь решает при записи (с датой строки);
//   - снимаем `repeat` только у системных пометок (без `reason`): операторское
//     подтверждение (`reason`) — осознанное, его не трогаем, только считаем;
//   - ничего не добавляем: строка, которая и по датам возврат, остаётся как была;
//   - только ЖИВЫЕ двигатели (мягко удалённые пропускаем — их история никому не нужна);
//   - идемпотентно: повторный прогон обязан показать 0; запись через writeSyncChanges
//     (журнал + seq) — парк видит обычным pull.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:recount-passes            # dry-run
//   corepack pnpm -F @matricarmz/backend-api stages:recount-passes -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Снятие чужих пометок — гейт #025: --apply только после того, как владелец видел
// конкретный список из dry-run.
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

const ACTOR: SyncWriteActor = { id: 'server', username: 'stages:recount-passes', role: 'system' };

type RawRow = Record<string, unknown>;

type StageRow = {
  id: string;
  engineId: string;
  code: string;
  at: number;
  pass: number;
  reason: string;
  raw: RawRow;
};

/** Строка operations (snake_case из pg) → payload журнала. */
function toSyncRow(raw: RawRow): Record<string, unknown> {
  return SyncTableRegistry.toSyncRow(SyncTableName.Operations, camelOperationRowForSync(raw)) as Record<string, unknown>;
}

/** Разбор `meta_json` строки как сырого объекта (не теряет незнакомые поля). */
function rawMetaOf(raw: RawRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw.meta_json ?? 'null'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function reload(id: string): Promise<RawRow | null> {
  const found = (await pool.query(`SELECT * FROM operations WHERE id = $1`, [id])) as { rows: RawRow[] };
  return found.rows[0] ?? null;
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

export type RecountVerdict = 'clear' | 'keep' | 'keep-operator';

/**
 * Решение по строке с pass≥2: снимаем системную пометку, если по датам это не возврат.
 * Операторское подтверждение и настоящие возвраты не трогаем никогда.
 */
export function recountVerdict(row: Pick<StageRow, 'id' | 'code' | 'at' | 'pass' | 'reason'>, siblings: DatedStage[]): RecountVerdict {
  if (row.pass < 2) return 'keep';
  if (row.reason) return 'keep-operator';
  // Себя исключаем (правка не сравнивает строку саму с собой), остальное — как при записи.
  const dated = siblings.filter((s) => s.id !== row.id);
  const backward = isStageBackwardMove(dated, row.code as DatedStage['code'], row.at);
  return backward ? 'keep' : 'clear';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`stages:recount-passes — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const engineFilter = args.engine ? ' AND engine_entity_id = $1' : '';
  const params: unknown[] = args.engine ? [args.engine] : [];
  const found = (await pool.query(
    `SELECT * FROM operations
       WHERE operation_type = 'repair_history_entry' AND deleted_at IS NULL${engineFilter}`,
    params,
  )) as { rows: RawRow[] };

  const byEngine = new Map<string, StageRow[]>();
  let skippedNoMeta = 0;
  for (const raw of found.rows) {
    const meta = parseRepairHistoryMeta(typeof raw.meta_json === 'string' ? raw.meta_json : null);
    if (!meta?.stage) {
      skippedNoMeta += 1;
      continue;
    }
    const at = typeof meta.at === 'number' && Number.isFinite(meta.at) && meta.at > 0 ? meta.at : null;
    if (at == null) continue;
    const pass = Number(meta.repeat?.pass ?? 1);
    const engineId = String(raw.engine_entity_id ?? '');
    if (!engineId) continue;
    const arr = byEngine.get(engineId) ?? [];
    arr.push({
      id: String(raw.id),
      engineId,
      code: resolveStageCode(String(meta.stage.code ?? '')),
      at,
      pass: Number.isFinite(pass) && pass >= 1 ? Math.floor(pass) : 1,
      reason: String(meta.repeat?.reason ?? '').trim(),
      raw,
    });
    byEngine.set(engineId, arr);
  }

  // Живые двигатели: мягко удалённые пропускаем.
  const engineIds = [...byEngine.keys()];
  const live = new Set<string>();
  for (let i = 0; i < engineIds.length; i += 500) {
    const chunk = engineIds.slice(i, i + 500);
    const res = (await pool.query(`SELECT id::text AS id FROM entities WHERE id = ANY($1) AND deleted_at IS NULL`, [
      chunk,
    ])) as { rows: Array<{ id: string }> };
    for (const r of res.rows) live.add(String(r.id));
  }

  const ts = Date.now();
  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (args.apply) await writeSyncChanges(pending, ACTOR, { allowSyncConflicts: true });
    pending = [];
  };

  let cleared = 0;
  let kept = 0;
  let keptOperator = 0;
  let skippedDeleted = 0;
  for (const [engineId, rows] of [...byEngine.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!live.has(engineId)) {
      skippedDeleted += rows.filter((r) => r.pass >= 2).length;
      continue;
    }
    const siblings: DatedStage[] = rows.map((r) => ({ code: r.code as DatedStage['code'], at: r.at, id: r.id }));
    for (const row of rows.filter((r) => r.pass >= 2).sort((a, b) => a.at - b.at)) {
      const verdict = recountVerdict(row, siblings);
      if (verdict === 'keep-operator') {
        keptOperator += 1;
        console.log(`  KEEP-OPER ${engineId} ${row.code} ${moscowDayKey(row.at)} pass=${row.pass} «${row.reason}» — подтверждение оператора`);
        continue;
      }
      if (verdict === 'keep') {
        kept += 1;
        continue;
      }
      console.log(`  CLEAR ${engineId} ${row.code} ${moscowDayKey(row.at)} pass=${row.pass} → 1 (по датам не возврат)`);
      if (args.apply) {
        const cur = await reload(row.id);
        if (!cur) continue;
        const rawMeta = rawMetaOf(cur);
        delete rawMeta.repeat;
        pending.push({
          type: 'upsert',
          table: SyncTableName.Operations,
          row_id: row.id,
          row: { ...toSyncRow(cur), meta_json: JSON.stringify(rawMeta), updated_at: ts, deleted_at: null, sync_status: 'synced' },
        });
      }
      cleared += 1;
      if (pending.length >= 500) await flush();
    }
  }
  await flush();

  console.log(
    `\nИтог: снять ${cleared}, оставлено настоящих возвратов ${kept}, ` +
      `операторских подтверждений не тронуто ${keptOperator}, ` +
      `пропущено у удалённых ${skippedDeleted}, не-этапов пропущено ${skippedNoMeta}.`,
  );
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
