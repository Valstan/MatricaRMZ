/**
 * Публикация сида приказа о СИЗ в зеркало парка.
 *
 * Зачем: приказные данные попадают в базу МИГРАЦИЯМИ, а миграция вставляет
 * строки с `sync_status = 'synced'` — мимо пути записи синхронизации. Штатный
 * публикатор зеркала СИЗ берёт строки со `sync_status <> 'synced'`, поэтому
 * сид в журнал синка не попадает НИКОГДА: на проде в журнале лежало 220 строк
 * приказа из 241, 49 наборов из 63 и 333 позиции номенклатуры СИЗ из 424 —
 * то есть все строки миграций 0119–0121 (4 новые профессии, 13 заводских норм)
 * до парка не доехали.
 *
 * Что страдает: интерфейс кладовщика читает приказ по серверу (REST `/ppe/*`) и
 * показывает верные данные, но ПЕЧАТЬ бланка выдачи и отчёты строятся по
 * локальной реплике клиента — там этих строк нет.
 *
 * Скрипт публикует в журнал то, что уже есть в базе: номенклатуру СИЗ,
 * профессии, приказные строки, наборы норм и строки наборов. Порядок важен —
 * клиент применяет строки по номеру журнала, и строка набора норм приходит
 * после своей номенклатуры.
 *
 * Usage:
 *   pnpm -F @matricarmz/backend-api ppe:publish-seed            # dry-run: что уедет
 *   pnpm -F @matricarmz/backend-api ppe:publish-seed -- --apply # запись в журнал
 */
import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';
import { eq } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import {
  erpNomenclature,
  ppeNormLineSpecs,
  ppeNormLines,
  ppeNormSets,
  ppeOccupationRef,
} from '../database/schema.js';
import {
  toPpeNormLineInput,
  toPpeNormLineSpecInput,
  toPpeNormSetInput,
  toPpeOccupationRefInput,
} from '../services/sync/ppeSyncPublisherService.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';

const APPLY = process.argv.includes('--apply');
const BATCH = 200;

const SYSTEM_ACTOR = { id: 'system', username: 'system', role: 'system' } as const;

type Change = {
  tableName: SyncTableName;
  rowId: string;
  op: 'upsert' | 'delete';
  payload: Record<string, unknown>;
};

/** Строка → запись журнала: удалённая строка уезжает тумбстоуном. */
function toChange(tableName: SyncTableName, row: Record<string, unknown>, payload: Record<string, unknown>): Change {
  return {
    tableName,
    rowId: String(row['id']),
    op: row['deletedAt'] == null ? 'upsert' : 'delete',
    payload,
  };
}

async function main() {
  // 1. Номенклатура СИЗ — первой: строки наборов ссылаются на неё.
  const noms = await db.select().from(erpNomenclature).where(eq(erpNomenclature.category, 'workwear'));
  const nomChanges = noms.map((row) =>
    toChange(
      SyncTableName.ErpNomenclature,
      row as Record<string, unknown>,
      SyncTableRegistry.toSyncRow(SyncTableName.ErpNomenclature, row as Record<string, unknown>) as Record<
        string,
        unknown
      >,
    ),
  );

  // 2. Профессии приказа.
  const occupations = await db.select().from(ppeOccupationRef);
  const occupationChanges = occupations.map((row) =>
    toChange(SyncTableName.PpeOccupationRef, row as Record<string, unknown>, toPpeOccupationRefInput(row).row),
  );

  // 3. Приказные строки.
  const specs = await db.select().from(ppeNormLineSpecs);
  const specChanges = specs.map((row) =>
    toChange(SyncTableName.PpeNormLineSpecs, row as Record<string, unknown>, toPpeNormLineSpecInput(row).row),
  );

  // 4. Наборы норм.
  const sets = await db.select().from(ppeNormSets);
  const setChanges = sets.map((row) =>
    toChange(SyncTableName.PpeNormSets, row as Record<string, unknown>, toPpeNormSetInput(row).row),
  );

  // 5. Строки наборов — последними: они ссылаются и на номенклатуру, и на набор.
  const lines = await db.select().from(ppeNormLines);
  const lineChanges = lines.map((row) =>
    toChange(SyncTableName.PpeNormLines, row as Record<string, unknown>, toPpeNormLineInput(row).row),
  );

  const groups: Array<[string, Change[]]> = [
    ['erp_nomenclature (СИЗ)', nomChanges],
    ['ppe_occupation_ref', occupationChanges],
    ['ppe_norm_line_specs', specChanges],
    ['ppe_norm_sets', setChanges],
    ['ppe_norm_lines', lineChanges],
  ];

  for (const [name, changes] of groups) {
    const deleted = changes.filter((c) => c.op === 'delete').length;
    console.log(
      `[ppe-publish] ${name}: ${changes.length} строк` + (deleted ? ` (из них удалённых: ${deleted})` : ''),
    );
  }
  const total = groups.reduce((sum, [, changes]) => sum + changes.length, 0);
  console.log(`[ppe-publish] всего строк к публикации: ${total}`);

  if (!APPLY) {
    console.log('[ppe-publish] РЕЖИМ: dry-run (ничего не записано; добавьте --apply)');
    await pool.end();
    return;
  }

  let applied = 0;
  for (const [name, changes] of groups) {
    for (let i = 0; i < changes.length; i += BATCH) {
      const batch = changes.slice(i, i + BATCH);
      await recordSyncChanges(SYSTEM_ACTOR, batch, { allowSyncConflicts: true });
      applied += batch.length;
    }
    console.log(`[ppe-publish] опубликовано: ${name} — ${changes.length}`);
  }
  console.log(`[ppe-publish] готово: ${applied} строк ушли в журнал синка, парк их подхватит при следующем pull.`);

  await pool.end();
}

main().catch(async (e) => {
  console.error('[ppe-publish] fatal', e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
