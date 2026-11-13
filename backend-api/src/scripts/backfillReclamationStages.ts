import 'dotenv/config';

import { createHash } from 'node:crypto';

import {
  buildRepairHistoryMeta,
  moscowDayKey,
  parseRepairHistoryMeta,
  RECLAMATION_ARRIVAL_STAGE_CODE,
  RECLAMATION_SHIPPED_STAGE_CODE,
  SyncTableName,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { pr3CanonicalName } from './pr3StageNames.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';

// stages:backfill-reclamations — разовый перенос приёмок и ОТПРАВОК по рекламации в ЭТАПЫ
// единого списка (владелец 11.11.2026 — приёмка: «приход по рекламации приравнивается к
// приемке двигателя на заводе»; владелец 13.11.2026 — отправка: «надо его в историю ремонта
// тоже добавить, чтобы и показывалось в истории, и фильтровалось, и было полноценным
// участником процесса, и в отчётах и в списках»).
//
// Что делает. Для каждой живой строки очереди заездов (`erp_engine_reclamations`):
//   · с датой приёма — этап `arrival_reclamation` («Приемка двигателя на завод по
//     рекламации») на дату приёма;
//   · с датой отправки — этап `shipped_reclamation` («Отгрузка двигателя заказчику по
//     рекламации») на дату отправки.
//
// До этого приёмка жила отдельной строчкой в ленте («Приём по рекламации №1»), а отправка
// и вовсе нигде: в колонке «этап» её не было, и отбор по этапам её не ловил.
//
// Источник правды — очередь заездов. Дедуп — по (двигатель, номер рекламации в очереди, код
// этапа): повторный прогон ничего не плодит, а уже заведённая вручную строка этапа не мешает.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:backfill-reclamations            # dry-run
//   corepack pnpm -F @matricarmz/backend-api stages:backfill-reclamations -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

function parseArgs(argv: string[]): { apply: boolean; engine: string | null } {
  const out = { apply: false, engine: null as string | null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '--apply') out.apply = true;
    else if (a === '--engine') {
      const v = argv[i + 1] ?? '';
      if (v && !v.startsWith('--')) {
        out.engine = v;
        i += 1;
      }
    }
  }
  return out;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Детерминированный uuid строки: повторный прогон не плодит.
 *
 * Ключи приёмки и отправки РАЗНЫЕ и не меняются от прогона к прогону: у приёмки ключ
 * прежний (строки уже заведены на проде 11.11 — новый ключ создал бы вторую строку
 * приёмки рядом с первой).
 */
function stageRowId(engineId: string, queueNo: number, code: string): string {
  const key = code === RECLAMATION_SHIPPED_STAGE_CODE ? 'reclamation-shipped-stage' : 'reclamation-arrival-stage';
  const h = createHash('sha1').update(`${key}\u0000${engineId}\u0000${queueNo}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Этапы одного заезда: код этапа и колонка очереди с его датой. */
const STAGE_KINDS = [
  { code: RECLAMATION_ARRIVAL_STAGE_CODE, dateColumn: 'accepted_at' },
  { code: RECLAMATION_SHIPPED_STAGE_CODE, dateColumn: 'shipped_at' },
] as const;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `stages:backfill-reclamations — ${args.apply ? 'РЕЖИМ ЗАПИСИ' : 'dry-run, ничего не меняется'}${args.engine ? ` (двигатель ${args.engine})` : ''}`,
  );

  const counts: Record<string, number> = {};
  const params: unknown[] = [];
  let engineFilter = '';
  if (args.engine) {
    params.push(args.engine);
    engineFilter = ' AND r.engine_id = $1';
  }

  // 1. Очередь заездов: живые строки с датами приёма и отправки.
  const queue = await pool.query(
    `SELECT r.engine_id, r.queue_no, r.accepted_at, r.shipped_at
       FROM erp_engine_reclamations r
       JOIN entities e ON e.id = r.engine_id
      WHERE r.deleted_at IS NULL AND e.deleted_at IS NULL${engineFilter}
      ORDER BY r.engine_id, r.queue_no`,
    params,
  );

  // 2. Уже заведённые строки этапа: по номеру рекламации (метка в meta) и по дню.
  const takenQueue = new Set<string>();
  const takenDay = new Set<string>();
  const existing = await pool.query(
    `SELECT engine_entity_id, meta_json FROM operations
      WHERE operation_type = 'repair_history_entry' AND deleted_at IS NULL
        AND meta_json LIKE '%"stage":%'${engineFilter}`,
    params,
  );
  for (const r of existing.rows as Array<Record<string, unknown>>) {
    const meta = parseRepairHistoryMeta(typeof r.meta_json === 'string' ? r.meta_json : null);
    if (!meta?.stage) continue;
    const engineId = String(r.engine_entity_id);
    if (meta.reclamation) takenQueue.add(`${engineId}|${meta.reclamation.queueNo}|${meta.stage.code}`);
    const at = num(meta.at);
    if (at !== null) takenDay.add(`${engineId}|${meta.stage.code}|${moscowDayKey(at)}`);
  }

  const ts = Date.now();
  const actor: SyncWriteActor = { id: 'server', username: 'stages:backfill-reclamations', role: 'system' };
  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (args.apply) await writeSyncChanges(pending, actor, { allowSyncConflicts: true });
    pending = [];
  };

  for (const r of queue.rows as Array<Record<string, unknown>>) {
    const engineId = String(r.engine_id);
    const queueNo = Math.floor(num(r.queue_no) ?? 0);
    if (queueNo < 1) {
      counts['skipped-bad-queue-no'] = (counts['skipped-bad-queue-no'] ?? 0) + 1;
      continue;
    }
    for (const kind of STAGE_KINDS) {
      const at = num(r[kind.dateColumn]);
      if (at === null) {
        counts[`skipped-no-${kind.dateColumn}`] = (counts[`skipped-no-${kind.dateColumn}`] ?? 0) + 1;
        continue;
      }
      const queueKey = `${engineId}|${queueNo}|${kind.code}`;
      if (takenQueue.has(queueKey)) {
        counts['skipped-already-marks-queue'] = (counts['skipped-already-marks-queue'] ?? 0) + 1;
        continue;
      }
      const dayKey = `${engineId}|${kind.code}|${moscowDayKey(at)}`;
      if (takenDay.has(dayKey)) {
        counts['skipped-duplicate-day'] = (counts['skipped-duplicate-day'] ?? 0) + 1;
        continue;
      }
      takenQueue.add(queueKey);
      takenDay.add(dayKey);
      const stageName = pr3CanonicalName(kind.code) ?? kind.code;
      const meta = buildRepairHistoryMeta({
        action: stageName,
        auto: true,
        at,
        entryType: 'stage',
        stage: { code: kind.code, name: stageName },
        reclamation: { queueNo },
      });
      const id = stageRowId(engineId, queueNo, kind.code);
      pending.push({
        type: 'upsert',
        table: SyncTableName.Operations,
        row: {
          id,
          engine_entity_id: engineId,
          operation_type: 'repair_history_entry',
          status: 'done',
          note: `Этап: ${stageName}`,
          performed_at: ts,
          performed_by: actor.username,
          meta_json: JSON.stringify(meta),
          created_at: ts,
          updated_at: ts,
          deleted_at: null,
          sync_status: 'synced',
        },
        row_id: id,
      });
      counts.insert = (counts.insert ?? 0) + 1;
      if (pending.length >= 500) await flush();
    }
  }
  await flush();

  console.log(
    Object.entries(counts)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n'),
  );
  if (!args.apply) console.log('\nБез --apply запись не выполняется.');
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
