import 'dotenv/config';

import { isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';
import { PG_SYNC_TABLES } from '../services/sync/pgSyncTables.js';

/**
 * Дожурналировать строки без `last_server_seq` (одноразово, после починки штампа 17.09.2026).
 *
 * Инкрементальный pull отдаёт клиентам строки по `last_server_seq > since`. Прямые писатели
 * (номенклатура, BOM, дедуп деталей, скрипты) до 17.09.2026 журналировали без штампа, и на
 * проде без номера остались 1607 из 1625 позиций номенклатуры и все строки BOM — реплики
 * клиентов не получали их правок с момента переезда журнала в PG (#788). Скрипт проводит
 * каждую такую строку через журнал (`signAndAppendDetailed` штампует её), и клиенты забирают
 * её ближайшим pull'ом. Данные в PG не меняются — только номер.
 *
 * Использование (из корня репо):
 *   corepack pnpm -F @matricarmz/backend-api sync:restamp                  # dry-run: счёт по таблицам
 *   corepack pnpm -F @matricarmz/backend-api sync:restamp:apply            # проштамповать всё
 *   … sync:restamp -- --tables erp_nomenclature,erp_engine_assembly_bom    # только эти таблицы
 *
 * Таблицы с собственным публикатором (users, user_section_access, warehouse_locations) и
 * audit_log пропускаются: у первых NULL означает «ещё не опубликовано», второй — только для
 * администраторов и объёмный.
 */

const SKIP_TABLES = new Set(['users', 'user_section_access', 'warehouse_locations', 'audit_log']);
const BATCH = 200;

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const tablesArg = argv.find((a) => a.startsWith('--tables='))?.slice('--tables='.length)
  ?? (argv.includes('--tables') ? argv[argv.indexOf('--tables') + 1] : undefined);
const onlyTables = tablesArg ? new Set(tablesArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;

async function main() {
  const now = Date.now();
  let totalRows = 0;
  let totalStamped = 0;
  for (const [table, entry] of Object.entries(PG_SYNC_TABLES)) {
    if (SKIP_TABLES.has(table)) continue;
    if (onlyTables && !onlyTables.has(table)) continue;
    const drizzle = entry.drizzle;
    if (!('lastServerSeq' in drizzle)) continue;
    const rows = (await db.select().from(drizzle).where(isNull(drizzle.lastServerSeq))) as Array<Record<string, unknown>>;
    const deleted = rows.filter((r) => r.deletedAt != null).length;
    console.log(`${table}: без номера ${rows.length} (из них удалённых ${deleted})`);
    totalRows += rows.length;
    if (!apply || rows.length === 0) continue;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const res = await signAndAppendDetailed(
        chunk.map((r) => ({
          type: r.deletedAt != null ? ('delete' as const) : ('upsert' as const),
          table: table as never,
          row: entry.toSyncRow(r),
          row_id: String(r.id),
          actor: { userId: 'system', username: 'system', role: 'system' },
          ts: now,
        })) as never,
      );
      totalStamped += res.applied;
      console.log(`  ${table}: проштамповано ${Math.min(i + BATCH, rows.length)}/${rows.length}, последний номер ${res.lastSeq}`);
    }
  }
  console.log(apply ? `APPLIED: строк проштамповано ${totalStamped} из ${totalRows}` : `DRY-RUN: строк без номера ${totalRows}; запуск с --apply проштампует их`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
