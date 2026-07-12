import 'dotenv/config';

import { and, eq, isNull, isNotNull, like, or, sql } from 'drizzle-orm';
import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { erpNomenclature, directoryParts } from '../database/schema.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';

/**
 * Deep-dedup Ф2 (owner decision 2026-07-12): blank the synthetic placeholder codes.
 *
 *  1. BLANK: alive erp_nomenclature rows whose code matches ^(DET|NM)- get code = ''
 *     («артикула нет» honestly, operator can fill in the real one later). Synced
 *     table → write THROUGH recordSyncChanges so clients pull the change.
 *  2. GHOSTS: alive directory_parts whose mirror is soft-deleted are retired too
 *     (retroactive symmetric delete — deleteWarehouseNomenclature now does this
 *     inline). directory_parts is server-only → plain UPDATE, no ledger.
 *
 * ⚠️ РАСКАТКА: гнать ТОЛЬКО после того, как клиенты обновились до релиза с client
 * migration 0016/step 11 (partial unique на code). На старом клиенте глобальный
 * unique-индекс уронит pull второй же строкой с пустым кодом. Проверка перед
 * запуском: web-admin → клиенты, lastVersion у всех ≥ релиза с 0016.
 *
 * Dry-run by default; pass --apply to mutate. pg_dump erp_nomenclature +
 * directory_parts beforehand. Env по GOTCHAS M30 (сорсить боевой env, иначе
 * паразитный ledger). Идемпотентен: повторный прогон = 0 изменений.
 */
const APPLY = process.argv.includes('--apply');
const actor = { id: 'system', username: 'system', role: 'system' as const };

async function main() {
  const synthetic = await db
    .select({ id: erpNomenclature.id, code: erpNomenclature.code, name: erpNomenclature.name })
    .from(erpNomenclature)
    .where(
      and(
        isNull(erpNomenclature.deletedAt),
        or(like(erpNomenclature.code, 'DET-%'), like(erpNomenclature.code, 'NM-%')),
      ),
    );

  const ghosts = await db
    .select({ id: directoryParts.id, name: directoryParts.name })
    .from(directoryParts)
    .innerJoin(erpNomenclature, eq(erpNomenclature.id, directoryParts.id))
    .where(and(isNull(directoryParts.deletedAt), isNotNull(erpNomenclature.deletedAt)));

  console.log(`[blank-synth] mode=${APPLY ? 'APPLY' : 'dry-run'}`);
  console.log(`[blank-synth] synthetic codes to blank (DET-/NM-): ${synthetic.length}`);
  for (const r of synthetic.slice(0, 10)) console.log(`   ${String(r.code)} — ${String(r.name)}`);
  if (synthetic.length > 10) console.log(`   … и ещё ${synthetic.length - 10}`);
  console.log(`[blank-synth] ghost directory_parts (mirror soft-deleted) to retire: ${ghosts.length}`);
  for (const g of ghosts) console.log(`   ${String(g.id).slice(0, 8)} — ${String(g.name)}`);

  if (!APPLY) {
    console.log('[blank-synth] DRY-RUN (pass --apply to mutate)');
    await pool.end();
    return;
  }

  const ts = Date.now();
  let blanked = 0;
  for (const r of synthetic) {
    const cur = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, r.id)).limit(1);
    if (!cur[0]) continue;
    const dto = SyncTableRegistry.toSyncRow(SyncTableName.ErpNomenclature, cur[0] as Record<string, unknown>);
    dto.code = '';
    dto.updated_at = ts;
    // Синтетика могла продублироваться в spec_json.article — вычистить и там.
    try {
      const spec = cur[0].specJson ? JSON.parse(String(cur[0].specJson)) : null;
      if (spec && typeof spec === 'object' && /^(DET|NM)-/.test(String(spec.article ?? ''))) {
        delete spec.article;
        dto.spec_json = JSON.stringify(spec);
      }
    } catch {
      // malformed spec_json — не трогаем
    }
    await recordSyncChanges(actor, [{ tableName: SyncTableName.ErpNomenclature, rowId: r.id, op: 'upsert', payload: dto }]);
    blanked += 1;
  }

  let retired = 0;
  for (const g of ghosts) {
    await db
      .update(directoryParts)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(and(eq(directoryParts.id, g.id), isNull(directoryParts.deletedAt)));
    retired += 1;
  }

  // Контроль: остаток синтетики после прогона (должен быть 0).
  const left = await db
    .select({ c: sql<number>`count(*)` })
    .from(erpNomenclature)
    .where(
      and(
        isNull(erpNomenclature.deletedAt),
        or(like(erpNomenclature.code, 'DET-%'), like(erpNomenclature.code, 'NM-%')),
      ),
    );
  console.log(`[blank-synth] APPLIED: blanked=${blanked} ghosts-retired=${retired} synthetic-left=${Number(left[0]?.c ?? 0)}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error('[blank-synth] fatal', e);
  await pool.end();
  process.exit(1);
});
