import 'dotenv/config';

import { SyncTableName } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';

// engines:backfill-card-updated-at — подтяжка `entities.updated_at` живых двигателей
// до максимума с историей (владелец 10.10.2026: история — часть карточки).
//
// Почему накопленное: записи операций (этапы работ, листы, акты, ручные записи
// ленты) не трогали сущность — колонка «дата изменения» списка стояла на месте,
// хотя история уходила вперёд. Код исправлен (touch при записи операций на
// клиенте и в applyPushBatch), скрипт закрывает накопленное.
//
// Правила:
//   - только ЖИВЫЕ двигатели (`entities` + тип `engine`, без tombstone);
//   - новая дата = max(entities.updated_at, max живых operations.updated_at);
//     только вперёд, задним числом не двигаем;
//   - пишут только отставшие (ops-max строго больше текущей);
//   - идемпотентно: повтор ничего не пишет;
//   - пишет через writeSyncChanges (журнал + seq) — парк видит обычным pull.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api engines:backfill-card-updated-at            # dry-run
//   corepack pnpm -F @matricarmz/backend-api engines:backfill-card-updated-at -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Коды возврата: 0 — ок; 1 — были ошибки записи; 2 — отказ/ошибка.

const ACTOR: SyncWriteActor = { id: 'server', username: 'engines:backfill-card-updated-at', role: 'system' };

function parseArgs(argv: string[]): { apply: boolean; engine: string | null; samples: number } {
  const out = { apply: false, engine: null as string | null, samples: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--apply') out.apply = true;
    else if (a === '--engine') out.engine = String(argv[++i] ?? '').trim() || null;
    else if (a === '--samples') {
      const next = Number(argv[++i]);
      if (Number.isFinite(next) && next >= 0) out.samples = Math.trunc(next);
    } else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

type Candidate = { id: string; typeId: string; createdAt: number; from: number; to: number };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`engines:backfill-card-updated-at — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const engineFilter = args.engine ? ' AND e.id = $1' : '';
  const params: unknown[] = args.engine ? [args.engine] : [];
  const rows = (await pool.query(
    `SELECT e.id::text AS id, e.type_id::text AS type_id,
            e.created_at AS created_at, e.updated_at AS updated_at,
            (SELECT max(o.updated_at) FROM operations o
              WHERE o.engine_entity_id = e.id AND o.deleted_at IS NULL) AS ops_max
       FROM entities e
       JOIN entity_types et ON et.id = e.type_id AND et.code = 'engine'
      WHERE e.deleted_at IS NULL${engineFilter}`,
    params,
  )) as { rows: Array<Record<string, unknown>> };

  const stale: Candidate[] = [];
  let fresh = 0;
  let futureCapped = 0;
  const now = Date.now();
  for (const r of rows.rows) {
    const updatedAt = Number(r.updated_at);
    const opsMax = r.ops_max == null ? null : Number(r.ops_max);
    if (opsMax == null || !Number.isFinite(opsMax) || opsMax <= updatedAt) {
      fresh += 1;
      continue;
    }
    // Дата изменения — факт записи, в будущее не двигаем (часы клиентов врут).
    const to = Math.min(opsMax, now);
    if (to <= updatedAt) {
      futureCapped += 1;
      continue;
    }
    stale.push({
      id: String(r.id),
      typeId: String(r.type_id),
      createdAt: Number(r.created_at),
      from: updatedAt,
      to,
    });
  }

  console.log(`живых двигателей: ${rows.rows.length}, в норме: ${fresh}, отставших: ${stale.length}, упёрлись в now: ${futureCapped}`);
  for (const c of stale.slice(0, args.samples)) {
    console.log(
      `  ${c.id} ${new Date(c.from).toISOString().slice(0, 10)} → ${new Date(c.to).toISOString().slice(0, 10)}`,
    );
  }
  if (stale.length > args.samples) console.log(`  … и ещё ${stale.length - args.samples}`);

  let applied = 0;
  let failed = 0;
  if (args.apply && stale.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < stale.length; i += CHUNK) {
      const chunk = stale.slice(i, i + CHUNK);
      const inputs: SyncWriteInput[] = chunk.map((c) => ({
        type: 'upsert',
        table: SyncTableName.Entities,
        row_id: c.id,
        row: {
          id: c.id,
          type_id: c.typeId,
          created_at: c.createdAt,
          updated_at: c.to,
          deleted_at: null,
          sync_status: 'synced',
        },
      }));
      try {
        await writeSyncChanges(inputs, ACTOR, { allowSyncConflicts: true });
        applied += chunk.length;
      } catch (err) {
        failed += chunk.length;
        console.error(`chunk ${i}-${i + chunk.length}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`apply: записано ${applied}, ошибок ${failed}`);
  } else if (!args.apply && stale.length > 0) {
    console.log('Повторить с --apply для записи.');
  }

  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(2);
});
