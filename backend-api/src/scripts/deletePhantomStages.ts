import {
  parseRepairHistoryMeta,
  SyncTableName,
  SyncTableRegistry,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';

// stages:delete-phantom — снос 21 строки-призрака «Разборка/Дефектовка» от 02.10.2026.
//
// Происхождение (аудит 05.10.2026, PR3): старая авто-метка дефектовки срабатывала
// на КАЖДОМ сохранении листа (триггер читал выведенный repairable_qty), и массовая
// простановка дат отгрузки 02.10 (mubvera — 13 строк, fatyhova — 7, valstan — 1)
// наштамповала разборку двигателям без единого решения по деталям. Проверка:
// ни у одного из 20 двигателей нет defect_date, ни одной строки с утилем/заменой
// и ни одного более позднего этапа — genuine-дефектовки среди них нет.
//
// Список ID — явный (не предикат): перевыполнение исключено. Каждая строка перед
// сносом перепроверяется (жива + код disassembly_defect + записана 02.10.2026),
// чужое пропускается со счётчиком. Гасится tombstone через writeSyncChanges —
// парк видит удаление обычным pull'ом.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:delete-phantom            # dry-run
//   corepack pnpm -F @matricarmz/backend-api stages:delete-phantom -- --apply
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

const ACTOR: SyncWriteActor = { id: 'server', username: 'stages:delete-phantom', role: 'system' };

const PHANTOM_IDS: readonly string[] = [
  '83192874-7faf-4dc9-bfba-9d143c108571',
  '17555208-6d54-4c7c-822a-d9f7d360c1f9',
  '0ddba735-41b0-43bc-8360-7fba01693449',
  'b6f7186c-0fc5-479a-9df6-71c7418bbf5d',
  '853dd5c8-53de-4c31-9b7e-bd7b5a1e5150',
  'bbe708f7-881e-49ac-a869-14bf74e286fd',
  '1251255e-2295-4c2a-a5a2-0561f058caf4',
  '476b5024-43bc-450b-b81b-4051e0b4eb37',
  'aa73e4ea-01ec-4c39-882836b698',
  'b44951a8-0d48-4581-a8ef-15c083fc77ce',
  'ccfbcfb4-c28f-4ffd-8cd2-3b95be7cbe97',
  '777c9587-337f-47b3-8f2b-79642ad1be96',
  '230a8066-65f4-4777-9e2d-a531f1a75957',
  'c524a7f6-d690-4973-9790-94ec7482b48f',
  '1d970ebf-b546-4c68-ae29-a394db169c5a',
  '87bf340e-59de-4121-94af-bd0bd4630868',
  '25353abc-85da-4c0e-9347-da7af4cef718',
  '8d22db2d-47c8-4058-a7a8-949e1c463c37',
  '1ccd5956-7068-4296-a34a-e646b47207df',
  '8f08fb15-8f7b-447e-985c-1a765cafc265',
  'fd15ce06-467d-45de-85ea-76723f96e653',
];

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

  const ts = Date.now();
  let deleted = 0;
  let skipped = 0;
  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (args.apply) await writeSyncChanges(pending, ACTOR, { allowSyncConflicts: true });
    pending = [];
  };

  for (const id of PHANTOM_IDS) {
    const found = (await pool.query(`SELECT * FROM operations WHERE id = $1`, [id])) as {
      rows: Array<Record<string, unknown>>;
    };
    const row = found.rows[0];
    const meta = row ? parseRepairHistoryMeta(String(row.meta_json ?? '')) : null;
    const writtenDay =
      typeof row?.performed_at === 'number' && Number.isFinite(row.performed_at)
        ? new Date(Number(row.performed_at)).toISOString().slice(0, 10)
        : '';
    const ok =
      !!row &&
      row.deleted_at == null &&
      meta?.stage?.code === 'disassembly_defect' &&
      writtenDay === '2026-10-02';
    if (!ok) {
      console.log(`  SKIP ${id} (не фантом: нет/погашена/другой код/дата)`);
      skipped += 1;
      continue;
    }
    if (!args.apply) {
      console.log(`  DELETE ${id} engine=${String(row.engine_entity_id ?? '?').slice(0, 8)}`);
    } else {
      const dto = SyncTableRegistry.toSyncRow(SyncTableName.Operations, row as never) as Record<string, unknown>;
      pending.push({
        type: 'delete',
        table: SyncTableName.Operations,
        row_id: id,
        row: { ...dto, updated_at: ts, deleted_at: ts, sync_status: 'synced' },
      });
      deleted += 1;
      if (pending.length >= 500) await flush();
    }
  }
  await flush();

  console.log(`\nк удалению: ${args.apply ? deleted : PHANTOM_IDS.length - skipped}, пропущено: ${skipped}`);
  if (!args.apply) console.log('Без --apply запись не выполняется.');
}

main()
  .catch((e: unknown) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));
