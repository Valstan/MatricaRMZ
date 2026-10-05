import {
  parseRepairHistoryMeta,
  SyncTableName,
  SyncTableRegistry,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';
import { camelOperationRowForSync } from './pr3SyncRow.js';

// stages:delete-phantom — снос 21 строки-призрака «Разборка/Дефектовка» от 02.10.2026.
//
// Происхождение (аудит 05.10.2026, PR3): старая авто-метка дефектовки срабатывала
// на КАЖДОМ сохранении листа (триггер читал выведенный repairable_qty), и массовая
// простановка дат отгрузки 02.10 (mubvera — 13 строк, fatyhova — 7, valstan — 1)
// наштамповала разборку двигателям без единого решения по деталям. Проверка:
// ни у одного из 20 двигателей нет defect_date, ни одной строки с утилем/заменой
// и ни одного более позднего этапа — genuine-дефектовки среди них нет.
//
// Отбор — предикатом, а НЕ списком ID: UUID из консольного вывода страдают
// транзитными выпадениями символов, и захардкоженный список тихо промахнулся бы.
// Предикат тот же, что в аудите (§7): код disassembly_defect + запись 02.10.2026.
// СТРОЖ: ожидаем ровно 21 строку — другое число = данные ушли, отказ без записи.
//
// Гасится tombstone через writeSyncChanges — парк видит удаление обычным pull'ом.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:delete-phantom            # dry-run
//   corepack pnpm -F @matricarmz/backend-api stages:delete-phantom -- --apply
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

const ACTOR: SyncWriteActor = { id: 'server', username: 'stages:delete-phantom', role: 'system' };

const EXPECTED_COUNT = 21;

type PhantomRow = { id: string; engineId: string; metaJson: string };

async function findPhantomRows(): Promise<PhantomRow[]> {
  const found = (await pool.query(
    `SELECT o.id::text AS id, o.engine_entity_id::text AS "engineId", o.meta_json
       FROM operations o
      WHERE o.operation_type = 'repair_history_entry' AND o.deleted_at IS NULL
        AND o.meta_json::json->'stage'->>'code' = 'disassembly_defect'
        AND to_timestamp(o.performed_at/1000)::date = date '2026-10-02'`,
  )) as { rows: Array<{ id: string; engineId: string; meta_json: string }> };
  return found.rows.map((r) => ({
    id: String(r.id ?? ''),
    engineId: String(r.engineId ?? ''),
    metaJson: typeof r.meta_json === 'string' ? r.meta_json : JSON.stringify(r.meta_json ?? ''),
  }));
}

function parseArgs(argv: string[]): { apply: boolean } {
  const out = { apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`stages:delete-phantom — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const rows = await findPhantomRows();
  if (rows.length !== EXPECTED_COUNT) {
    throw new Error(`фантомов ${rows.length}, ждали ${EXPECTED_COUNT} — данные ушли, отказ без записи`);
  }

  const ts = Date.now();
  let deleted = 0;
  let skipped = 0;
  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (args.apply) await writeSyncChanges(pending, ACTOR, { allowSyncConflicts: true });
    pending = [];
  };

  for (const row of rows) {
    const meta = parseRepairHistoryMeta(row.metaJson);
    if (!meta?.stage || meta.stage.code !== 'disassembly_defect' || !row.engineId) {
      console.log(`  SKIP ${row.id} (не фантом)`);
      skipped += 1;
      continue;
    }
    if (!args.apply) {
      console.log(`  DELETE ${row.engineId.slice(0, 8)} ${row.id.slice(0, 8)}`);
      deleted += 1;
      continue;
    }
    const found = (await pool.query(`SELECT * FROM operations WHERE id::text = $1`, [row.id])) as {
      rows: Array<Record<string, unknown>>;
    };
    const current = found.rows[0];
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
    if (pending.length >= 500) await flush();
  }
  await flush();

  console.log(`\nк удалению: ${deleted}, пропущено: ${skipped}`);
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
